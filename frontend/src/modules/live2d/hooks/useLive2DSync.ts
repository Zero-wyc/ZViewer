import { useEffect, useRef } from 'react'
import type { Socket } from 'socket.io-client'
import { LIVE2D_EVENT } from '../constants'
import {
  LIVE2D_DEFAULT_POLICY,
  rowToPeer,
  type Live2DActionPayload,
  type Live2DConfigAck,
  type Live2DModelRemovedPayload,
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
  setRemoteDrag,
  setRemotePointer,
  setVoiceMouth,
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
  /**
   * 公共库模型被删掉了（房间里有人的角色因此消失）。
   *
   * 由宿主处理「换回默认模型 + 说明原因」：钩子这边拿不到内置模型清单，
   * 也不该知道 UI 该提示什么。
   */
  onModelRemoved?: (modelId: string) => void
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
  onModelRemoved,
}: UseLive2DSyncOptions): void {
  // 回调用 ref 转一手：它每次渲染都可能换身份（依赖我的模型选择），直接进
  // 依赖表会让整条订阅在每次换模型时重建——那会连带重发 live2d-request，
  // 快照回来又要 clearScene，画面上就是一次无谓的重载。
  const removedSinkRef = useRef(onModelRemoved)
  useEffect(() => {
    removedSinkRef.current = onModelRemoved
  }, [onModelRemoved])

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
          renderer.sync(entry.peer.sid, resolveModelUrl(entry.peer))
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
          // 行长区分三种状态（见 live2dStateRow）：4 = 只有视线；
          // 5 = 语音口型（只有嘴）；10 = 整脸动捕。
          if (mouth !== undefined && eyes === undefined) {
            // 只写嘴：语音没有睁眼/表情的对应物，动到那些参数就等于宣称
            // 对方的眼和眉毛也归我们管，模型会整段说话都不眨眼。
            setVoiceMouth(sid, Number(mouth))
          } else if (mouth !== undefined && eyes !== undefined) {
            // 表情细节/歪头是可选的：老服务端只发 m/e，这时按「中性」处理
            // 而不是保持上一帧——否则对方一说笑，旧端会永远停在笑脸上。
            setFace(sid, Number(mouth), Number(eyes), {
              form: row[6] === undefined ? 0.5 : Number(row[6]),
              brow: row[7] === undefined ? 0.5 : Number(row[7]),
              roll: row[8] === undefined ? 0.5 : Number(row[8]),
            })
          }
        }
      }

      if (payload.d?.length) {
        // 拖拽偏移同理：只写场景，不进 React（拖动时这里 10Hz）
        for (const row of payload.d) {
          const sid = String(row[0] ?? '')
          if (!sid) continue
          setRemoteDrag(sid, Number(row[1]), Number(row[2]))
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

    // 模型被删：名册已经由同一批 rem 行清干净了，这里只把「选择失效」这件事
    // 交回给宿主（它知道内置模型清单，也知道该说什么）。
    const onModelRemoved = (payload: Live2DModelRemovedPayload) => {
      if (!payload || payload.roomId !== roomId || !payload.modelId) return
      removedSinkRef.current?.(payload.modelId)
    }

    socket.on(LIVE2D_EVENT.SNAPSHOT, onSnapshot)
    socket.on(LIVE2D_EVENT.PATCH, onPatch)
    socket.on(LIVE2D_EVENT.ACTION, onAction)
    socket.on(LIVE2D_EVENT.POLICY, onPolicy)
    socket.on(LIVE2D_EVENT.MODEL_REMOVED, onModelRemoved)

    // 挂载即拉：join 时服务端的推送往往早于 effect 挂载，已经丢了
    socket.emit(LIVE2D_EVENT.REQUEST, { roomId })

    return () => {
      socket.off(LIVE2D_EVENT.SNAPSHOT, onSnapshot)
      socket.off(LIVE2D_EVENT.PATCH, onPatch)
      socket.off(LIVE2D_EVENT.ACTION, onAction)
      socket.off(LIVE2D_EVENT.POLICY, onPolicy)
      socket.off(LIVE2D_EVENT.MODEL_REMOVED, onModelRemoved)
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
 * 广播本人的拖拽偏移（相对槽位基准的视口比例，正数向右/向下）。
 *
 * 本地已经先写进场景了（否则拖起来会跟手慢半拍），这里只负责让别人也
 * 看到同一个位置。服务端按 40ms 门限丢超频，再合并进 100ms 一次的 patch。
 */
export function emitLive2DDrag(
  socket: Socket | null,
  roomId: string,
  x: number,
  y: number
): void {
  if (!socket || !roomId) return
  socket.emit(LIVE2D_EVENT.DRAG, {
    roomId,
    // 偏移可以是负数，roundCoord 会把值夹到 0~1，这里自己压精度
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
  })
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
