import { Server as SocketIOServer } from 'socket.io';
import { registerSignalingHandlers } from './signaling';
import { registerViewerEventHandlers } from './viewer-events';

// 统一注册投屏相关（WebRTC 信令 + 观众就绪）事件处理器
export function registerScreenSharingHandlers(io: SocketIOServer): void {
  registerSignalingHandlers(io);
  registerViewerEventHandlers(io);
}
