import type { RoomMode } from '@/store/roomStore'

/** WebRTC 信令 payload 结构（来自后端 signal-* 事件） */
export interface SignalPayload<T> {
  from: string
  data: T
}

/** 观众加入房间状态机 */
export type JoinStatus =
  'idle' | 'joining' | 'approved' | 'rejected' | 'closed' | 'password-required'

/** WebRTC 连接状态 */
export type ConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'

/** request-join 回调响应 */
export interface RequestJoinResponse {
  success: boolean
  message?: string
  mode?: RoomMode
}

/** approve-join 回调响应 */
export interface ApproveJoinResponse {
  success: boolean
  message?: string
}

/** close-room 回调响应 */
export interface CloseRoomResponse {
  success: boolean
  message?: string
}

/** join-approved 事件 payload */
export interface JoinApprovedPayload {
  roomId: string
  name?: string | null
  mode?: RoomMode
}

/** join-rejected 事件 payload */
export interface JoinRejectedPayload {
  roomId: string
}

/** room-closed 事件 payload */
export interface RoomClosedPayload {
  roomId: string
}

/** room-mode-changed 事件 payload */
export interface RoomModeChangedPayload {
  mode: RoomMode
}

/** viewer-joined / viewer-left 事件 payload */
export interface ViewerEventPayload {
  viewerSocketId: string
}

/** viewer-ready 事件 payload（来自后端） */
export interface ViewerReadyPayload {
  from: string
}

/** JoinRoomForm 表单值 */
export interface JoinFormValues {
  roomId: string
  password?: string
  [key: string]: unknown
}
