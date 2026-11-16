// Live2D 悬浮层的协议类型。
//
// 与后端 live2dPatchOut / live2dSnapshotOut 的字段逐字对应：
// 服务端用**元组**而不是对象下发（一条 patch 里 8 行，每行省 20 多字节），
// 所以这里的行类型是定长元组，别改成 interface——改了要连带改后端。

export type Live2DModelKind = 'builtin' | 'url' | 'room'

/**
 * 整行模型数据（快照的 models 与 patch 的 add 共用）：
 * [socketId, name, kind, modelId, scale, ord, x, y, aspectRatio, mouth, eyes, dragX, dragY, form, brow, roll,
 *  headX, headY, offX, offY, depth, gazeX, gazeY, eyeLeft, eyeRight, flags]
 *
 * ord 是服务端分配的排位序号，客户端据此等距摆位——位置本身不广播，
 * 只有序号同步，各端才会摆出同一幕。
 *
 * 第 5 项（scale）与第 12、13 项（dragX/dragY）**已经不再使用**：大小与位置
 * 都改成了本机偏好。字段留在行里是因为服务端仍在按固定形状下发（老客户端
 * 也会发 drag），解析时跳过即可，不必为它改协议。
 *
 * 第 9、10 位是摄像头动捕算出的面部姿态（张嘴幅度 / 睁眼程度，0~1），
 * 没开动捕的成员一直是 0 / 1。
 *
 * 第 14~16 位是动捕的**表情细节与歪头**：嘴形、眉毛、滚转，0~1 编码、0.5 为中性。
 *
 * 第 17~25 位是**3D 头部与眼球**（本轮新增）：偏航、俯仰、视差 X/Y、深度、
 * 眼球 X/Y、左右眼睁开程度。全部 0~1 编码。追加在末尾而不是插在中间：
 * 老客户端按下标读前面的项不会错位，新客户端读不到就按中性处理。
 *
 * 第 26 位是**可用性位掩码**（LIVE2D_POSE_FLAG）：没有它，0.5 既可能是
 * "正对镜头"也可能是"他没开 3D"，刚进房的人只能等下一帧增量。
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
  number,
  number,
  number,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
]

/**
 * patch 里的指针增量（只有变动的那几个字段）：
 * [socketId, x, y, aspectRatio, m?, e?, form?, brow?, roll?,
 *  headX?, headY?, offX?, offY?, depth?, gazeX?, gazeY?, eyeL?, eyeR?, flags?]
 *
 * 和整行**不同形状**：这里每 100ms 就要发全体成员一遍，带 name/kind 纯属浪费。
 *
 * 第 5 项之后全是**可选的**：服务端只在对方正在动捕时（600ms 内收到过面部数据）
 * 才带上它们。这个区分很重要——没有它，所有模型都会被按成"不眨眼"。
 */
export type Live2DStateRow = [
  string,
  number,
  number,
  number,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
  number?,
]

/**
 * patch 里的拖拽偏移行：[socketId, dx, dy]。
 *
 * **本端已经不再读取**：位置改成本机偏好之后，谁也不需要知道别人把他自己的
 * 角色拖到哪儿了。类型保留只因为服务端仍在按这个形状下发（老客户端会发
 * live2d-drag，服务端照旧转发），丢掉整段 `d` 字段即可。
 */
export type Live2DDragRow = [string, number, number]

/**
 * 姿态数组尾部的可用性标志（`p[12]`）。
 *
 * 只有数字能进这条热路径，所以用位掩码而不是两个布尔字段：关掉 3D 的发送端
 * 会带中值（0.5），接收端必须能区分"他没开 3D"和"他正对镜头"——前者要让
 * 引擎的 focus 继续带动头部，后者要把头压回正中。
 */
export const LIVE2D_POSE_FLAG = {
  HEAD: 1,
  EYE: 2,
} as const

export interface Live2DPeer {
  sid: string
  name: string
  kind: Live2DModelKind
  modelId: string
  /**
   * 服务端名册里的缩放。
   *
   * **不再用于渲染**（大小是本机偏好，见 core/peer-scale）。留着是因为行里
   * 就这么发的，解析成字段比在下标里跳过更容易对齐协议。
   */
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
  /** 嘴形 0~1，0.5 中性、>0.5 笑、<0.5 撇嘴（动捕） */
  form: number
  /** 眉毛 0~1，0.5 中性、>0.5 挑眉、<0.5 皱眉（动捕） */
  brow: number
  /** 滚转 0~1，0.5 端正、<0.5 向左倒、>0.5 向右倒（动捕） */
  roll: number
  /** 3D 偏航 0~1，0.5 正对镜头（动捕；老服务端没有这一项） */
  headX: number
  /** 3D 俯仰 0~1，0.5 平视 */
  headY: number
  /** 6DOF 平移视差 0~1，0.5 居中 */
  offX: number
  offY: number
  /** 深度 0~1，0.5 为标定距离、>0.5 靠近镜头 */
  depth: number
  /** 眼球方向 0~1，0.5 居中 */
  gazeX: number
  gazeY: number
  /** 左/右眼睁开程度 0~1（1 = 全睁） */
  eyeLeft: number
  eyeRight: number
  /** 3D 头部这一帧是否有效（快照里的掩码位） */
  headActive: boolean
  /** 眼球跟随这一帧是否有效 */
  eyeActive: boolean
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

/**
 * 「你正在用的公共库模型被删了」的通知。
 *
 * 只带 modelId，由客户端自己比对是不是自己的选择：被摘掉的成员已经由同批的
 * rem 行从名册里移除，这条只负责说明原因并触发本地回退。
 */
export interface Live2DModelRemovedPayload {
  roomId: string
  modelId: string
}

/** 「戳一下」的广播：from 是发起人，target 是被戳的角色。 */
export interface Live2DPokePayload {
  roomId: string
  from: string
  target: string
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
    // 第 11、12 位（dragX/dragY）跳过：位置是本机偏好，名册里那一份不再参与
    // 渲染（老客户端可能还在发，读了也没人用）。
    // 缺这三项（老服务端）时按中性处理：clampUnit 对 NaN 的兜底正好是 0.5，
    // 不会让模型歪头或皱眉
    form: clampUnit(Number(row[13])),
    brow: clampUnit(Number(row[14])),
    roll: clampUnit(Number(row[15])),
    // 3D 头部与眼球：老服务端没有这几项，clampUnit 的 NaN 兜底给 0.5（居中）。
    // 眼睁开程度的中性是 1 而不是 0.5，单独兜底。
    headX: clampUnit(Number(row[16])),
    headY: clampUnit(Number(row[17])),
    offX: clampUnit(Number(row[18])),
    offY: clampUnit(Number(row[19])),
    depth: clampUnit(Number(row[20])),
    gazeX: clampUnit(Number(row[21])),
    gazeY: clampUnit(Number(row[22])),
    eyeLeft: clampOpen(Number(row[23])),
    eyeRight: clampOpen(Number(row[24])),
    // 第 26 位是可用性掩码：老服务端没有，按"都没开"处理
    headActive: (Number(row[25] ?? 0) & LIVE2D_POSE_FLAG.HEAD) !== 0,
    eyeActive: (Number(row[25] ?? 0) & LIVE2D_POSE_FLAG.EYE) !== 0,
  }
}

/** 睁眼程度：缺省（NaN）按全睁，不是 0.5。 */
function clampOpen(v: number): number {
  if (!Number.isFinite(v)) return 1
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
