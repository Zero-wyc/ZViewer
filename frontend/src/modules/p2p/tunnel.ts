/**
 * P2P 隧道
 *
 * 职责单一：管理 RTCPeerConnection 生命周期与 ICE 协商。
 * 不直接接触 socket，通过 SignalingClient 收发信令。
 *
 * 设计要点：
 * - sender 发起 offer；receiver 响应 offer 并发 answer
 * - receiver 可能在 enable() 之前收到 offer，会缓存为 pendingOffer
 * - ICE 候选在 remoteDescription 就绪前入队，就绪后按序 flush
 *   （借鉴 mirotalk queueIceCandidate/flushIceCandidates，防止候选丢失）
 * - disconnected 状态给 3s 宽限观察自愈，failed 立即回退
 * - ICE 超时后自动回退（触发 onStatusChange(failed, true)）
 * - 状态变更通过回调通知外部，不直接 setState
 */
import { ICE_SERVERS, ICE_TIMEOUT_MS } from './constants'
import type {
  P2PRole,
  P2PSignalingChannel,
  P2PStatus,
  P2PStatusChangeHandler,
  P2PTunnelConfig,
  P2PTunnelInstance,
} from './types'

export class P2PTunnel implements P2PTunnelInstance {
  private readonly role: P2PRole
  private readonly signaling: P2PSignalingChannel
  private readonly onStatusChange?: P2PStatusChangeHandler

  private localStream: MediaStream | null
  private remotePeerId: string | null

  private pc: RTCPeerConnection | null = null
  private enabled = false
  private status: P2PStatus = 'idle'

  private iceTimeoutHandle: ReturnType<typeof setTimeout> | null = null
  private pendingOffer: {
    from: string
    sdp: RTCSessionDescriptionInit
  } | null = null
  /**
   * ICE 候选队列（借鉴 mirotalk queueIceCandidate/flushIceCandidates）。
   * addIceCandidate 在 remoteDescription 未设置前调用会抛错且候选永久丢失；
   * receiver 处理 offer（setRemoteDescription 为异步）期间到达的候选、
   * 以及 sender answer 到达前到达的候选，都必须先入队，等
   * remoteDescription 就绪后按序 flush。PC 未创建时也缓存（此前直接丢弃）。
   */
  private pendingCandidates: RTCIceCandidateInit[] = []
  /** disconnected 宽限计时器：瞬时网络抖动不应立即弃连回退 */
  private disconnectGraceHandle: ReturnType<typeof setTimeout> | null = null
  /** disconnected 状态宽限时长，超过仍未恢复才回退服务器中转 */
  private static readonly DISCONNECT_GRACE_MS = 3000

  constructor(config: P2PTunnelConfig) {
    this.role = config.role
    this.localStream = config.localStream ?? null
    this.remotePeerId = config.remotePeerId ?? null
    this.signaling = config.signaling
    this.onStatusChange = config.onStatusChange
  }

  /** 更新本地流（sender 模式下用于注入 track） */
  updateLocalStream(stream: MediaStream | null): void {
    this.localStream = stream
  }

  /** 更新对端 socketId */
  updateRemotePeerId(id: string | null): void {
    this.remotePeerId = id
  }

  async enable(): Promise<void> {
    if (this.pc) return // 已启用

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc
    this.enabled = true

    // sender 注入本地轨道
    if (this.role === 'sender' && this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!)
      })
    }

    // ICE candidate 回调（借鉴 mirotalk handleOnIceCandidate：
    // 过滤 end-of-candidates 空候选，减少无效信令）
    pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) return
      if (this.remotePeerId) {
        this.signaling.sendIceCandidate(
          this.remotePeerId,
          event.candidate.toJSON()
        )
      }
    }

    // ICE 候选收集错误（借鉴 mirotalk onicecandidateerror）：
    // 打洞失败时可观测到具体是哪个 STUN 服务器及原因
    pc.onicecandidateerror = (event) => {
      // RTCIceCandidateErrorEvent 不在当前 TS lib.dom 版本中，手动解构
      const { url, errorText } = event as unknown as {
        url: string
        errorText: string
      }
      console.warn('[P2PTunnel] ICE candidate error:', url, errorText)
    }

    // ICE 连接状态变更
    pc.oniceconnectionstatechange = () => {
      this.handleIceStateChange()
    }

    this.updateStatus('connecting')

    // ICE 超时检测
    this.iceTimeoutHandle = setTimeout(() => {
      const current = this.pc
      if (!current) return
      const state = current.iceConnectionState
      if (state !== 'connected' && state !== 'completed') {
        console.warn('[P2PTunnel] ICE timeout, falling back to relay')
        this.failWithFallback()
      }
    }, ICE_TIMEOUT_MS)

    if (this.role === 'sender') {
      await this.initiateOffer()
    } else {
      // receiver：处理可能提前到达的 offer
      await this.applyPendingOffer()
    }
  }

  disable(): void {
    this.closePC()
    this.enabled = false
    this.updateStatus('idle')
  }

  dispose(): void {
    this.closePC()
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  getPeerConnection(): RTCPeerConnection | null {
    return this.pc
  }

  getStatus(): P2PStatus {
    return this.status
  }

  // --- 信令回调（由 SignalingClient 调用） ---

  /** receiver 收到 sender 的 offer */
  handleOffer(from: string, sdp: RTCSessionDescriptionInit): void {
    // 记录对端 id
    this.remotePeerId = from

    const pc = this.pc
    if (!pc) {
      // PC 尚未创建：缓存 offer，等 enable() 后处理
      this.pendingOffer = { from, sdp }
      return
    }

    if (pc.signalingState !== 'stable') return

    void this.processOffer(pc, from, sdp)
  }

  /** sender 收到 receiver 的 answer */
  handleAnswer(_from: string, sdp: RTCSessionDescriptionInit): void {
    const pc = this.pc
    if (!pc) return
    // 仅在等待 answer 的状态下应用，防止重复/迟到 answer 触发误回退
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(
        '[P2PTunnel] answer ignored, unexpected signalingState:',
        pc.signalingState
      )
      return
    }
    void pc
      .setRemoteDescription(new RTCSessionDescription(sdp))
      .then(() => this.flushPendingCandidates(pc))
      .catch((err) => {
        console.error('[P2PTunnel] setRemoteDescription(answer) error:', err)
        this.failWithFallback()
      })
  }

  /** 双向收到 ICE candidate */
  handleIceCandidate(_from: string, candidate: RTCIceCandidateInit): void {
    const pc = this.pc
    // PC 未创建或 remoteDescription 未就绪：入队等待 flush（借鉴 mirotalk）
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      this.pendingCandidates.push(candidate)
      return
    }
    void pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => {
      console.warn('[P2PTunnel] addIceCandidate error:', err)
    })
  }

  /** remoteDescription 就绪后按序补投排队的候选（借鉴 mirotalk flushIceCandidates） */
  private async flushPendingCandidates(pc: RTCPeerConnection): Promise<void> {
    const queued = this.pendingCandidates
    if (queued.length === 0) return
    this.pendingCandidates = []
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.warn('[P2PTunnel] addIceCandidate (queued) error:', err)
      }
    }
  }

  // --- 内部方法 ---

  private async initiateOffer(): Promise<void> {
    const pc = this.pc
    if (!pc) return
    if (!this.remotePeerId) {
      console.warn('[P2PTunnel] remotePeerId not set, cannot offer')
      this.failWithFallback()
      return
    }
    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.signaling.sendOffer(this.remotePeerId, offer)
    } catch (err) {
      console.error('[P2PTunnel] createOffer error:', err)
      this.failWithFallback()
    }
  }

  private async applyPendingOffer(): Promise<void> {
    const pending = this.pendingOffer
    if (!pending) return
    this.pendingOffer = null
    const pc = this.pc
    if (!pc) return
    if (pc.signalingState === 'stable') {
      await this.processOffer(pc, pending.from, pending.sdp)
    }
  }

  private async processOffer(
    pc: RTCPeerConnection,
    from: string,
    sdp: RTCSessionDescriptionInit
  ): Promise<void> {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      // remoteDescription 就绪，先补投 offer 期间排队的候选再应答
      await this.flushPendingCandidates(pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      this.signaling.sendAnswer(from, answer)
    } catch (err) {
      console.error('[P2PTunnel] processOffer error:', err)
      this.failWithFallback()
    }
  }

  private handleIceStateChange(): void {
    const pc = this.pc
    if (!pc) return
    const state = pc.iceConnectionState
    if (state === 'connected' || state === 'completed') {
      this.clearDisconnectGrace()
      this.clearIceTimeout()
      this.updateStatus('connected')
    } else if (state === 'failed' || state === 'closed') {
      // failed：ICE 已确认无可用地址组合，立即回退；closed：PC 已被主动关闭
      this.failWithFallback()
    } else if (state === 'disconnected') {
      // disconnected 常为瞬时网络抖动（NAT 重绑定、Wi-Fi 切换），ICE 通常
      // 会自行恢复——给予宽限期观察，而非立即弃连回退（此前一断即回退，
      // 掉一次抖动就永久失去 P2P 直连）
      if (this.disconnectGraceHandle) return
      this.disconnectGraceHandle = setTimeout(() => {
        this.disconnectGraceHandle = null
        const current = this.pc
        if (!current) return
        if (current.iceConnectionState === 'disconnected') {
          console.warn(
            '[P2PTunnel] ICE disconnected beyond grace period, falling back to relay'
          )
          this.failWithFallback()
        }
      }, P2PTunnel.DISCONNECT_GRACE_MS)
    }
  }

  private failWithFallback(): void {
    this.updateStatus('failed', true)
    this.closePC()
    this.enabled = false
  }

  private updateStatus(next: P2PStatus, didFallback = false): void {
    this.status = next
    this.onStatusChange?.(next, didFallback)
  }

  private clearIceTimeout(): void {
    if (this.iceTimeoutHandle) {
      clearTimeout(this.iceTimeoutHandle)
      this.iceTimeoutHandle = null
    }
  }

  private clearDisconnectGrace(): void {
    if (this.disconnectGraceHandle) {
      clearTimeout(this.disconnectGraceHandle)
      this.disconnectGraceHandle = null
    }
  }

  private closePC(): void {
    this.clearIceTimeout()
    this.clearDisconnectGrace()
    const pc = this.pc
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.oniceconnectionstatechange = null
      pc.onicecandidateerror = null
      try {
        pc.close()
      } catch {
        // ignore
      }
      this.pc = null
    }
    this.pendingOffer = null
    this.pendingCandidates = []
  }
}
