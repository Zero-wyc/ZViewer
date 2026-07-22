/**
 * OBS 推流模式（stream-push）相关 DTO。
 */

/** update-share-method 事件 payload */
export interface UpdateShareMethodPayload {
  roomId: string;
  shareMethod: 'webrtc' | 'stream-push';
}

/** share-method-changed 事件 payload（服务端广播） */
export interface ShareMethodChangedPayload {
  roomId: string;
  shareMethod: 'webrtc' | 'stream-push';
}

/** stream-status 事件 payload（NMS 广播） */
export interface StreamStatusPayload {
  roomId: string;
  status: 'live' | 'offline';
}

/** 推流状态 */
export type StreamStatus = 'live' | 'offline';

/**
 * NMS 推流流名校验结果。
 * - valid: 推流合法，roomId 为有效房间
 * - invalid: 推流不合法（房间不存在/状态不对/子模式不对）
 */
export interface PublishValidationResult {
  valid: boolean;
  roomId: string | null;
}
