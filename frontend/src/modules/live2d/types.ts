// Live2D 悬浮层的协议类型。
//
// 与后端 live2dPatchOut / live2dSnapshotOut 的字段逐字对应：
// 服务端用**元组**而不是对象下发（一条 patch 里 8 行，每行省 20 多字节），
// 所以这里的行类型是定长元组，别改成 interface——改了要连带改后端。

export type Live2DModelKind = 'builtin' | 'url' | 'room'

/**
 * 一行模型数据：
 * [socketId, name, kind, modelId, scale, ord, x, y, aspectRatio]
 *
 * ord 是服务端分配的排位序号，客户端据此等距摆位——位置本身不广播，
 * 只有序号同步，各端才会摆出同一幕。
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
]

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
}

export interface Live2DSnapshotPayload {
  roomId: string
  models?: Live2DRow[]
}

export interface Live2DPatchPayload {
  roomId: string
  /** 指针更新：与快照同形状的 9 元组，取前 4 个字段 */
  u?: Live2DRow[]
  /** 被移除的 socketId */
  r?: string[]
  /** 新增/换模型的成员 */
  add?: Live2DRow[]
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
  }
}

function clampUnit(v: number): number {
  if (!Number.isFinite(v)) return 0.5
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
