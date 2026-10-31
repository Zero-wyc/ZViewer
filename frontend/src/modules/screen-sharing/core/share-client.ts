/**
 * `share` 事件通道。
 *
 * 上行即发即忘、不排队：共享信令是时间敏感的，把一条旧 offer 排在断线
 * 重连之后发出去比丢掉它更糟。失败由服务端的 `share.error` 回报。
 *
 * 下行做严格解码：未知 `t` / 未知字段一律丢弃并记一次告警——服务端已经
 * 用同一份严格规则，出现解码失败说明两端版本不一致，静默吞掉会变成
 * 「观众一直转圈但没有任何日志」。
 */
import type { Socket } from 'socket.io-client'
import {
  SHARE_EVENT,
  decodeServerMessageOrNull,
  encodeClientMessage,
} from '../protocol/codec'
import type { ShareClientMessage, ShareServerMessage } from '../protocol/types'

export type ShareMessageHandler = (message: ShareServerMessage) => void

export class ShareClient {
  private readonly socket: Socket
  private readonly roomId: string
  private readonly handlers = new Set<ShareMessageHandler>()
  private readonly listener: (raw: unknown) => void

  constructor(socket: Socket, roomId: string) {
    this.socket = socket
    this.roomId = roomId
    this.listener = (raw: unknown) => {
      const message = decodeServerMessageOrNull(raw)
      if (!message) {
        console.warn('[share] 丢弃无法解码的下行消息', raw)
        return
      }
      // 一条连接可能同时在多个房间（评论独立窗口会 join 额外房间），
      // 房间不匹配的消息必须过滤掉，否则两个房间的快照会互相覆盖。
      if (message.roomId && message.roomId !== this.roomId) return
      for (const handler of this.handlers) handler(message)
    }
    this.socket.on(SHARE_EVENT, this.listener)
  }

  get id(): string {
    return this.socket.id ?? ''
  }

  get connected(): boolean {
    return this.socket.connected
  }

  send(message: ShareClientMessage): boolean {
    if (!this.socket.connected) return false
    this.socket.emit(SHARE_EVENT, encodeClientMessage(message))
    return true
  }

  /** 订阅下行消息，返回退订函数。 */
  subscribe(handler: ShareMessageHandler): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  hello(shareGeneration?: string): boolean {
    return this.send({
      t: 'share.hello',
      roomId: this.roomId,
      ...(shareGeneration ? { shareGeneration } : {}),
    })
  }

  dispose(): void {
    this.handlers.clear()
    this.socket.off(SHARE_EVENT, this.listener)
  }
}
