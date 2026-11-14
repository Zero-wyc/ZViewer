// Live2D 悬浮层的协议类型。
//
// 与后端 live2dPatchOut / live2dSnapshotOut 的字段逐字对应：
// 服务端用**元组**而不是对象下发（一条 patch 里 8 行，每行省 20 多字节），
// 所以这里的行类型是定长元组，别改成 interface——改了要连带改后端。

export type Live2DModelKind = 'builtin' | 'url' | 'room'

/**
 * 整行模型数据（快照的 models 与 patch 的 add 共用）：
 * [socketId, name, kind, modelId, scale, ord, x, y, aspectRatio, mouth, eyes, dragX, dragY]
 *
 * ord 是服务端分配的排位序号，客户端据此等距摆位——位置本身不广播，
 * 只有序号同步，各端才会摆出同一幕。
 *
 * 末尾两位是摄像头动捕算出的面部姿态（张嘴幅度 / 睁眼程度，0~1），
 * 没开动捕的成员一直是 0 / 1。
 *
 * 最后是拖拽偏移（相对槽位基准的视口比例）。追加在末尾而不是插在中间：
 * 少读两项的老客户端也能正常跑。
 */
export type Live2DRow = [
  string,
  string,
  Live2DModelKind,
  string,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
]

/**
 * patch 里的指针增量（只有变动的那几个字段）：
 * [socketId, x, y, aspectRatio, mouth?, eyes?]
 *
 * 和整行**不同形状**：这里每 100ms 就要发全体成员一遍，带 name/kind 纯属浪费。
 *
 * 后两位是**可选的**：服务端只在对方正在动捕时（600ms 内收到过面部数据）
 * 才带上它们。这个区分很重要——没有它，所有模型都会被按成"不眨眼"。
 */
export type Live2DStateRow = [string, number, number, number, number?, number?]

/**
 * patch 里的拖拽偏移行：[socketId, dx, dy]。
 *
 * 单开一类而不是塞进 u 行：u 行已经是变长的（末尾可选 m/e），再挂两个
 * 可选字段就分不清「第 5 项是张嘴幅度还是横向偏移」了。
 */
export type Live2DDragRow = [string, number, number]

export interface Live2DPeer {
  sid: string
  name: string
  kind: Live2DModelKind
  modelId: string
  scale: number
  ord: number
  /** 归一化注视目标（发送端视口，0~1） */
  x: number
  y: number
  /** 发送端视口宽高比 */
  ar: number
  /** 张嘴幅度 0~1（动捕） */
  mouth: number
  /** 睁眼程度 0~1（动捕） */
  eyes: number
  /** 拖拽偏移：正数向右（视口宽度的比例） */
  dragX: number
  /** 拖拽偏移：正数向下（视口高度的比例） */
  dragY: number
}

export interface Live2DSnapshotPayload {
  roomId: string
  models?: Live2DRow[]
  /** 房间级策略跟着快照一起下发，省一次往返 */
  policy?: Partial<Live2DPolicy>
}

/**
 * 房间级角色策略：房主设，全房间生效。
 *
 * 这是**协作约定**而不是安全边界——客户端遵守它，改客户端的人最多让自己
 * 看到的画面不同，影响不到别人。所以前端拿到就照做，不必防作弊。
 */
export interface Live2DPolicy {
  /** 允许成员开启摄像头动捕 */
  allowFace: boolean
  /** 对观众显示角色（房主自己永远看得到，否则他没法再右键改回来） */
  showToViewers: boolean
  /** 统一角色：全房间都显示房主选的那个模型 */
  unified: boolean
  unifiedKind?: Live2DModelKind
  unifiedId?: string
}

export const LIVE2D_DEFAULT_POLICY: Live2DPolicy = {
  allowFace: true,
  showToViewers: true,
  unified: false,
}

/** 策略广播的信封：带 roomId，方便丢弃别的房间的包。 */
export interface Live2DPolicyPayload {
  roomId: string
  policy?: Partial<Live2DPolicy>
}

export interface Live2DPatchPayload {
  roomId: string
  /** 指针/面部更新 */
  u?: Live2DStateRow[]
  /** 被移除的 socketId */
  r?: string[]
  /** 新增/换模型的成员 */
  add?: Live2DRow[]
  /** 拖拽偏移变化 */
  d?: Live2DDragRow[]
}

/**
 * 瞬时动作：表情（e）与动作组（g + i）共用一个通道。
 *
 * 表情只带下标；动作带「组名 + 组内下标」。服务端不做语义解释，原样广播，
 * 因为**同一个模型**在各端解析出的下标一致（都来自同一份 model3.json）。
 */
export interface Live2DActionPayload {
  roomId: string
  sid: string
  /** 表情下标；动作帧没有这个字段 */
  e?: number
  /** 动作组名（motions 的 key，如 "Idle"）；表情帧没有 */
  g?: string
  /** 动作在组内的下标 */
  i?: number
}

export interface Live2DConfigAck {
  success: boolean
  message?: string
  data?: { models?: Live2DRow[] }
}

export function rowToPeer(row: Live2DRow): Live2DPeer {
  return {
    sid: String(row[0] ?? ''),
    name: String(row[1] ?? ''),
    kind: (row[2] as Live2DModelKind) ?? 'builtin',
    modelId: String(row[3] ?? ''),
    scale: Number(row[4] ?? 1) || 1,
    ord: Number(row[5] ?? 0) || 0,
    x: clampUnit(Number(row[6])),
    y: clampUnit(Number(row[7])),
    ar: Number(row[8] ?? 1.78) || 1.78,
    mouth: clampUnit(Number(row[9] ?? 0)),
    eyes: clampUnit(Number(row[10] ?? 1)),
    dragX: finiteOffset(row[11]),
    dragY: finiteOffset(row[12]),
  }
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

/** 偏移可以为负（向左/向上），所以不能走 clampUnit；NaN 一律当 0。 */
function finiteOffset(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
