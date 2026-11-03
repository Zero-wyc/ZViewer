/**
 * Piik `/signal` 的线上形状（共享与语音共用）。
 *
 * 这一层只描述「服务端说什么」，不含任何 WebRTC 动作。共享与语音走的是
 * 同一条连接、同一份握手，区别只在消息族（`signal` / `route-*` 与
 * `room-voice-*`），所以公共部分必须只有一份定义——两边各写一份类型，
 * 迟早会出现「语音改了协议、共享没跟上」的静默错位。
 */

/** Piik 的信令协议版本，必须与服务端 `protocol.SignalingProtocol` 一致。 */
export const SIGNALING_PROTOCOL = 'piik-v24'

export interface PiikIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface PiikIceConfig {
  iceServers: PiikIceServer[]
  natPredictionStunUrls?: string[]
}

export interface PiikRoutePolicy {
  peerOnly: boolean
  topologyOptimization: boolean
  natPrediction: boolean
}

/** 服务端默认策略：允许拓扑优化，关闭 NAT 预测。 */
export const DEFAULT_ROUTE_POLICY: PiikRoutePolicy = {
  peerOnly: false,
  topologyOptimization: true,
  natPrediction: false,
}

export interface PiikAuthenticated {
  type: 'authenticated'
  protocol: string
  peerId: string
  role: 'host' | 'viewer'
  iceConfig: PiikIceConfig
  maxViewers: number
  endpointMediaCopyCapacity?: number
  hostOnline?: boolean
  hostPaused?: boolean
  connectionId?: string | null
}

// ---------------------------------------------------------------------------
// 共享：signal / route
// ---------------------------------------------------------------------------

export interface PiikSessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

/** `signal` 消息的载荷。三种 kind 共用 connectionId，靠 kind 判别。 */
export type PiikSignalPayload =
  | {
      kind: 'description'
      connectionId: string
      description: PiikSessionDescription
      punched?: boolean
    }
  | {
      kind: 'candidate'
      connectionId: string
      /** 候选结束（null）是协议允许的，表示不再有候选。 */
      candidate: RTCIceCandidateInit | null
    }
  | { kind: 'punch'; connectionId: string; punch: unknown }

export type PiikClientSignalMessage = {
  type: 'signal'
  targetPeerId?: string
  payload: PiikSignalPayload
}

export type PiikServerSignalMessage = {
  type: 'signal'
  fromPeerId: string
  payload: PiikSignalPayload
}

/** 一条待建立的边：我是父节点时由我发起 offer。 */
export interface PiikRouteCandidate {
  childPeerId: string
  connectionId: string
  /**
   * `direct` 是浏览器直连，`sfu` 是服务端中转。
   * 注意不是 `peer`——上游在语音的连接里用 `peer`，两条消息族各有一套枚举。
   */
  transport: 'direct' | 'sfu'
  qualityProbe: boolean
}

export type PiikUpstream =
  { kind: 'none' } | { kind: 'peer'; peerId: string } | { kind: 'sfu' }

export interface PiikRouteAssignment {
  upstream: PiikUpstream
  childPeerIds: string[]
  sfuPublicationGeneration?: string | null
}

export type PiikRouteUpdate =
  | {
      type: 'route-update'
      revision: number
      phase: 'prepare'
      assignment: PiikRouteAssignment
      candidate: PiikRouteCandidate
    }
  | {
      type: 'route-update'
      revision: number
      phase: 'active'
      assignment: PiikRouteAssignment
    }

export interface PiikRouteStatus {
  type: 'route-status'
  revision: number
  state: 'waiting' | 'failed'
  reason: string
}

export interface PiikSharingStarted {
  type: 'sharing-started'
  shareGeneration: string
  routePolicy: PiikRoutePolicy
  routeRevision: number
  routeAssignment: PiikRouteAssignment
  paused?: boolean
}

export interface PiikRoomStateViewer {
  peerId: string
  displayName?: string
}

export interface PiikRoomState {
  type: 'room-state'
  revision?: number
  hostOnline?: boolean
  sharing?: boolean
  viewers?: PiikRoomStateViewer[]
}

export type PiikClientMessage =
  | {
      type: 'authenticate'
      protocol: string
      roomId: string
      role: 'host'
      token: string
      clientId: string
      routePolicy: PiikRoutePolicy
      shareGeneration?: string
      roomOnly?: true
      roomSession?: true
      sharingPaused?: boolean
    }
  | {
      type: 'authenticate'
      protocol: string
      roomId: string
      role: 'viewer'
      clientId: string
      viewerGrant?: string
      viewerPassword?: string
    }
  | {
      type: 'start-sharing'
      shareGeneration: string
      routePolicy: PiikRoutePolicy
    }
  | { type: 'stop-sharing'; shareGeneration?: string }
  /** 房主暂停/恢复：服务端会把整条路由树挂起，不再分配新的候选。 */
  | { type: 'set-sharing-paused'; shareGeneration: string; paused: boolean }
  | PiikClientSignalMessage
  | {
      type: 'route-ready'
      revision: number
      phase: 'prepare' | 'active'
      qualityApproved?: boolean
    }
  | {
      type: 'route-transport-connected'
      revision: number
      connectionId: string
    }
  /**
   * 观众声明自己还能带几个下游。不发的话服务端把这位观众的下游容量当 0，
   * 树永远只有房主一层——第 4 位观众会一直排队。
   */
  | { type: 'relay-capacity'; downstreamEdges: number }
  | {
      type: 'route-media-unavailable'
      revision: number
      connectionId: string
      reason: string
    }
  | {
      type: 'route-failed'
      revision: number
      phase: 'prepare' | 'active'
      connectionId: string
    }
  | { type: 'signaling-challenge'; sequence: number }

/**
 * 下行消息的宽松视图。
 *
 * 不写成判别式联合：共享要收 `route-*`、语音要收 `room-voice-*`，两边都在
 * 增长，联合类型会让「多一个字段」变成「整条消息不兼容」。需要具体字段时
 * 由各自的模块断言成自己的类型。
 */
export interface PiikServerMessage {
  type: string
  [key: string]: unknown
}

/** 不可重试的关闭/错误码：重连只会重复失败。 */
export const FATAL_AUTH_CODES = new Set([
  'INVALID_TOKEN',
  'ROOM_NOT_FOUND',
  'ROOM_ACCESS_DENIED',
  'ROOM_FULL',
  'HOST_ALREADY_CONNECTED',
  'AUTH_REQUIRED',
])

/**
 * 宽松解码：只保证 `type` 是字符串。
 *
 * 共享和语音的消息族都在增长，这里做严格校验只会把「服务端多下发了一个
 * 字段」变成「客户端整条消息丢掉」。真正的约束在服务端。
 */
export function decodeServerMessage(raw: string): PiikServerMessage | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const type = (value as { type?: unknown }).type
    if (typeof type !== 'string' || !type) return null
    return value as PiikServerMessage
  } catch {
    return null
  }
}

/** 我是不是这条连接上的发起方：父节点负责 offer。 */
export function isOffererPeer(
  assignmentPeerId: string | null | undefined,
  peerId: string
): boolean {
  return !!assignmentPeerId && assignmentPeerId === peerId
}
