/**
 * P2P 直连模块类型定义
 */
import type { Socket } from 'socket.io-client'

/** P2P 隧道状态机 */
export type P2PStatus = 'idle' | 'connecting' | 'connected' | 'failed'

/** P2P 角色：sender 为房主（推流端），receiver 为观众（接收端） */
export type P2PRole = 'sender' | 'receiver'

/** 信令封包：携带 from 字段标识发送方 */
export interface SignalEnvelope<T = unknown> {
  from: string
  data: T
}

/** P2P 信令 payload，通过 P2P_SIGNAL_MARK 标记区分 */
export interface P2PSignalPayload {
  __p2pTunnel: true
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
}

/** P2P 状态变更回调，didFallback=true 表示已回退到服务器中转 */
export type P2PStatusChangeHandler = (
  status: P2PStatus,
  didFallback: boolean
) => void

/** 信令客户端配置 */
export interface SignalingClientConfig {
  socket: Socket
  role: P2PRole
  onOffer: (from: string, sdp: RTCSessionDescriptionInit) => void
  onAnswer: (from: string, sdp: RTCSessionDescriptionInit) => void
  onIceCandidate: (from: string, candidate: RTCIceCandidateInit) => void
}

/** P2P 隧道所需的信令发送能力（SignalingClient 结构化实现，避免与实现类互相引用） */
export interface P2PSignalingChannel {
  sendOffer(to: string, sdp: RTCSessionDescriptionInit): void
  sendAnswer(to: string, sdp: RTCSessionDescriptionInit): void
  sendIceCandidate(to: string, candidate: RTCIceCandidateInit): void
}

/** P2P 隧道配置 */
export interface P2PTunnelConfig {
  role: P2PRole
  localStream?: MediaStream | null
  remotePeerId?: string | null
  signaling: P2PSignalingChannel
  onStatusChange?: P2PStatusChangeHandler
}

/** P2P 隧道实例 */
export interface P2PTunnelInstance {
  /** 启用 P2P 直连（创建 PC 并发起/响应协商） */
  enable: () => Promise<void>
  /** 禁用 P2P 直连（关闭 PC） */
  disable: () => void
  /** 当前是否启用 */
  readonly isEnabled: boolean
  /** 当前 PC（可能为 null） */
  getPeerConnection: () => RTCPeerConnection | null
  /** 当前状态 */
  getStatus: () => P2PStatus
  /** 清理资源（组件卸载时调用） */
  dispose: () => void
}
