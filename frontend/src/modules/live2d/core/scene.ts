import type { Live2DPeer } from '../types'
import { mapPointerToAspect } from './pointer-map'

// 场景状态：**高频数据唯一的家**。
//
// 为什么不用 React state：指针 15Hz 上报、60fps 平滑，把坐标塞进 zustand
// 会让整个房间页跟着重渲染。这里用模块级 Map，渲染器每帧直接读；
// React 只订阅「成员名册」（谁在场、选的什么模型）这种低频变化。

export interface SceneEntry {
  peer: Live2DPeer
  /** 平滑后的当前注视目标（归一化，本端视口） */
  currentX: number
  currentY: number
  /** 目标值（远端最新上报或本机指针） */
  targetX: number
  targetY: number
  /** 最近一次指针变化的时间戳（判定活跃/降级用） */
  lastActiveAt: number

  // ---- 面部（动捕）----
  // 和视线一样分「目标 / 当前」：网络上是 15Hz 的台阶，渲染要 60fps 的连续量。
  currentMouth: number
  currentEyes: number
  targetMouth: number
  targetEyes: number
  /**
   * 最近一次收到面部数据的时刻。
   *
   * 0 表示「这个成员没在动捕」。渲染器只在数据新鲜（FACE_TTL 内）时接管
   * 嘴/眼参数，超时就还给引擎自己眨——否则对方关掉动捕后模型会一直保持
   * 最后一帧的张嘴表情。
   */
  faceAt: number
}

const entries = new Map<string, SceneEntry>()

export function getEntry(sid: string): SceneEntry | undefined {
  return entries.get(sid)
}

export function listEntries(): SceneEntry[] {
  return [...entries.values()].sort((a, b) => a.peer.ord - b.peer.ord)
}

export function size(): number {
  return entries.size
}

/** 新增或更新一个成员的模型声明（保留已有的平滑状态，避免换模型时视线跳一下）。 */
export function upsertPeer(peer: Live2DPeer, now = Date.now()): SceneEntry {
  const existing = entries.get(peer.sid)
  if (existing) {
    existing.peer = peer
    existing.lastActiveAt = now
    return existing
  }
  const entry: SceneEntry = {
    peer,
    currentX: peer.x,
    currentY: peer.y,
    targetX: peer.x,
    targetY: peer.y,
    lastActiveAt: now,
    currentMouth: 0,
    currentEyes: 1,
    targetMouth: 0,
    targetEyes: 1,
    // 新条目先不接管面部参数：等这一路真的来了一帧动捕数据再说。
    // 否则"刚从快照里看到别人张着嘴"会让我们凭空替他张嘴。
    faceAt: 0,
  }
  entries.set(peer.sid, entry)
  return entry
}

export function removePeer(sid: string): void {
  entries.delete(sid)
}

export function clearScene(): void {
  entries.clear()
}

/**
 * 写入远端指针。
 *
 * ar 是**发送端**的宽高比：这里立刻换算成本端坐标，之后渲染只认归一化值。
 */
export function setRemotePointer(
  sid: string,
  x: number,
  y: number,
  ar: number,
  targetAr: number
): void {
  const entry = entries.get(sid)
  if (!entry) return
  const mapped = mapPointerToAspect({ x, y, ar }, targetAr)
  entry.targetX = mapped.x
  entry.targetY = mapped.y
  entry.lastActiveAt = Date.now()
}

/** 本机指针：直接就是本端坐标，不需要比例换算。 */
export function setLocalPointer(sid: string, x: number, y: number): void {
  const entry = entries.get(sid)
  if (!entry) return
  entry.targetX = x
  entry.targetY = y
  entry.lastActiveAt = Date.now()
}

/**
 * 写入面部姿态（本机与远端共用一个入口：值已经是 0~1 的绝对值，
 * 不需要像坐标那样做宽高比换算）。
 */
export function setFace(sid: string, mouth: number, eyes: number): void {
  const entry = entries.get(sid)
  if (!entry) return
  if (Number.isFinite(mouth)) entry.targetMouth = clamp01(mouth)
  if (Number.isFinite(eyes)) entry.targetEyes = clamp01(eyes)
  entry.faceAt = Date.now()
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * 槽位排布：n 个模型在底部等距站开。
 *
 * 只看服务端下发的 ord 顺序，不看数组下标——人数变化时各端必须算出同一个
 * 位置，否则「同一幕」就无从谈起。
 */
export function slotX(index: number, total: number): number {
  const n = Math.max(1, total)
  const i = Math.max(0, Math.min(n - 1, index))
  return (i + 1) / (n + 1)
}
