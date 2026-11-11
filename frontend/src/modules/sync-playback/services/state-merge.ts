/**
 * 状态合并服务
 *
 * 提供房主/观众状态构建与比较的纯函数，从 hooks 中抽取以便复用与测试。
 *
 * - `buildStateFromVideo`: 从 video 元素 + store 状态构建完整 WatchTogetherState
 * - `isStateEqual`: 浅比较两个状态是否等价（用于跳过等价广播）
 */
import type { WatchTogetherState } from '../types'

/**
 * Restore a complete wire snapshot without retaining the previous film's fields.
 * JSON/Socket.IO omit undefined properties, including fields cleared in a diff
 * (e.g. Bilibili audioUrl when switching to Kazumi HLS). The accompanying state
 * is authoritative. Materialize missing keys as undefined because roomStore's
 * setter also accepts partial progress updates and therefore shallow-merges.
 */
export function restoreStateSnapshot(
  current: WatchTogetherState,
  snapshot: WatchTogetherState
): WatchTogetherState {
  const cleared = Object.fromEntries(
    Object.keys(current).map((key) => [key, undefined])
  )
  const sameSource =
    current.sourceUrl === snapshot.sourceUrl &&
    current.sourceType === snapshot.sourceType
  return {
    ...cleared,
    ...snapshot,
    duration: snapshot.duration ?? 0,
    // Older hosts omit these policies in buildStateFromVideo. Keep them only
    // for the same source; a different film must never inherit its policies.
    playsvideoEnabled:
      snapshot.playsvideoEnabled ??
      (sameSource ? current.playsvideoEnabled : undefined),
    noProxyFallback:
      snapshot.noProxyFallback ??
      (sameSource ? current.noProxyFallback : undefined),
  }
}

/**
 * 从 video 元素与 store 状态构建完整的 WatchTogetherState。
 *
 * 优先从 video 元素读取实时播放字段（isPlaying/currentTime/playbackRate），
 * 源字段（sourceUrl/audioUrl/format 等）与 duration 从 store 读取以保持稳定。
 *
 * 注意：duration 必须使用 store 中的权威值（后端 resolve 接口返回的真实时长）。
 * 在 MSE seek / 缓冲片段期间，浏览器可能短暂将 video.duration 报告为当前片段
 * 时长（例如 01:15），若用它覆盖 store 会导致控制栏总时长错误并广播给观众。
 *
 * 用于：
 * - 房主 forceSync（手动同步按钮）
 * - 房主响应观众 REQUEST_STATE
 * - 房主 timeupdate 广播
 *
 * @param video video 元素（可能为 null，此时回退到 store 状态）
 * @param storeState roomStore 中的 watchTogether 状态
 */
export function buildStateFromVideo(
  video: HTMLVideoElement | null,
  storeState: WatchTogetherState
): WatchTogetherState {
  const hasLoadedSource = !!video && video.currentSrc !== ''
  return {
    sourceUrl: storeState.sourceUrl,
    sourceType: storeState.sourceType,
    audioUrl: storeState.audioUrl,
    format: storeState.format,
    videoCodec: storeState.videoCodec,
    audioCodec: storeState.audioCodec,
    cid: storeState.cid,
    isPlaying: hasLoadedSource ? !video!.paused : storeState.isPlaying,
    currentTime: hasLoadedSource ? video!.currentTime : storeState.currentTime,
    playbackRate: hasLoadedSource
      ? video!.playbackRate
      : storeState.playbackRate,
    // duration 保持 store 权威值，禁止用 video.duration 覆盖。
    // video.duration 在 MSE 片段缓冲期间不可靠（可能显示为片段时长）。
    duration: storeState.duration,
    currentQn: storeState.currentQn,
    acceptQuality: storeState.acceptQuality,
    headers: storeState.headers,
    isPreview: storeState.isPreview,
    previewTitle: storeState.previewTitle,
    // 透传房主 CLI 标记：观众据此判断是否需要强制走 MP4
    hostCliEnabled: storeState.hostCliEnabled,
    // 透传缓冲模式标记：房主 forceSync / 响应观众 REQUEST_STATE 时必须保留，
    // 否则观众端收到无 bufferMode 的 state 会回退到 URL 播放，破坏缓冲模式一致性
    bufferMode: storeState.bufferMode,
    playsvideoEnabled: storeState.playsvideoEnabled,
    noProxyFallback: storeState.noProxyFallback,
    // 透传直播标记：换源后观众端仍要按直播模式处理（不 seek / 不校正进度）
    isLive: storeState.isLive,
    // 透传直播线路：直链/中转是播放源属性，全房间必须一致
    liveDirect: storeState.liveDirect,
  }
}

/**
 * 增量状态合并：将增量 state 的字段合并到当前完整 state 上。
 *
 * 用于 P1-Opt#7 增量状态广播：房主端只发送变化的字段，
 * 观众端将增量合并到现有完整 state 上，避免全量替换。
 *
 * @param current 当前完整 state
 * @param diff 增量 state（部分字段）
 * @returns 合并后的完整 state（新对象，不修改入参）
 */
export function mergeStateDiff(
  current: WatchTogetherState,
  diff: Partial<WatchTogetherState>
): WatchTogetherState {
  return { ...current, ...diff }
}

/**
 * 计算两个状态之间的差异（仅包含变化的字段）。
 *
 * 用于 P1-Opt#7 增量状态广播：对比 lastState 与 newState，
 * 返回一个 Partial<WatchTogetherState> 只包含变化字段。
 *
 * 注意：acceptQuality 是数组，只在前述 isStateEqual 判断不一致时才纳入 diff。
 * 此处不做深度细化，isStateEqual 已将不等价状态筛选出来。
 *
 * @param prev 前一个状态（可能为 null）
 * @param next 当前状态
 * @returns 增量对象（只包含变化字段）；若无变化返回空对象
 */
export function computeStateDiff(
  prev: WatchTogetherState | null,
  next: WatchTogetherState
): Partial<WatchTogetherState> {
  if (!prev) return next // 首次广播，完整发送

  const diff: Partial<WatchTogetherState> = {}
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<
    keyof WatchTogetherState
  >

  for (const key of keys) {
    if (prev[key] !== next[key]) {
      ;(diff as Record<string, unknown>)[key as string] = next[key]
    }
  }

  return diff
}

/**
 * 浅比较两个 WatchTogetherState 是否等价。
 *
 * 用于房主广播前跳过等价状态，避免正常播放时（currentTime 自然增长）
 * 每 500ms 都触发广播。
 *
 * v3 调优：
 * - currentTime 允许差异 < 2s 视为相同（与 STATE_BROADCAST_TIME_THRESHOLD 对齐）
 *   旧值 0.5s 会导致房主正常播放时每 500ms 都触发广播，观众端频繁卡顿。
 *
 * - currentTime 允许小幅差异（< 2s）视为相同
 * - acceptQuality 是数组，按引用 + 长度 + qn 字段比较
 *
 * @param a 上次广播的状态（null 表示首次，总是不等价）
 * @param b 当前状态
 */
export function isStateEqual(
  a: WatchTogetherState | null,
  b: WatchTogetherState
): boolean {
  if (!a) return false
  if (a === b) return true

  // 源字段
  if (
    a.sourceUrl !== b.sourceUrl ||
    a.sourceType !== b.sourceType ||
    a.audioUrl !== b.audioUrl ||
    a.format !== b.format ||
    a.videoCodec !== b.videoCodec ||
    a.audioCodec !== b.audioCodec ||
    a.cid !== b.cid ||
    a.noProxyFallback !== b.noProxyFallback ||
    (a.isLive === true) !== (b.isLive === true) ||
    (a.liveDirect === true) !== (b.liveDirect === true) ||
    (a.playsvideoEnabled !== false) !== (b.playsvideoEnabled !== false)
  ) {
    return false
  }

  // 播放字段
  if (
    a.isPlaying !== b.isPlaying ||
    a.playbackRate !== b.playbackRate ||
    a.duration !== b.duration
  ) {
    return false
  }

  // currentTime 单独处理：允许差异 < 2s 视为相同（v3：从 0.5s 提升至 2s），
  // 避免房主正常播放时频繁触发广播。进度校正由定时心跳驱动。
  if (Math.abs(a.currentTime - b.currentTime) > 2) return false

  // B站 清晰度字段
  if (a.currentQn !== b.currentQn) return false

  // acceptQuality 浅比较
  const aqA = a.acceptQuality
  const aqB = b.acceptQuality
  if (aqA === aqB) return true
  if (!aqA || !aqB || aqA.length !== aqB.length) return false
  for (let i = 0; i < aqA.length; i++) {
    if (aqA[i].id !== aqB[i].id || aqA[i].label !== aqB[i].label) return false
  }

  // 预览字段
  if (a.isPreview !== b.isPreview || a.previewTitle !== b.previewTitle) {
    return false
  }

  // 缓冲模式标记变化时需要广播（影响观众端是否触发缓存下载）
  if (a.bufferMode !== b.bufferMode) return false

  // 房主 CLI 标记变化时需要广播（影响观众端是否强制走 MP4）
  if (a.hostCliEnabled !== b.hostCliEnabled) return false

  return true
}
