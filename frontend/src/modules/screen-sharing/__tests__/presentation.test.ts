/**
 * 观众端 presentation reducer 单测。
 *
 * 重点是三类「迟到事件」必须被挡住：
 *  1. revision 更小的路由消息；
 *  2. generation 更小的媒体绑定；
 *  3. proofEpoch 过期的首帧证明。
 * 挡不住的表现就是「切源后画面闪一下旧内容」或「黑屏但状态显示已连接」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  INITIAL_VIEWER_PRESENTATION_STATE,
  type ViewerPresentationAction,
  type ViewerPresentationState,
  deriveViewerPresentation,
  hasCurrentFrame,
  reduceViewerPresentation,
} from '../core/presentation.ts'

/** 连续应用一串动作。 */
function run(
  actions: ViewerPresentationAction[],
  start: ViewerPresentationState = INITIAL_VIEWER_PRESENTATION_STATE
): ViewerPresentationState {
  return actions.reduce(reduceViewerPresentation, start)
}

/** 走到「已经出画面」的状态。 */
function playing(): ViewerPresentationState {
  return run([
    { type: 'signal', signal: 'online' },
    { type: 'host', host: 'online' },
    { type: 'route', revision: 1, phase: 'prepare', kind: 'p2p' },
    { type: 'route', revision: 2, phase: 'active', kind: 'p2p' },
    { type: 'media-bound', generation: 1, revision: 2 },
    { type: 'connection', revision: 2, connection: 'connected' },
    { type: 'frame-presented', generation: 1, proofEpoch: 0, revision: 2 },
  ])
}

describe('deriveViewerPresentation', () => {
  it('初始态是 waiting-host + blocking（还不知道房主状态）', () => {
    const presentation = deriveViewerPresentation(
      INITIAL_VIEWER_PRESENTATION_STATE
    )
    assert.equal(presentation.stage, 'waiting-host')
    assert.equal(presentation.overlay, 'blocking')
    assert.equal(presentation.hasCurrentFrame, false)
    assert.equal(presentation.failureCode, null)
  })

  it('房主在线但还没路由时是 allocating', () => {
    const state = run([
      { type: 'signal', signal: 'online' },
      { type: 'host', host: 'online' },
    ])
    assert.equal(deriveViewerPresentation(state).stage, 'allocating')
  })

  it('房主已停止时显示 waiting-host', () => {
    const state = run([{ type: 'host', host: 'stopped' }])
    const presentation = deriveViewerPresentation(state)
    assert.equal(presentation.stage, 'waiting-host')
    assert.equal(presentation.failureCode, 'HOST_STOPPED')
  })

  it('房主暂停优先于其它一切（且保留已出的画面不遮死）', () => {
    const state = run([{ type: 'host', host: 'paused' }], playing())
    const presentation = deriveViewerPresentation(state)
    assert.equal(presentation.stage, 'host-paused')
    assert.equal(presentation.overlay, 'status')
    assert.equal(presentation.hasCurrentFrame, true)
  })

  it('prepare 阶段的 p2p 路由显示 preparing-p2p', () => {
    const state = run([
      { type: 'host', host: 'online' },
      { type: 'route', revision: 1, phase: 'prepare', kind: 'p2p' },
    ])
    assert.equal(deriveViewerPresentation(state).stage, 'preparing-p2p')
  })

  it('relay 路由显示 preparing-relay', () => {
    const state = run([
      { type: 'host', host: 'online' },
      { type: 'route', revision: 1, phase: 'prepare', kind: 'relay' },
    ])
    assert.equal(deriveViewerPresentation(state).stage, 'preparing-relay')
  })

  it('出画面后显示 playing 且 overlay 为 none', () => {
    const presentation = deriveViewerPresentation(playing())
    assert.equal(presentation.stage, 'playing')
    assert.equal(presentation.overlay, 'none')
    assert.equal(presentation.hasCurrentFrame, true)
  })

  it('自动播放被拦时显示 needs-play 而不是失败', () => {
    const state = run(
      [{ type: 'autoplay-blocked', generation: 1, revision: 2 }],
      // 注意：这里故意不给 frame-presented —— 被拦截时根本不会有帧。
      run([
        { type: 'signal', signal: 'online' },
        { type: 'host', host: 'online' },
        { type: 'route', revision: 2, phase: 'active', kind: 'p2p' },
        { type: 'media-bound', generation: 1, revision: 2 },
        { type: 'connection', revision: 2, connection: 'connected' },
      ])
    )
    const presentation = deriveViewerPresentation(state)
    assert.equal(presentation.stage, 'needs-play')
    assert.equal(presentation.failureCode, 'AUTOPLAY_BLOCKED')
    assert.equal(presentation.overlay, 'status')
  })

  it('路由彻底失败时保留最后一帧并显示 route-failed', () => {
    const state = run(
      [{ type: 'route-status', revision: 2, state: 'failed' }],
      playing()
    )
    const presentation = deriveViewerPresentation(state)
    assert.equal(presentation.stage, 'route-failed')
    assert.equal(presentation.failureCode, 'ROUTE_EXHAUSTED')
    assert.equal(presentation.hasRetainedFrame, true)
    // 失败的判定压过「保留帧」，否则画面还在但什么都不提示。
    assert.equal(presentation.overlay, 'status')
  })

  it('路由等待中显示 waiting-relay', () => {
    const state = run([
      { type: 'signal', signal: 'online' },
      { type: 'host', host: 'online' },
      { type: 'route-status', revision: 1, state: 'waiting' },
    ])
    assert.equal(deriveViewerPresentation(state).stage, 'waiting-relay')
  })

  it('房主离线但有画面时仍算 playing，只是带提示', () => {
    const state = run([{ type: 'host', host: 'offline' }], playing())
    const presentation = deriveViewerPresentation(state)
    assert.equal(presentation.stage, 'playing')
    assert.equal(presentation.noticeKey, 'share.viewer.noticeHostOffline')
    assert.equal(presentation.failureCode, 'HOST_OFFLINE')
  })

  it('播放失败单独成态', () => {
    const state = run(
      [{ type: 'playback-failed', generation: 1, revision: 2 }],
      {
        ...playing(),
        media: {
          generation: 1,
          boundAtRevision: 2,
          proofEpoch: 0,
          framePresented: false,
        },
        connection: 'connected',
      }
    )
    const presentation = deriveViewerPresentation(state)
    assert.equal(presentation.stage, 'playback-failed')
    assert.equal(presentation.failureCode, 'PLAYBACK_FAILED')
  })
})

describe('reduceViewerPresentation 的迟到事件过滤', () => {
  it('revision 更小的 route 被忽略（返回同一引用）', () => {
    const state = run([
      { type: 'route', revision: 5, phase: 'active', kind: 'p2p' },
    ])
    const next = reduceViewerPresentation(state, {
      type: 'route',
      revision: 4,
      phase: 'prepare',
      kind: 'p2p',
    })
    assert.equal(next, state)
  })

  it('authoritative 的 route 可以倒退 revision（来自快照）', () => {
    const state = run([
      { type: 'route', revision: 5, phase: 'active', kind: 'p2p' },
    ])
    const next = reduceViewerPresentation(state, {
      type: 'route',
      revision: 1,
      phase: 'prepare',
      kind: 'relay',
      authoritative: true,
    })
    assert.equal(next.revision, 1)
    assert.equal(next.route?.kind, 'relay')
  })

  it('generation 更小的 media-bound 被忽略', () => {
    const state = run([{ type: 'media-bound', generation: 3, revision: 1 }])
    const next = reduceViewerPresentation(state, {
      type: 'media-bound',
      generation: 2,
      revision: 1,
    })
    assert.equal(next, state)
  })

  it('proofEpoch 过期的首帧证明被忽略', () => {
    const state = run([
      { type: 'media-bound', generation: 1, revision: 1 },
      { type: 'frame-proof-reset', generation: 1, revision: 1 },
    ])
    const next = reduceViewerPresentation(state, {
      type: 'frame-presented',
      generation: 1,
      proofEpoch: 0,
      revision: 1,
    })
    assert.equal(next.media?.framePresented, false)
  })

  it('frame-proof-reset 把已出的帧转成保留帧', () => {
    const next = reduceViewerPresentation(playing(), {
      type: 'frame-proof-reset',
      generation: 1,
      revision: 2,
    })
    assert.equal(next.media?.framePresented, false)
    assert.equal(next.retainedFrame, true)
    assert.equal(hasCurrentFrame(next), false)
  })

  it('media-bound 清掉保留帧与自动播放标记', () => {
    const next = reduceViewerPresentation(playing(), {
      type: 'media-bound',
      generation: 2,
      revision: 3,
    })
    assert.equal(next.retainedFrame, false)
    assert.equal(next.autoplayBlockedGeneration, null)
    assert.equal(next.media?.generation, 2)
    assert.equal(next.media?.proofEpoch, 0)
  })

  it('sharing-stopped 把一切清回初始（除了 signal）', () => {
    const next = reduceViewerPresentation(playing(), {
      type: 'sharing-stopped',
    })
    assert.equal(next.host, 'stopped')
    assert.equal(next.revision, null)
    assert.equal(next.route, null)
    assert.equal(next.media, null)
    assert.equal(next.connection, 'idle')
    assert.equal(next.retainedFrame, false)
    assert.equal(next.signal, 'online')
  })

  it('host 的 offline → stopped 覆盖被拒（已停止的房间不会重新离线）', () => {
    const stopped = run([{ type: 'host', host: 'stopped' }])
    const next = reduceViewerPresentation(stopped, {
      type: 'host',
      host: 'offline',
    })
    assert.equal(next, stopped)
  })

  it('同状态动作返回同一引用（少一次渲染）', () => {
    const state = run([{ type: 'host', host: 'online' }])
    assert.equal(
      reduceViewerPresentation(state, { type: 'host', host: 'online' }),
      state
    )
  })
})
