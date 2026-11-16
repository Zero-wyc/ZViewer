import type { Live2DPeer } from '../types'
import { clampDragOffset } from './drag.ts'
import { mapPointerToAspect } from './pointer-map.ts'

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
   * 3D 头部与眼球（全部 0~1 编码，0.5 居中）。
   *
   * 单独一组而不是塞进 form/brow/roll：那三项是"表情形状"，语义是"偏离中性的
   * 方向"；这一组里 eyeLeft/eyeRight 是"睁开程度"（中性是 1），混在一起很容易
   * 在渲染端把 0.5 当成半睁。
   *
   * headX/headY = 偏航/俯仰，offX/offY = 6DOF 平移视差，depth = 前后位移，
   * gazeX/gazeY = 眼球指向。老服务端不发这几项时保持中值，画面与改造前一致。
   */
  currentHeadX: number
  currentHeadY: number
  currentOffX: number
  currentOffY: number
  currentDepth: number
  currentGazeX: number
  currentGazeY: number
  currentEyeLeft: number
  currentEyeRight: number
  targetHeadX: number
  targetHeadY: number
  targetOffX: number
  targetOffY: number
  targetDepth: number
  targetGazeX: number
  targetGazeY: number
  targetEyeLeft: number
  targetEyeRight: number
  /**
   * 最近一次收到面部数据的时刻。
   *
   * 0 表示「这个成员没在动捕」。渲染器只在数据新鲜（FACE_TTL 内）时接管
   * 嘴/眼/表情参数，超时就还给引擎自己眨——否则对方关掉动捕后模型会一直
   * 保持最后一帧的张嘴表情。
   */
  faceAt: number
  /**
   * 最近一次收到 **3D 头部** 数据的时刻；0 表示这位成员没有 3D 头部。
   *
   * 与 faceAt 分开：协议里 3D 是可选追加项，老客户端/关掉 3D 的人永远不带。
   * 渲染器据此决定「偏航/俯仰要不要接管」——无条件接管会把头钉死在正前方。
   */
  headAt: number
  /** 最近一次收到**眼球**数据的时刻；同样只对支持的客户端有意义。 */
  eyeAt: number

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
  // **纯本机**的位置：不同步给别人，名册也不再带它。分「目标 / 当前」是为了
  // 保留平滑（回位、换窗口时不要瞬移），但对本人拖拽时两者一起写，跟手。
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
    // 位置**不动**：它是本机偏好，名册里那一份（老服务端/老客户端发来的）
    // 与我这台设备的摆法无关。以前这里跟着整行走，于是任何一次 upsert
    // （换模型、重连补快照）都会把用户拖好的位置打回服务端的值。
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
    // 中性：不笑不撇嘴、眉毛平、头端正、眼球居中、眼全睁
    currentForm: 0.5,
    currentBrow: 0.5,
    currentRoll: 0.5,
    targetForm: 0.5,
    targetBrow: 0.5,
    targetRoll: 0.5,
    currentHeadX: 0.5,
    currentHeadY: 0.5,
    currentOffX: 0.5,
    currentOffY: 0.5,
    currentDepth: 0.5,
    currentGazeX: 0.5,
    currentGazeY: 0.5,
    currentEyeLeft: 1,
    currentEyeRight: 1,
    targetHeadX: 0.5,
    targetHeadY: 0.5,
    targetOffX: 0.5,
    targetOffY: 0.5,
    targetDepth: 0.5,
    targetGazeX: 0.5,
    targetGazeY: 0.5,
    targetEyeLeft: 1,
    targetEyeRight: 1,
    // 新条目先不接管面部参数：等这一路真的来了一帧动捕数据再说。
    // 否则"刚从快照里看到别人张着嘴"会让我们凭空替他张嘴。
    //
    // 3D/眼球例外：快照里带了掩码就说明"他现在确实在动捕 + 开着 3D"，
    // 直接按新鲜处理，否则刚进房的人要等最多 100ms 才看到别人转头/斜眼。
    faceAt: 0,
    headAt: peer.headActive ? now : 0,
    eyeAt: peer.eyeActive ? now : 0,
    currentVoiceMouth: 0,
    targetVoiceMouth: 0,
    voiceAt: 0,
    // 新条目站在默认槽位；本人的记忆位置由 useDragPref 在「我出现在名册里」
    // 那一刻套上去，别人的位置本来就没有可记的东西。
    targetDragX: 0,
    targetDragY: 0,
    currentDragX: 0,
    currentDragY: 0,
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
 * 取一份场景快照（浅拷贝），用于「全量重拉」时保住连续量。
 *
 * 为什么需要：服务端快照是 `clearScene()` + 逐行 upsert 重建的，新条目的
 * 平滑状态全是初值。重连、`live2d-request` 补拉、以及任何一次快照重放，
 * 都会让画面上所有人的模型**瞬移**回默认槽位/中性表情——明明什么都没变。
 */
export function captureSmooth(): Map<string, SceneEntry> {
  const out = new Map<string, SceneEntry>()
  for (const [sid, entry] of entries) out.set(sid, { ...entry })
  return out
}

/**
 * 把上一份快照里的连续量套回同名条目。
 *
 * 只恢复「当前/目标值」与时间戳这几类平滑用的量：名册部分（模型、排序）必须用
 * 服务端刚发来的那一份，否则换模型会被旧快照顶回去。
 *
 * 拖拽现在**全是本机状态**，名册里没有权威值可依，所以目标值也必须恢复：
 * 只恢复 current 的话，重建出来的条目 target 是 0，下一帧角色就会从记忆位置
 * 自己滑回槽位——正是「重拉快照瞬移」这个 bug。
 */
export function restoreSmooth(prev: Map<string, SceneEntry>): void {
  for (const [sid, entry] of entries) {
    const old = prev.get(sid)
    if (!old) continue
    entry.currentX = old.currentX
    entry.currentY = old.currentY
    entry.targetX = old.targetX
    entry.targetY = old.targetY
    entry.lastActiveAt = old.lastActiveAt
    entry.currentMouth = old.currentMouth
    entry.currentEyes = old.currentEyes
    entry.targetMouth = old.targetMouth
    entry.targetEyes = old.targetEyes
    entry.currentForm = old.currentForm
    entry.currentBrow = old.currentBrow
    entry.currentRoll = old.currentRoll
    entry.targetForm = old.targetForm
    entry.targetBrow = old.targetBrow
    entry.targetRoll = old.targetRoll
    entry.currentHeadX = old.currentHeadX
    entry.currentHeadY = old.currentHeadY
    entry.currentOffX = old.currentOffX
    entry.currentOffY = old.currentOffY
    entry.currentDepth = old.currentDepth
    entry.currentGazeX = old.currentGazeX
    entry.currentGazeY = old.currentGazeY
    entry.currentEyeLeft = old.currentEyeLeft
    entry.currentEyeRight = old.currentEyeRight
    entry.targetHeadX = old.targetHeadX
    entry.targetHeadY = old.targetHeadY
    entry.targetOffX = old.targetOffX
    entry.targetOffY = old.targetOffY
    entry.targetDepth = old.targetDepth
    entry.targetGazeX = old.targetGazeX
    entry.targetGazeY = old.targetGazeY
    entry.targetEyeLeft = old.targetEyeLeft
    entry.targetEyeRight = old.targetEyeRight
    entry.faceAt = old.faceAt
    entry.headAt = old.headAt
    entry.eyeAt = old.eyeAt
    entry.currentVoiceMouth = old.currentVoiceMouth
    entry.targetVoiceMouth = old.targetVoiceMouth
    entry.voiceAt = old.voiceAt
    entry.currentDragX = old.currentDragX
    entry.currentDragY = old.currentDragY
    entry.targetDragX = old.targetDragX
    entry.targetDragY = old.targetDragY
  }
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
 * 一帧面部姿态的可选部分（与嘴/眼分开传）。
 *
 * 全部 0~1；老服务端/老客户端只会给前三项，其余留空表示"这一帧没带"，
 * 此时保持上一帧的值——不能按中性覆盖，否则对方的 3D 朝向会每收一包就归位。
 */
export interface FaceStateInput {
  form: number
  brow: number
  roll: number
  headX?: number
  headY?: number
  offX?: number
  offY?: number
  depth?: number
  gazeX?: number
  gazeY?: number
  eyeLeft?: number
  eyeRight?: number
  /** 这一帧的 3D 头部/眼球是否有效（缺省按"带了值就算"处理） */
  headActive?: boolean
  eyeActive?: boolean
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
  extras?: FaceStateInput
): void {
  const entry = entries.get(sid)
  if (!entry) return
  if (Number.isFinite(mouth)) entry.targetMouth = clamp01(mouth)
  if (Number.isFinite(eyes)) entry.targetEyes = clamp01(eyes)
  if (extras) {
    assign(extras.form, (v) => (entry.targetForm = v))
    assign(extras.brow, (v) => (entry.targetBrow = v))
    assign(extras.roll, (v) => (entry.targetRoll = v))
    assign(extras.headX, (v) => (entry.targetHeadX = v))
    assign(extras.headY, (v) => (entry.targetHeadY = v))
    assign(extras.offX, (v) => (entry.targetOffX = v))
    assign(extras.offY, (v) => (entry.targetOffY = v))
    assign(extras.depth, (v) => (entry.targetDepth = v))
    assign(extras.gazeX, (v) => (entry.targetGazeX = v))
    assign(extras.gazeY, (v) => (entry.targetGazeY = v))
    assign(extras.eyeLeft, (v) => (entry.targetEyeLeft = v))
    assign(extras.eyeRight, (v) => (entry.targetEyeRight = v))
    // 时间戳单独打：3D 与眼球是可选通道，老客户端永远不带，渲染器靠它们
    // 决定"要不要接管头部/眼球参数"。
    // 可用性优先看显式标记：关掉 3D 的发送端会带中值，不能当成"他正对镜头"。
    const headOk =
      extras.headActive ?? (finite(extras.headX) || finite(extras.headY))
    const eyeOk =
      extras.eyeActive ?? (finite(extras.gazeX) || finite(extras.gazeY))
    if (headOk) entry.headAt = Date.now()
    if (eyeOk) entry.eyeAt = Date.now()
  }
  entry.faceAt = Date.now()
}

/**
 * 只在字段真的带了值（有限数）时写目标。
 *
 * 逐字段判空而不是 `if (extras.headX !== undefined)` 一长串：这里要为 12 个
 * 字段写同样的分支，写成循环表最不容易漏——漏一个的表现是"某个通道永远
 * 停在中性"，很难从画面上看出来是协议解析的问题。
 */
function finite(value: number | undefined): boolean {
  return value !== undefined && Number.isFinite(value)
}

function assign(value: number | undefined, set: (v: number) => void): void {
  if (value === undefined || !Number.isFinite(value)) return
  set(clamp01(value))
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

/**
 * 这个人现在是否**真的在出声**（名字标签据此高亮）。
 *
 * 与 isVoiceActive 的区别：开着麦不说话时，对方客户端仍会推一帧嘴型 0
 * 把状态收尾，光看「数据新鲜」会把所有开麦的人都算成在说话。真正说话 =
 * 数据没过期 且 嘴型不是 0 —— micLevelToMouth 里已经有噪声门，非 0 就
 * 意味着确实越过了环境噪声。
 */
export function isVoiceSpeaking(entry: SceneEntry, ttlMs: number): boolean {
  return isVoiceActive(entry, ttlMs) && entry.targetVoiceMouth > 0
}

function clamp01(v: number): number {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/**
 * 本机拖拽偏移：目标与当前一起写。
 *
 * 必须跟手——拖动时如果也走平滑，模型会像被橡皮筋拽着，手感立刻变差。
 *
 * 只给本人的角色用：位置不再同步，别人的站位由槽位算，没有「我要把他的角色
 * 挪个地方」这回事（大小倒是可以各端自己调，见 core/peer-scale）。
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
 * 平滑地把偏移送回某个位置（回位用）。
 *
 * 与 setLocalDrag 的区别：只写目标值，渲染器按帧插值过去，而不是瞬移。
 */
export function moveDragTo(sid: string, x: number, y: number): void {
  const entry = entries.get(sid)
  if (!entry) return
  const next = clampDragOffset(x, y)
  entry.targetDragX = next.x
  entry.targetDragY = next.y
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
