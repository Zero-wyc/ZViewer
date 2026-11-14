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
