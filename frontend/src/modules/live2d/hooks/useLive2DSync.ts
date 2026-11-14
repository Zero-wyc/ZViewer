import { useEffect } from 'react'
import type { Socket } from 'socket.io-client'
import { LIVE2D_EVENT } from '../constants'
import {
  LIVE2D_DEFAULT_POLICY,
  rowToPeer,
  type Live2DActionPayload,
  type Live2DConfigAck,
  type Live2DPatchPayload,
  type Live2DPolicy,
  type Live2DPolicyPayload,
  type Live2DSnapshotPayload,
} from '../types'
import {
  clearScene,
  listEntries,
  removePeer,
  setFace,
  setRemotePointer,
  upsertPeer,
} from '../core/scene'
import { resolveModelUrl } from '../core/model-url'
import { useLive2DStore } from '../store/live2dStore'
import type { Live2DRenderer } from '../core/live2d-renderer'

// 房间通道：接收快照/增量 → 写场景 + 通知渲染器；同时维护低频名册。
//
// 这里刻意**不把坐标写进 React**：进来的是 10Hz 的指针增量，写 state 会让
// 整个房间页每秒重渲染十次。名册只在「有人加入/离开/换模型」时才更新。

export interface UseLive2DSyncOptions {
  socket: Socket | null
  roomId: string
  renderer: Live2DRenderer | null
}

function aspectRatio(): number {
  const w = window.innerWidth || 1
  const h = window.innerHeight || 1
  return w / h
}

export function useLive2DSync({
  socket,
  roomId,
  renderer,
}: UseLive2DSyncOptions): void {
  // 渲染器晚于 hook 就绪（引擎异步加载），所以它进依赖表：就绪时会重订阅一次
  // 并重新拉快照，代价可忽略，换来的是不在 render 期写 ref。
  useEffect(() => {
    if (!socket || !roomId) return
    const setPeers = useLive2DStore.getState().setPeers
    const setPolicy = useLive2DStore.getState().setPolicy

    // 名册变化后同步一次渲染器：新增的加载、消失的移除、名册写回 store（低频）
    const syncRenderer = () => {
      const entries = listEntries()
      const alive = new Set(entries.map((e) => e.peer.sid))
      if (renderer) {
        for (const entry of entries) {
          renderer.sync(entry.peer.sid, resolveModelUrl(entry.peer, roomId))
        }
        renderer.prune(alive)
      }
      setPeers(entries.map((e) => e.peer))
    }

    const applyPolicy = (raw?: Partial<Live2DPolicy>) => {
      if (!raw) return
      // 服务端只会发合法的零值/布尔；这里补默认值，缺字段按「不限制」处理，
      // 免得某个字段没下发就把所有人的角色藏了。
      setPolicy({
        ...LIVE2D_DEFAULT_POLICY,
        ...raw,
        unified: raw.unified === true,
        unifiedId: raw.unifiedId || undefined,
        unifiedKind: raw.unifiedKind || undefined,
      })
    }

    const onSnapshot = (payload: Live2DSnapshotPayload) => {
      if (!payload || payload.roomId !== roomId) return
      clearScene()
      for (const row of payload.models ?? []) {
        const peer = rowToPeer(row)
        if (peer.sid) upsertPeer(peer)
      }
      applyPolicy(payload.policy)
      syncRenderer()
    }

    const onPolicy = (payload: Live2DPolicyPayload) => {
      if (!payload || payload.roomId !== roomId) return
      applyPolicy(payload.policy)
    }

    const onPatch = (payload: Live2DPatchPayload) => {
      if (!payload || payload.roomId !== roomId) return
      let membershipChanged = false

      if (payload.r?.length) {
        for (const sid of payload.r) {
          removePeer(sid)
          membershipChanged = true
        }
      }
      if (payload.add?.length) {
        for (const row of payload.add) {
          const peer = rowToPeer(row)
          if (peer.sid) upsertPeer(peer)
        }
        membershipChanged = true
      }
      if (payload.u?.length) {
        // 指针/面部增量走模块级场景，不经 React
        const ar = aspectRatio()
        for (const row of payload.u) {
          const sid = String(row[0] ?? '')
          if (!sid) continue
          setRemotePointer(
            sid,
            Number(row[1]),
            Number(row[2]),
            Number(row[3]),
            ar
          )
          const mouth = row[4]
          const eyes = row[5]
          // 没有面部字段 = 对方当前不在动捕，别去动他的嘴和眼
          if (mouth !== undefined && eyes !== undefined) {
            setFace(sid, Number(mouth), Number(eyes))
          }
        }
      }

      if (membershipChanged) syncRenderer()
    }

    // 表情与动作都是瞬时事件：不进名册、不进场景，直接交给渲染器播。
    const onAction = (payload: Live2DActionPayload) => {
      if (!payload || payload.roomId !== roomId) return
      if (!payload.sid) return
      if (payload.g) {
        renderer?.playMotion(payload.sid, payload.g, Number(payload.i))
        return
      }
      renderer?.playExpression(payload.sid, Number(payload.e))
    }

    socket.on(LIVE2D_EVENT.SNAPSHOT, onSnapshot)
    socket.on(LIVE2D_EVENT.PATCH, onPatch)
    socket.on(LIVE2D_EVENT.ACTION, onAction)
    socket.on(LIVE2D_EVENT.POLICY, onPolicy)

    // 挂载即拉：join 时服务端的推送往往早于 effect 挂载，已经丢了
    socket.emit(LIVE2D_EVENT.REQUEST, { roomId })

    return () => {
      socket.off(LIVE2D_EVENT.SNAPSHOT, onSnapshot)
      socket.off(LIVE2D_EVENT.PATCH, onPatch)
      socket.off(LIVE2D_EVENT.ACTION, onAction)
      socket.off(LIVE2D_EVENT.POLICY, onPolicy)
    }
  }, [socket, roomId, renderer])

  // 换房/卸载时清空：场景是模块级的，不清会串房；策略也一样，
  // 否则进下一个房间会先按上一个房间的规矩渲染一帧。
  useEffect(() => {
    return () => {
      clearScene()
      const store = useLive2DStore.getState()
      store.setPeers([])
      store.setPolicy(LIVE2D_DEFAULT_POLICY)
    }
  }, [roomId])
}

/** 声明/清空自己的模型；ack 里带回服务端应用后的全量名册。 */
export function emitLive2DConfig(
  socket: Socket | null,
  roomId: string,
  payload: {
    action: 'set' | 'clear'
    kind?: string
    modelId?: string
    scale?: number
  },
  onDone?: (ack: Live2DConfigAck | null) => void
): void {
  if (!socket || !roomId) return
  socket.emit(
    LIVE2D_EVENT.CONFIG,
    { roomId, ...payload },
    (ack: Live2DConfigAck) => {
      onDone?.(ack ?? null)
    }
  )
}

/** 触发表情：服务端会广播给整个房间（含自己），所以本地不做乐观应用。 */
export function emitLive2DAction(
  socket: Socket | null,
  roomId: string,
  index: number
): void {
  if (!socket || !roomId) return
  if (!Number.isInteger(index) || index < 0) return
  socket.emit(LIVE2D_EVENT.ACTION, { roomId, e: index })
}

/**
 * 广播本人的动作（motion）。
 *
 * 和表情一样不做本地乐观应用——本人的模型本来就已经在播这个动作了，
 * 服务端的回声会被渲染器按 `lastMotion` 丢掉。
 */
export function emitLive2DMotion(
  socket: Socket | null,
  roomId: string,
  group: string,
  index: number
): void {
  if (!socket || !roomId || !group) return
  if (!Number.isInteger(index) || index < 0) return
  socket.emit(LIVE2D_EVENT.ACTION, { roomId, g: group, i: index })
}

/**
 * 房主修改房间级策略：只发要改的字段（服务端按增量合并并广播给全房间）。
 *
 * 不走本地乐观更新：策略影响的是所有人，等回执/广播再落地才不会出现
 * 「开关先跳一下又弹回来」。
 */
export function emitLive2DPolicy(
  socket: Socket | null,
  roomId: string,
  patch: Partial<Omit<Live2DPolicy, 'unifiedKind' | 'unifiedId'>> & {
    unifiedKind?: string
    unifiedId?: string
  },
  onDone?: (ok: boolean, message?: string) => void
): void {
  if (!socket || !roomId) return
  socket.emit(
    LIVE2D_EVENT.POLICY_SET,
    { roomId, ...patch },
    (ack?: { success?: boolean; message?: string }) => {
      onDone?.(ack?.success === true, ack?.message)
    }
  )
}
