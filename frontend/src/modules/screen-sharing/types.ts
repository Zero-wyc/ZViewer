import type { RoomMode } from '@/store/roomStore'

/** 观众加入房间状态机 */
export type JoinStatus =
  'idle' | 'joining' | 'approved' | 'rejected' | 'closed' | 'password-required'

/** request-join 回调响应（AckResponse 标准格式：业务数据在 data 字段内） */
export interface RequestJoinResponse {
  success: boolean
  message?: string
  /** 错误码（如 ALREADY_IN_ROOM：同一账户已在房间内） */
  code?: string
  data?: {
    mode?: RoomMode
    shareMethod?: 'webrtc' | 'stream-push'
    /** OBS 推流密钥（stream-push 子模式专用） */
    streamKey?: string | null
    /** 后端检测到当前用户是房间 owner，自动恢复了房主身份 */
    isHost?: boolean
  }
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
  /** 投屏子模式（screen-share 模式下使用） */
  shareMethod?: 'webrtc' | 'stream-push'
  /** OBS 推流密钥（stream-push 子模式专用） */
  streamKey?: string | null
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

/** JoinRoomForm 表单值 */
export interface JoinFormValues {
  roomId: string
  password?: string
  [key: string]: unknown
}
