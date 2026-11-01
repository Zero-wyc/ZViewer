/**
 * 屏幕共享协议 v1 的线上类型。
 *
 * 逐字段对齐 `backend-go/internal/share/protocol.go`：改任何一侧都要同步另一侧，
 * 服务端用 `DisallowUnknownFields` 严格解码，字段名对不上会直接被拒。
 *
 * 与 Piik（MIT）的对应关系：这里只保留 ZViewer 需要的 P2P + 中继两支，
 * 去掉房间准入、语音、远程输入相关的消息。
 *
 * 本文件**只有类型**，不带任何运行时值：`import type` 会被类型擦除，
 * 这样 node --experimental-strip-types 的测试不必处理扩展名解析。
 * 事件名与单帧上限在 `codec.ts`。
 */

/** 采集/编码档位。服务端只存不改，房主据此设置 encodings。 */
export interface ShareQualitySettings {
  resolutionPreset: string
  frameRate: number
  maxBitrateMbps: number
}

/** 参与者角色。 */
export type ShareRole = 'host' | 'viewer'

/** 一个共享参与者。 */
export interface ShareParticipant {
  peerId: string
  socketId: string
  role: ShareRole
  displayName?: string
  /** 是否已经解出过第一帧（服务端只记录，不据此提交路由）。 */
  mediaReady: boolean
}

/** 一条待建立的路由候选。 */
export interface ShareCandidate {
  childPeerId: string
  /**
   * 这条边的上游：房主或另一位观众（树形拓扑）。
   *
   * 中继边没有 P2P 上游，字段缺省。客户端据此判断自己在这条边上是「收」还是
   * 「转发」——`parentPeerId === 自己` 就说明这条边要由我发 offer。
   */
  parentPeerId?: string
  connectionId: string
  /** direct = 浏览器直连；relay = 服务器中继。 */
  transport: 'direct' | 'relay'
  /** 只有 transport=relay 时才有值：观众据此写 sfu-signal 的栅栏字段。 */
  publicationGeneration?: string
}

/** 已提交的路由分配。 */
export interface ShareAssignment {
  revision: number
  phase: SharePhase
  candidates: ShareCandidate[]
}

/** 路由阶段。只有两个值（Piik types.go:39）。 */
export type SharePhase = 'prepare' | 'active'

/** 路由此刻的状态。只有两种组合（Piik server.go:117）。 */
export type ShareStatusState = 'waiting' | 'failed'

/**
 * 服务端告诉房主「你这一份出流对多位观众都不够」。
 *
 * 只在**多位观众同时报坏**（或唯一那位观众换不动父、一直坏）时下发。房主
 * 据此降一档：单条路的问题由服务端换父解决，不该拿所有人的清晰度去补。
 */
export interface ShareHostPressureMessage {
  t: 'share.host-pressure'
  roomId: string
  revision: number
  /** 最近仍在报坏的观众数。 */
  degraded: number
  /** 挂在房主身上的观众总数。 */
  viewers: number
  /** 主要成因（freeze / loss / stall），仅供诊断。 */
  reason?: string
}

/** 状态原因。 */
export type ShareStatusReason =
  'sfu-admission' | 'route-exhausted' | 'relay-unreachable' | 'relay-disabled'

/** SDP/ICE 的种类。 */
export type ShareSignalKind = 'offer' | 'answer' | 'candidate'

// ==================== 客户端 → 服务器 ====================

/** 建立共享会话并取回快照。 */
export interface ShareHelloMessage {
  t: 'share.hello'
  roomId: string
  /**
   * 带上它表示「我知道上一次的代际」：服务端据此判定是延续还是重新开一代。
   *
   * 房主刷新后必须带上一代际，否则会让所有观众的现有连接被判过期。
   */
  shareGeneration?: string
}

/** 房主开始共享。 */
export interface ShareStartMessage {
  t: 'share.start'
  roomId: string
  shareGeneration?: string
  paused?: boolean
  qualitySettings?: ShareQualitySettings
}

/** 结束共享。 */
export interface ShareStopMessage {
  t: 'share.stop'
  roomId: string
  shareGeneration: string
}

/** 暂停/恢复共享。 */
export interface SharePauseMessage {
  t: 'share.pause'
  roomId: string
  shareGeneration: string
  paused: boolean
}

/** 声明候选已就绪。服务端只接受 prepare 阶段。 */
export interface ShareRouteReadyMessage {
  t: 'share.route-ready'
  roomId: string
  revision: number
  phase: SharePhase
  connectionId?: string
}

/** 只上报「传输层连上了」，不提交路由。 */
export interface ShareTransportConnectedMessage {
  t: 'share.transport-connected'
  roomId: string
  revision: number
  connectionId: string
}

/** 上报候选失败。 */
export interface ShareRouteFailedMessage {
  t: 'share.route-failed'
  roomId: string
  revision: number
  phase: SharePhase
  connectionId: string
}

/**
 * 一个采样窗口的媒体质量证据（观众 → 服务器）。
 *
 * 全部指标都可选：浏览器版本不同给的字段不一样，缺了就缺了。服务端据此判
 * 「这条边是不是持续变差」，并在有别的上游时换父（backend share/quality.go）。
 */
export interface ShareQualityWindow {
  windowMs: number
  framesPerSecond?: number
  framesDropped?: number
  freezeCount?: number
  freezeDurationMs?: number
  /** 本窗口丢包比例，0–1。 */
  packetLossRate?: number
  rttMs?: number
  jitterMs?: number
  decodeMsPerFrame?: number
  bitrateKbps?: number
  width?: number
  height?: number
  codec?: string
}

/**
 * 观众上报一个质量窗口。
 *
 * 每 2 秒一条，是**唯一**由观众主动上报的媒体面数据。它不换任何回报：
 * 服务端不需要 ack，写错就丢（证据是尽力而为的输入）。
 */
export interface ShareQualityMessage {
  t: 'share.quality'
  roomId: string
  revision: number
  connectionId: string
  window: ShareQualityWindow
}

/** 观众发起的恢复请求。 */
export interface ShareRestartMessage {
  t: 'share.restart'
  roomId: string
  connectionId: string
  /** true = 销毁重建，false = ICE restart。 */
  rebuild: boolean
}

/** 中继一条 SDP 或 ICE。 */
export interface ShareSignalMessage {
  t: 'share.signal'
  roomId: string
  connectionId: string
  kind: ShareSignalKind
  payload: unknown
}

/**
 * 中继侧的 publication/subscription 信令（双向：同一形状上下行都用）。
 *
 * - `description`：房主发 offer（首个必须带 `media` 声明）；观众收到服务器的
 *   offer 后回 answer。载荷是 `{ description, media? }`。
 * - `candidate`：ICE 候选，载荷就是 `RTCIceCandidateInit`。
 * - `media`：房主单独声明/更新媒体参数。
 * - `layers`：服务器下发 `activeCount`（房主据此启用几层编码）。
 * - `subscribe`：观众请求订阅，服务器回 `description`（offer）。
 */
export interface ShareSfuSignalMessage {
  t: 'share.sfu-signal'
  roomId: string
  revision: number
  publicationGeneration: string
  connectionId: string
  kind: 'description' | 'candidate' | 'media' | 'layers' | 'subscribe'
  payload?: unknown
  /** 房主需要的分层数量（activeCount 闭环）。 */
  activeCount?: number
}

/** 服务器也发同一种中继信令，别名让两个联合都读得顺。 */
export type ShareSfuMessage = ShareSfuSignalMessage

/** 客户端消息联合。 */
export type ShareClientMessage =
  | ShareHelloMessage
  | ShareStartMessage
  | ShareStopMessage
  | SharePauseMessage
  | ShareRouteReadyMessage
  | ShareTransportConnectedMessage
  | ShareRouteFailedMessage
  | ShareQualityMessage
  | ShareRestartMessage
  | ShareSignalMessage
  | ShareSfuSignalMessage

// ==================== 服务器 → 客户端 ====================

/** 一次完整的共享状态快照。收到即丢弃本地旧态。 */
export interface ShareSnapshotMessage {
  t: 'share.snapshot'
  roomId: string
  shareGeneration: string
  revision: number
  paused: boolean
  sharing: boolean
  qualitySettings: ShareQualitySettings
  participants: ShareParticipant[]
  assignment?: ShareAssignment
}

/** 路由阶段变化与候选下发。 */
export interface ShareRouteMessage {
  t: 'share.route'
  roomId: string
  revision: number
  phase: SharePhase
  assignment: ShareAssignment
  candidate?: ShareCandidate
}

/** 「还在等」或「彻底失败」。只有两种组合。 */
export interface ShareStatusMessage {
  t: 'share.status'
  roomId: string
  revision: number
  state: ShareStatusState
  reason: ShareStatusReason
}

/** 通知房主「中继可用」。 */
export interface ShareSfuConfigMessage {
  t: 'share.sfu-config'
  roomId: string
  revision: number
  publicationGeneration: string
  connectionId: string
}

/** 把对端的 SDP/ICE 转发给本端。 */
export interface ShareSignalRelayMessage {
  t: 'share.signal-relay'
  roomId: string
  fromPeerId: string
  connectionId: string
  kind: ShareSignalKind
  payload: unknown
}

/** 一次失败回报（share 事件没有 ack，只能靠它）。 */
export interface ShareErrorMessage {
  t: 'share.error'
  roomId?: string
  code: ShareErrorCode
  message: string
}

/** 错误码。 */
export type ShareErrorCode =
  | 'INVALID_MESSAGE'
  | 'NO_ROOM'
  | 'FORBIDDEN'
  | 'SHARING_GENERATION_REPLACED'
  | 'NOT_IMPLEMENTED'

/** 服务器消息联合。 */
export type ShareServerMessage =
  | ShareSnapshotMessage
  | ShareRouteMessage
  | ShareStatusMessage
  | ShareHostPressureMessage
  | ShareSfuMessage
  | ShareSfuConfigMessage
  | ShareSignalRelayMessage
  | ShareErrorMessage
