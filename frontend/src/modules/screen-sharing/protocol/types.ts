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
  connectionId: string
  /** direct = 浏览器直连；relay = 服务器中继。 */
  transport: 'direct' | 'relay'
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

/** 中继侧的 publication/subscription 信令。 */
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

/** 客户端消息联合。 */
export type ShareClientMessage =
  | ShareHelloMessage
  | ShareStartMessage
  | ShareStopMessage
  | SharePauseMessage
  | ShareRouteReadyMessage
  | ShareTransportConnectedMessage
  | ShareRouteFailedMessage
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
  | ShareSfuConfigMessage
  | ShareSignalRelayMessage
  | ShareErrorMessage
