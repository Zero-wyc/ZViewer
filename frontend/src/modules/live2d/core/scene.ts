import type { Live2DPeer } from '../types'
import { clampDragOffset } from './drag'
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
   * 表情细节与歪头：0~1 编码（0.5 = 中性）。
   *
   * 为什么和 mouth/eyes 同族却在协议里分开传：嘴/眼是「张开程度」，中位是
   * 0 和 1；这三项是「偏离中性的方向」，中位是 0.5。混在一个通道里，
   * 渲染端就得靠位置去猜语义，改一次协议错一次。
   */
  currentForm: number
  currentBrow: number
  currentRoll: number
  targetForm: number
  targetBrow: number
  targetRoll: number
  /**
   * 最近一次收到面部数据的时刻。
   *
   * 0 表示「这个成员没在动捕」。渲染器只在数据新鲜（FACE_TTL 内）时接管
   * 嘴/眼/表情参数，超时就还给引擎自己眨——否则对方关掉动捕后模型会一直
   * 保持最后一帧的张嘴表情。
   */
  faceAt: number

  // ---- 语音口型 ----
  // 只驱动嘴。与动捕的分工是硬的：动捕新鲜时这两个量完全不参与渲染，
  // 因为摄像头测出来的嘴比麦克风响度准，而且那时人就在镜头前。
  //
  // 为什么不能塞进 currentMouth/targetMouth：那一族带 faceAt，写进去就等于
  // 声明"他的眼和表情也归动捕管"，模型在整个说话期间都不会眨眼。
  currentVoiceMouth: number
  targetVoiceMouth: number
  /** 最近一次收到语音嘴型的时刻；0 = 这个人没开语音口型 */
  voiceAt: number

  // ---- 拖拽偏移 ----
  // 和视线一样分「目标 / 当前」：网络的台阶要磨成连续运动。唯一的例外是
  // 本机拖拽——那时目标与当前一起写，否则拖起来会有一帧的延迟感。
  targetDragX: number
  targetDragY: number
  currentDragX: number
  currentDragY: number
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
    // 位置跟着整行走（快照/add 都带）：换模型、重连补快照时也能回到别人
    // 看到的那个位置，不会突然跳回槽位原点。
    existing.targetDragX = peer.dragX
    existing.targetDragY = peer.dragY
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
    // 中性：不笑不撇嘴、眉毛平、头端正
    currentForm: 0.5,
    currentBrow: 0.5,
    currentRoll: 0.5,
    targetForm: 0.5,
    targetBrow: 0.5,
    targetRoll: 0.5,
    // 新条目先不接管面部参数：等这一路真的来了一帧动捕数据再说。
    // 否则"刚从快照里看到别人张着嘴"会让我们凭空替他张嘴。
    faceAt: 0,
    currentVoiceMouth: 0,
    targetVoiceMouth: 0,
    voiceAt: 0,
    targetDragX: peer.dragX,
    targetDragY: peer.dragY,
    currentDragX: peer.dragX,
    currentDragY: peer.dragY,
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
 *
 * extras 缺省时保持原值：鼠标上报（没有面部数据）走的就是这条路径，
 * 不能因为一次指针移动就把别人的笑脸抹平成中性。
 */
export function setFace(
  sid: string,
  mouth: number,
  eyes: number,
  extras?: { form: number; brow: number; roll: number }
): void {
  const entry = entries.get(sid)
  if (!entry) return
  if (Number.isFinite(mouth)) entry.targetMouth = clamp01(mouth)
  if (Number.isFinite(eyes)) entry.targetEyes = clamp01(eyes)
  if (extras) {
    if (Number.isFinite(extras.form)) entry.targetForm = clamp01(extras.form)
    if (Number.isFinite(extras.brow)) entry.targetBrow = clamp01(extras.brow)
    if (Number.isFinite(extras.roll)) entry.targetRoll = clamp01(extras.roll)
  }
  entry.faceAt = Date.now()
}

/** 姿态是否由动捕接管（数据新鲜）。渲染器与「是否需要平滑」共用同一判据。 */
export function isFaceActive(entry: SceneEntry, ttlMs: number): boolean {
  return entry.faceAt > 0 && Date.now() - entry.faceAt < ttlMs
}

/**
 * 写入**语音口型**（只有嘴）。本机与远端共用。
 *
 * 刻意不走 setFace：那条路会给 faceAt 打时间戳，等于把眼/表情/歪头也交给
 * 上报方接管。语音没有这些东西的对应物，接管之后模型在整段说话里都不眨眼。
 */
export function setVoiceMouth(sid: string, mouth: number): void {
  const entry = entries.get(sid)
  if (!entry) return
  if (Number.isFinite(mouth)) entry.targetVoiceMouth = clamp01(mouth)
  entry.voiceAt = Date.now()
}

/** 语音嘴型是否仍然新鲜（超时就把嘴还给引擎，否则静音后嘴会一直张着）。 */
export function isVoiceActive(entry: SceneEntry, ttlMs: number): boolean {
  return entry.voiceAt > 0 && Date.now() - entry.voiceAt < ttlMs
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * 远端拖拽偏移（来自 patch 的 d 行）。
 *
 * 只写目标值：10Hz 的台阶交给渲染器平滑，直接跳到目标会让人看到"瞬移"。
 */
export function setRemoteDrag(sid: string, x: number, y: number): void {
  const entry = entries.get(sid)
  if (!entry) return
  const next = clampDragOffset(x, y)
  entry.targetDragX = next.x
  entry.targetDragY = next.y
}

/**
 * 本机拖拽偏移：目标与当前一起写。
 *
 * 必须跟手——拖动时如果也走平滑，模型会像被橡皮筋拽着，手感立刻变差。
 */
export function setLocalDrag(sid: string, x: number, y: number): void {
  const entry = entries.get(sid)
  if (!entry) return
  const next = clampDragOffset(x, y)
  entry.targetDragX = next.x
  entry.targetDragY = next.y
  entry.currentDragX = next.x
  entry.currentDragY = next.y
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
