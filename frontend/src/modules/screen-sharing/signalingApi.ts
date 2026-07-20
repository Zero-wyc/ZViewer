import type { Socket } from 'socket.io-client'
import type {
  ApproveJoinResponse,
  CloseRoomResponse,
  RequestJoinResponse,
} from './types'

/** 房主：转发 WebRTC offer 给观众 */
export function sendSignalOffer(
  socket: Socket,
  to: string,
  data: unknown,
  callback?: (response: { success: boolean; message?: string }) => void
): void {
  socket.emit('signal-offer', { to, data }, callback)
}

/** 观众：转发 WebRTC answer 给房主 */
export function sendSignalAnswer(
  socket: Socket,
  to: string,
  data: unknown,
  callback?: (response: { success: boolean; message?: string }) => void
): void {
  socket.emit('signal-answer', { to, data }, callback)
}

/** 双向：转发 ICE candidate */
export function sendSignalIceCandidate(
  socket: Socket,
  to: string,
  data: unknown,
  callback?: (response: { success: boolean; message?: string }) => void
): void {
  socket.emit('signal-ice-candidate', { to, data }, callback)
}

/** 观众：通知房主已就绪 */
export function sendViewerReady(
  socket: Socket,
  roomId: string,
  callback?: (response: { success: boolean; message?: string }) => void
): void {
  socket.emit('viewer-ready', { roomId }, callback)
}

/** 房主：批准观众加入 */
export function sendApproveJoin(
  socket: Socket,
  viewerSocketId: string,
  callback?: (response: ApproveJoinResponse) => void
): void {
  socket.emit('approve-join', { viewerSocketId }, callback)
}

/** 房主：关闭房间 */
export function sendCloseRoom(
  socket: Socket,
  callback: (response: CloseRoomResponse) => void
): void {
  socket.emit('close-room', callback)
}

/** 观众：请求加入房间 */
export function sendRequestJoin(
  socket: Socket,
  roomId: string,
  password: string,
  callback: (response: RequestJoinResponse) => void
): void {
  socket.emit('request-join', { roomId, password }, callback)
}

/** 房主：清空批注 */
export function sendClearAnnotations(
  socket: Socket,
  roomId: string,
  callback?: (response: { success: boolean; message?: string }) => void
): void {
  socket.emit('clear-annotations', { roomId }, callback)
}
