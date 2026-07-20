import { Server as SocketIOServer, Socket } from 'socket.io';

// 注册 WebRTC 信令转发相关的事件处理器
// 内部注册 io.on('connection', ...)，所有信令事件均在该处理器内注册
export function registerSignalingHandlers(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    // --- WebRTC 信令配对校验：确保双方处于同一房间 ---
    async function validateSignalPair(
      fromSocket: Socket,
      toSocketId: string,
    ): Promise<string | null> {
      const toSocket = io.sockets.sockets.get(toSocketId);
      if (!toSocket) return null;

      const fromRooms = new Set(fromSocket.rooms);
      for (const room of toSocket.rooms) {
        if (room !== toSocket.id && fromRooms.has(room)) {
          return room;
        }
      }
      return null;
    }

    // --- WebRTC 信令：转发 offer ---
    socket.on(
      'signal-offer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(socket, payload.to);
        if (!roomId) {
          console.warn(
            `[signal-offer] pair validation failed from=${socket.id} to=${payload.to}`,
          );
          return callback?.({ success: false, message: '不在同一房间' });
        }
        console.log(
          `[signal-offer] relay from=${socket.id} to=${payload.to} room=${roomId}`,
        );
        io.to(payload.to).emit('signal-offer', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    // --- WebRTC 信令：转发 answer ---
    socket.on(
      'signal-answer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(socket, payload.to);
        if (!roomId) {
          console.warn(
            `[signal-answer] pair validation failed from=${socket.id} to=${payload.to}`,
          );
          return callback?.({ success: false, message: '不在同一房间' });
        }
        console.log(
          `[signal-answer] relay from=${socket.id} to=${payload.to} room=${roomId}`,
        );
        io.to(payload.to).emit('signal-answer', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    // --- WebRTC 信令：转发 ICE candidate ---
    socket.on(
      'signal-ice-candidate',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(socket, payload.to);
        if (!roomId) {
          console.warn(
            `[signal-ice-candidate] pair validation failed from=${socket.id} to=${payload.to}`,
          );
          return callback?.({ success: false, message: '不在同一房间' });
        }
        io.to(payload.to).emit('signal-ice-candidate', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );
  });
}
