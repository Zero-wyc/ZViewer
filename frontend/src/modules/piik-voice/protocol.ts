/**
 * Piik 语音协议的客户端类型与纯函数。
 *
 * 这一层只做「线上形状」的翻译，不含任何 WebRTC 动作：服务端下发的
 * `room-voice-state` 是**授权结果**（谁能给谁发什么），`room-voice-signal`
 * 是**传输层信封**。把两者混在一起写，出错时只会表现为「没声音」。
 *
 * 与 Piik 上游 `src/shared/protocol.ts` 的语音子集一一对应；上游用 zod
 * 校验，这里用显式字段检查，因为只需要拒绝明显不合法的东西——真正的约束
 * 在服务端，客户端多校验一次只是为了让错误尽早暴露在本地。
 *
 * 握手、ICE、路由这些共享的部分不在这里：它们在 `modules/piik-signal`，
 * 共享与语音共用同一份。
 */
export {
  DEFAULT_ROUTE_POLICY,
  FATAL_AUTH_CODES,
  SIGNALING_PROTOCOL,
  decodeServerMessage,
  type PiikAuthenticated,
  type PiikIceConfig,
  type PiikIceServer,
  type PiikRoutePolicy,
} from '../piik-signal/protocol.ts'

import type { PiikAuthenticated } from '../piik-signal/protocol.ts'

export interface PiikVoiceMember {
  peerId: string
  connected: boolean
  joined: boolean
  upstream:
    { kind: 'none' } | { kind: 'peer'; peerId: string } | { kind: 'sfu' }
  publicationId?: string
  deafened?: boolean
}

export interface PiikVoicePublication {
  id: string
  peerId: string
}

export interface PiikVoiceConnection {
  connectionId: string
  parentPeerId?: string
  childPeerId: string
  transport: 'peer' | 'sfu'
  pending: boolean
  revision: number
  /** 我在这条连接上要发的 publication。 */
  send: string[]
  /** 我在这条连接上要收的 publication。 */
  receive: string[]
}

export interface PiikVoiceState {
  type: 'room-voice-state'
  bitrate?: number
  revision: number
  enabled: boolean
  hostPeerId: string | null
  members: PiikVoiceMember[]
  publications: PiikVoicePublication[]
  connections: PiikVoiceConnection[]
  unavailable: string[]
}

export interface PiikVoiceDescription {
  revision: number
  sdp: { type: 'offer' | 'answer'; sdp: string }
  tracks: { mid: string; publicationId: string }[]
}

export type PiikVoiceSignal =
  | {
      type: 'room-voice-signal'
      connectionId: string
      description: PiikVoiceDescription
    }
  | {
      type: 'room-voice-signal'
      connectionId: string
      candidate: RTCIceCandidateInit
    }
  | { type: 'room-voice-signal'; connectionId: string; renegotiate: true }

export type PiikClientMessage =
  | {
      type: 'authenticate'
      protocol: string
      roomId: string
      role: 'host'
      token: string
      clientId: string
      routePolicy: import('../piik-signal/protocol.ts').PiikRoutePolicy
      roomOnly?: true
      roomSession?: true
    }
  | {
      type: 'authenticate'
      protocol: string
      roomId: string
      role: 'viewer'
      clientId: string
      viewerGrant?: string
    }
  | { type: 'subscribe-room-voice'; deafened?: boolean; bitrate?: true }
  | {
      type: 'room-voice-command'
      command:
        | { action: 'join' }
        | { action: 'leave' }
        | { action: 'publish' }
        | { action: 'unpublish'; publicationId: string }
        | { action: 'deafen'; deafened: boolean }
        | { action: 'bitrate'; bitrate: number }
    }
  | PiikVoiceSignal
  | {
      type: 'room-voice-transport'
      connectionId: string
      state: 'connected' | 'failed'
    }
  | { type: 'signaling-challenge'; sequence: number }

export type PiikServerMessage =
  | PiikAuthenticated
  | PiikVoiceState
  | PiikVoiceSignal
  | { type: 'room-voice-error'; code: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'room-closed' }
  | { type: 'signaling-challenge-response'; sequence: number }
  | { type: string; [key: string]: unknown }

/** 判断我是不是这条连接的发起方（offerer）。 */
export function isOfferer(
  connection: PiikVoiceConnection,
  peerId: string
): boolean {
  return connection.transport === 'peer' && connection.parentPeerId === peerId
}

/** 这条连接的对端 peerId。 */
export function remotePeerOf(
  connection: PiikVoiceConnection,
  peerId: string
): string {
  return connection.parentPeerId === peerId
    ? connection.childPeerId
    : (connection.parentPeerId ?? '')
}

/**
 * 状态里「我参与」的连接。
 *
 * 服务端只下发与本人相关的边，这里再筛一次是因为 P2P 拓扑在重排瞬间可能
 * 把一条已经不属于我的边带过来；照着它建 PC 会连到一个不存在的对端。
 */
export function myConnections(
  state: PiikVoiceState | null,
  peerId: string
): PiikVoiceConnection[] {
  if (!state) return []
  return state.connections.filter(
    (connection) =>
      connection.parentPeerId === peerId || connection.childPeerId === peerId
  )
}

/**
 * 某个 publication 在本连接上的来源音轨该从哪里取。
 *
 * 自己发布的从麦克风取；别人的从「已经收到的那条连接」取——这是 Piik 的
 * 转发（junction）语义：中间节点收到上游的音频后原样转发给下游，服务端
 * 不会为每个接收者各发一份。
 */
export function publicationOwner(
  state: PiikVoiceState | null,
  publicationId: string
): string | null {
  return (
    state?.publications.find((publication) => publication.id === publicationId)
      ?.peerId ?? null
  )
}
