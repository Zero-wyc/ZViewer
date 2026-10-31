/**
 * 观众端视觉状态的纯投影。
 *
 * 机制照搬 Piik（MIT）的 `src/client/media/viewer-presentation.ts`：
 * 视觉状态不是散落在若干 hook 里的 `useState`，而是**一个 reducer + 一个纯函数**
 * 从「事实字段」算出来。好处是「连上了但黑屏」这类组合能被穷举覆盖，
 * 也不会出现「两个 state 互相矛盾」的画面。
 *
 * 与 Piik 的差异：Piik 有 23 个 `ViewerStage`，其中一半是房间准入失败
 * （room-not-found / access-denied / invalid-invite …）。ZViewer 的准入由
 * `useJoinRoom` 独立处理，这里只保留媒体链路上的 15 个。
 *
 * `messageKey` 是**语义键**不是文案：真正的 `t()` 映射在 P2 接 UI 时建立，
 * 这样 P0 不引入任何新界面文案（i18n 词典不用动）。
 */

/** 信令连接状态。与 `useSocket` 的 connected 布尔 + 重连尝试次数对应。 */
export type SignalState = 'connecting' | 'online' | 'reconnecting' | 'offline'

/** 房主侧状态。 */
export type ViewerHostState =
  'unknown' | 'online' | 'paused' | 'offline' | 'stopped'

/** 当前路由的传输方式。relay 对应服务器中继（P3）。 */
export type ViewerRouteKind = 'none' | 'p2p' | 'relay'

/** 失败原因。 */
export type ViewerFailureCode =
  | 'ROUTE_EXHAUSTED'
  | 'AUTOPLAY_BLOCKED'
  | 'VIDEO_REJECTED'
  | 'PLAYBACK_FAILED'
  | 'HOST_OFFLINE'
  | 'HOST_STOPPED'
  | 'SERVER_ERROR'

/** 语义文案键。 */
export type ViewerMessageKey = `share.viewer.${string}`

/** 观众端阶段。 */
export type ViewerStage =
  | 'allocating'
  | 'waiting-host'
  | 'host-paused'
  | 'host-offline'
  | 'preparing-p2p'
  | 'preparing-relay'
  | 'waiting-relay'
  | 'receiving'
  | 'playing'
  | 'needs-play'
  | 'recovering'
  | 'route-failed'
  | 'video-rejected'
  | 'playback-failed'
  | 'server-error'

/** 已提交或准备中的路由。 */
export interface ViewerRouteFact {
  revision: number
  phase: 'prepare' | 'active'
  kind: ViewerRouteKind
}

/** 服务端下发的一次状态（waiting / failed）。 */
export interface ViewerRouteStatusFact {
  revision: number
  state: 'waiting' | 'failed'
}

/**
 * 一次媒体绑定。
 *
 * `generation` 每换一条连接就 +1，`proofEpoch` 每作废一次首帧证明就 +1。
 * 两个计数器合起来保证「迟到的事件」不会污染新一代的连接——
 * 这正是 Piik 用它们替代 connId 栅栏的地方。
 */
export interface ViewerMediaFact {
  generation: number
  boundAtRevision: number
  proofEpoch: number
  framePresented: boolean
}

/** 投影所需的全部事实字段。 */
export interface ViewerPresentationState {
  signal: SignalState
  host: ViewerHostState
  revision: number | null
  route: ViewerRouteFact | null
  routeStatus: ViewerRouteStatusFact | null
  connection: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  media: ViewerMediaFact | null
  /** 画面消失后是否还保留最后一帧（暂停/失败时不清屏）。 */
  retainedFrame: boolean
  autoplayBlockedGeneration: number | null
  playbackFailedGeneration: number | null
  runtimeFailure: 'SERVER_ERROR' | null
  receiveFailure: 'VIDEO_REJECTED' | null
}

/** 状态变更动作。 */
export type ViewerPresentationAction =
  | { type: 'signal'; signal: SignalState }
  | { type: 'host'; host: ViewerHostState }
  | {
      type: 'receive-failure'
      revision: number
      failure: 'VIDEO_REJECTED' | null
    }
  | {
      type: 'route'
      revision: number
      phase: 'prepare' | 'active'
      kind: ViewerRouteKind
      /** authoritative 来自快照，可以越过 revision 栅栏。 */
      authoritative?: boolean
    }
  | { type: 'route-status'; revision: number; state: 'waiting' | 'failed' }
  | {
      type: 'connection'
      revision: number
      connection: ViewerPresentationState['connection']
    }
  | { type: 'media-bound'; generation: number; revision: number }
  | {
      type: 'frame-presented'
      generation: number
      proofEpoch: number
      revision: number
    }
  | { type: 'frame-proof-reset'; generation: number; revision: number }
  | { type: 'frame-proof-rearm'; generation: number }
  | { type: 'autoplay-blocked'; generation: number; revision: number }
  | { type: 'autoplay-cleared'; generation: number }
  | { type: 'playback-failed'; generation: number; revision: number }
  | { type: 'media-cleared' }
  | { type: 'sharing-stopped' }
  | { type: 'server-error' }

/** 投影结果：UI 只读这一个对象。 */
export interface ViewerPresentation {
  stage: ViewerStage
  messageKey: ViewerMessageKey
  noticeKey: ViewerMessageKey | null
  overlay: 'none' | 'status' | 'blocking'
  hasCurrentFrame: boolean
  hasRetainedFrame: boolean
  failureCode: ViewerFailureCode | null
}

/** 初始状态：还没连上、什么都不知道。 */
export const INITIAL_VIEWER_PRESENTATION_STATE: ViewerPresentationState = {
  signal: 'connecting',
  host: 'unknown',
  revision: null,
  route: null,
  routeStatus: null,
  connection: 'idle',
  media: null,
  retainedFrame: false,
  autoplayBlockedGeneration: null,
  playbackFailedGeneration: null,
  runtimeFailure: null,
  receiveFailure: null,
}

/**
 * 纯 reducer。
 *
 * 所有「迟到事件」的过滤都写在最前面：revision 更小、generation 不匹配、
 * proofEpoch 不匹配的动作直接原样返回 state（同一个引用，React 不会重渲染）。
 */
export function reduceViewerPresentation(
  state: ViewerPresentationState,
  action: ViewerPresentationAction
): ViewerPresentationState {
  switch (action.type) {
    case 'signal':
      if (state.signal === action.signal) return state
      return { ...state, signal: action.signal }

    case 'host': {
      // 已停止的房间不会「重新上线」：host-offline 之后再来 online 说明是陈旧事件。
      if (action.host === 'offline' && state.host === 'stopped') return state
      if (state.host === action.host) return state
      return { ...state, host: action.host }
    }

    case 'receive-failure':
      if (state.revision !== null && action.revision < state.revision)
        return state
      if (state.receiveFailure === action.failure) return state
      return { ...state, receiveFailure: action.failure }

    case 'route': {
      if (
        !action.authoritative &&
        state.revision !== null &&
        action.revision < state.revision
      ) {
        return state
      }
      const revisionChanged = state.revision !== action.revision
      const committedRoute = action.phase === 'active' && action.kind !== 'none'
      // 已经判失败的路由又收到 active：说明服务端重新提交过，要重新走恢复态。
      const reactivatingTerminalRoute =
        committedRoute && state.routeStatus?.state === 'failed'
      return {
        ...state,
        revision: action.revision,
        receiveFailure: action.authoritative ? null : state.receiveFailure,
        route: {
          revision: action.revision,
          phase: action.phase,
          kind: action.kind,
        },
        routeStatus: action.authoritative
          ? null
          : !committedRoute && state.routeStatus?.revision === action.revision
            ? state.routeStatus
            : null,
        connection:
          action.authoritative && state.media === null
            ? action.kind === 'none'
              ? 'idle'
              : 'connecting'
            : reactivatingTerminalRoute
              ? state.media
                ? 'reconnecting'
                : 'connecting'
              : revisionChanged && state.media === null
                ? action.kind === 'none'
                  ? 'idle'
                  : 'connecting'
                : state.connection,
      }
    }

    case 'route-status': {
      if (state.revision !== null && action.revision < state.revision) {
        return state
      }
      const revisionChanged = state.revision !== action.revision
      const terminal = action.state === 'failed'
      const currentFrame = hasCurrentFrame(state)
      const currentMedia =
        terminal && state.media
          ? {
              ...state.media,
              proofEpoch: state.media.proofEpoch + 1,
              framePresented: false,
            }
          : state.media
      return {
        ...state,
        revision: action.revision,
        routeStatus: { revision: action.revision, state: action.state },
        connection: terminal
          ? 'failed'
          : state.media
            ? state.connection
            : 'connecting',
        media: currentMedia,
        autoplayBlockedGeneration:
          revisionChanged || terminal ? null : state.autoplayBlockedGeneration,
        // 失败时把最后一帧留在画面上，比直接清成黑屏有用得多。
        retainedFrame: state.retainedFrame || (terminal && currentFrame),
      }
    }

    case 'connection':
      if (state.revision !== null && action.revision < state.revision)
        return state
      if (state.connection === action.connection) return state
      return {
        ...state,
        revision: Math.max(state.revision ?? 0, action.revision),
        connection: action.connection,
      }

    case 'media-bound': {
      // 迟到的「上一代媒体绑定」不能覆盖当前代。
      if (state.media && action.generation <= state.media.generation)
        return state
      return {
        ...state,
        media: {
          generation: action.generation,
          boundAtRevision: action.revision,
          proofEpoch: 0,
          framePresented: false,
        },
        retainedFrame: false,
        autoplayBlockedGeneration: null,
        playbackFailedGeneration: null,
      }
    }

    case 'frame-presented':
      if (
        !state.media ||
        state.media.generation !== action.generation ||
        state.media.proofEpoch !== action.proofEpoch
      ) {
        return state
      }
      if (state.media.framePresented && state.connection === 'connected')
        return state
      return {
        ...state,
        connection: 'connected',
        media: { ...state.media, framePresented: true },
        retainedFrame: false,
        routeStatus: null,
        playbackFailedGeneration: null,
        receiveFailure: null,
      }

    case 'frame-proof-reset':
      if (!state.media || state.media.generation !== action.generation)
        return state
      return {
        ...state,
        media: {
          ...state.media,
          proofEpoch: state.media.proofEpoch + 1,
          framePresented: false,
        },
        retainedFrame: state.retainedFrame || state.media.framePresented,
      }

    case 'frame-proof-rearm':
      if (!state.media || state.media.generation !== action.generation)
        return state
      return {
        ...state,
        media: { ...state.media, proofEpoch: state.media.proofEpoch + 1 },
      }

    case 'autoplay-blocked':
      if (!state.media || state.media.generation !== action.generation)
        return state
      return { ...state, autoplayBlockedGeneration: action.generation }

    case 'autoplay-cleared':
      if (state.autoplayBlockedGeneration !== action.generation) return state
      return { ...state, autoplayBlockedGeneration: null }

    case 'playback-failed':
      if (!state.media || state.media.generation !== action.generation)
        return state
      return { ...state, playbackFailedGeneration: action.generation }

    case 'media-cleared':
      return {
        ...state,
        media: null,
        retainedFrame: false,
        autoplayBlockedGeneration: null,
        playbackFailedGeneration: null,
      }

    case 'sharing-stopped':
      return {
        ...state,
        host: 'stopped',
        revision: null,
        route: null,
        routeStatus: null,
        connection: 'idle',
        media: null,
        retainedFrame: false,
        autoplayBlockedGeneration: null,
        playbackFailedGeneration: null,
        runtimeFailure: null,
        receiveFailure: null,
      }

    case 'server-error':
      return { ...state, runtimeFailure: 'SERVER_ERROR' }
  }
}

/**
 * 把事实字段投影成「画什么」。
 *
 * 判断顺序就是优先级，改动顺序等于改动产品行为：
 * 暂停 > 自动播放被拦 > 有画面 > 路由失败 > 播放失败 > 服务端错误 >
 * 房主状态 > 路由等待 > 恢复中 > 接收中 > 准备中 > 分配中。
 */
export function deriveViewerPresentation(
  state: ViewerPresentationState
): ViewerPresentation {
  const currentFrame = hasCurrentFrame(state)
  const frameOverlay: ViewerPresentation['overlay'] = state.retainedFrame
    ? 'status'
    : 'blocking'

  if (state.host === 'paused') {
    return presentation(
      'host-paused',
      'share.viewer.hostPaused',
      currentFrame || state.retainedFrame ? 'status' : 'blocking',
      state
    )
  }

  if (
    state.media &&
    state.autoplayBlockedGeneration === state.media.generation &&
    state.connection === 'connected'
  ) {
    return presentation(
      'needs-play',
      'share.viewer.needsPlay',
      'status',
      state,
      'AUTOPLAY_BLOCKED'
    )
  }

  if (currentFrame) {
    const signalRecovering =
      state.signal === 'reconnecting' || state.signal === 'connecting'
    const mediaRecovering =
      state.connection === 'reconnecting' || state.connection === 'failed'
    return {
      ...presentation(
        mediaRecovering ? 'recovering' : 'playing',
        mediaRecovering ? 'share.viewer.recovering' : 'share.viewer.playing',
        'none',
        state
      ),
      noticeKey:
        state.host === 'offline'
          ? 'share.viewer.noticeHostOffline'
          : signalRecovering
            ? 'share.viewer.noticeSignalRecovering'
            : null,
      failureCode: state.host === 'offline' ? 'HOST_OFFLINE' : null,
    }
  }

  // 只有房主还能发流时，「路由失败」才解释得了没有画面。
  // 房主自己重连不会修好这条路由，所以保留这个事实。
  if (state.host === 'online' && state.routeStatus?.state === 'failed') {
    if (state.receiveFailure === 'VIDEO_REJECTED') {
      return presentation(
        'video-rejected',
        'share.viewer.videoRejected',
        frameOverlay,
        state,
        'VIDEO_REJECTED'
      )
    }
    return presentation(
      'route-failed',
      'share.viewer.routeFailed',
      frameOverlay,
      state,
      'ROUTE_EXHAUSTED'
    )
  }

  if (
    state.media &&
    state.playbackFailedGeneration === state.media.generation
  ) {
    return presentation(
      'playback-failed',
      'share.viewer.playbackFailed',
      frameOverlay,
      state,
      'PLAYBACK_FAILED'
    )
  }

  if (state.runtimeFailure === 'SERVER_ERROR') {
    return presentation(
      'server-error',
      'share.viewer.serverError',
      frameOverlay,
      state,
      'SERVER_ERROR'
    )
  }

  if (state.host === 'stopped' || state.host === 'unknown') {
    return presentation(
      'waiting-host',
      'share.viewer.waitingHost',
      frameOverlay,
      state,
      state.host === 'stopped' ? 'HOST_STOPPED' : null
    )
  }
  if (state.host === 'offline') {
    return presentation(
      'host-offline',
      'share.viewer.hostOffline',
      frameOverlay,
      state,
      'HOST_OFFLINE'
    )
  }

  if (state.routeStatus?.state === 'waiting') {
    return presentation(
      'waiting-relay',
      'share.viewer.waitingRelay',
      frameOverlay,
      state
    )
  }
  if (
    state.signal === 'reconnecting' ||
    state.connection === 'reconnecting' ||
    state.connection === 'failed'
  ) {
    return presentation(
      'recovering',
      'share.viewer.recovering',
      frameOverlay,
      state
    )
  }
  if (state.media) {
    return presentation(
      'receiving',
      'share.viewer.receiving',
      frameOverlay,
      state
    )
  }
  if (state.route?.kind === 'relay') {
    return presentation(
      'preparing-relay',
      'share.viewer.preparingRelay',
      frameOverlay,
      state
    )
  }
  if (state.route?.kind === 'p2p') {
    return presentation(
      'preparing-p2p',
      'share.viewer.preparingP2p',
      frameOverlay,
      state
    )
  }
  return presentation(
    'allocating',
    'share.viewer.allocating',
    frameOverlay,
    state
  )
}

/** 当前是否已解出画面（Piik 的成功判据：framesDecoded 前进，不是 iceConnected）。 */
export function hasCurrentFrame(state: ViewerPresentationState): boolean {
  return state.media?.framePresented === true
}

function presentation(
  stage: ViewerStage,
  messageKey: ViewerMessageKey,
  overlay: ViewerPresentation['overlay'],
  state: ViewerPresentationState,
  failureCode: ViewerFailureCode | null = null
): ViewerPresentation {
  return {
    stage,
    messageKey,
    noticeKey: null,
    overlay,
    hasCurrentFrame: hasCurrentFrame(state),
    hasRetainedFrame: state.retainedFrame,
    failureCode,
  }
}
