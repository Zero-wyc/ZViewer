import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import { customAlphabet } from 'nanoid';
import bcrypt from 'bcryptjs';
import { IsNull, LessThan } from 'typeorm';
import { AppDataSource } from './data-source';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User, type UserRole } from './entities/User';
import { Comment } from './entities/Comment';
import { SystemSettings } from './entities/SystemSettings';
import { Movie as MovieEntity } from './entities/Movie';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import streamRoutes from './routes/stream';
import danmakuRoutes from './routes/danmaku';
import animeSourcesRoutes from './routes/animeSources';
import openlistRoutes from './routes/openlist';
import webdavRoutes from './routes/webdav';
import ftpRoutes from './routes/ftp';
import updaterRoutes from './routes/updater';
import streamPushRoutes from './routes/stream-push';
import { createRoomsRouter } from './routes/rooms';
import { registerRoomHandlers } from './routes/room';
import { verifyAccessToken } from './middleware/auth';
import {
  deleteRoomState,
  closeRoomAndNotify,
  hostReconnectTimers,
} from './services/room/state';
import { startNodeMediaServer } from './services/stream-push';

interface AnnotationStroke {
  id: string;
  type: 'pen' | 'text' | 'erase';
  points?: { x: number; y: number }[];
  text?: string;
  color?: string;
  width?: number;
  x?: number;
  y?: number;
}

export async function getSystemSettings(): Promise<SystemSettings> {
  const settingsRepo = AppDataSource.getRepository(SystemSettings);
  let settings = await settingsRepo.findOne({ where: {} });
  if (!settings) {
    settings = settingsRepo.create({
      autoDeleteInactiveRooms: true,
      autoDeleteAfterHours: 24,
    });
    await settingsRepo.save(settings);
  }
  return settings;
}

export async function deleteRoomAndRelations(
  roomId: string,
  io?: SocketIOServer,
): Promise<void> {
  const roomRepo = getRoomRepository();
  const sessionRepo = getSessionRepository();
  const movieRepo = AppDataSource.getRepository(MovieEntity);
  const commentRepo = getCommentRepository();

  // 清理运行时状态
  deleteRoomState(roomId);

  // 结束所有未结束会话
  await sessionRepo.update(
    { roomId, endedAt: IsNull() },
    { endedAt: new Date() },
  );

  // 删除关联数据
  await movieRepo.delete({ roomId });
  await commentRepo.delete({ roomId });

  // 删除房间
  await roomRepo.delete({ roomId });

  // 可选：断开仍在房间内的 socket
  if (io) {
    const sockets = await io.in(roomId).fetchSockets();
    for (const sock of sockets) {
      sock.leave(roomId);
      sock.disconnect(true);
    }
  }
}

async function cleanupInactiveRooms(io: SocketIOServer): Promise<void> {
  try {
    const settings = await getSystemSettings();
    if (!settings.autoDeleteInactiveRooms) {
      console.log('Auto-delete inactive rooms is disabled, skipping cleanup');
      return;
    }

    const threshold = new Date(
      Date.now() - settings.autoDeleteAfterHours * 60 * 60 * 1000,
    );
    const roomRepo = getRoomRepository();
    const rooms = await roomRepo.find({
      where: { status: 'active', lastAccessedAt: LessThan(threshold) },
    });

    for (const room of rooms) {
      await deleteRoomAndRelations(room.roomId, io);
    }

    console.log(`Cleaned up ${rooms.length} inactive rooms`);
  } catch (err) {
    console.error('cleanupInactiveRooms error:', err);
  }
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
// 默认不指定 host，让 Node 同时监听 IPv4 与 IPv6（双栈），避免 Windows 上 '::' 无法接收 IPv4 连接的问题。
const HOST = process.env.HOST || undefined;

function parseCorsOrigin(
  value: string | undefined,
): boolean | string | string[] {
  if (value) {
    if (value === 'false') return false;
    if (value === '*') return '*';
    return value.split(',').map((s) => s.trim());
  }
  return process.env.NODE_ENV === 'production' ? false : '*';
}

const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);
const generateRoomId = customAlphabet(
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  8,
);

function getRoomRepository() {
  return AppDataSource.getRepository(Room);
}

function getSessionRepository() {
  return AppDataSource.getRepository(Session);
}

function getUserRepository() {
  return AppDataSource.getRepository(User);
}

function getCommentRepository() {
  return AppDataSource.getRepository(Comment);
}

async function seedRootAdmin() {
  const userRepo = getUserRepository();
  const existing = await userRepo.findOneBy({ username: 'root' });
  if (!existing) {
    const root = userRepo.create({
      username: 'root',
      passwordHash: bcrypt.hashSync('root', 10),
      role: 'root',
      status: 'active',
    });
    await userRepo.save(root);
    console.log('Default root user created: root / root');
  } else if (existing.role !== 'root') {
    // 迁移旧版管理员为 root
    existing.role = 'root';
    existing.status = 'active';
    await userRepo.save(existing);
    console.log('Existing root user role migrated to root');
  }
}

async function generateUniqueRoomId(): Promise<string> {
  const roomRepo = getRoomRepository();
  let roomId = generateRoomId();
  while (await roomRepo.existsBy({ roomId })) {
    roomId = generateRoomId();
  }
  return roomId;
}

async function bootstrap() {
  await AppDataSource.initialize();
  console.log('TypeORM Data Source has been initialized.');
  await seedRootAdmin();

  const app = express();
  app.use(
    cors({
      origin: CORS_ORIGIN,
    }),
  );
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/stream/danmaku', danmakuRoutes);
  app.use('/api/stream/anime', animeSourcesRoutes);
  app.use('/api/stream', streamRoutes);
  app.use('/api/openlist', openlistRoutes);
  app.use('/api/webdav', webdavRoutes);
  app.use('/api/ftp', ftpRoutes);
  app.use('/api/system/update', updaterRoutes);
  app.use('/api/stream-push', streamPushRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: CORS_ORIGIN,
      methods: ['GET', 'POST'],
    },
  });

  app.use('/api/rooms', createRoomsRouter(io));

  // 周期性自动删除长期无人访问的房间
  setInterval(() => {
    void cleanupInactiveRooms(io);
  }, 60 * 60 * 1000);
  void cleanupInactiveRooms(io);

  io.use((socket, next) => {
    const rawToken =
      socket.handshake.auth.token || socket.handshake.query.token;
    const token = typeof rawToken === 'string' ? rawToken : undefined;

    if (!token) {
      return next(new Error('未提供认证令牌'));
    }

    try {
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.userId;
      socket.data.role = payload.role;
      socket.data.username = payload.username;
      next();
    } catch (err) {
      next(new Error('认证令牌无效或已过期'));
    }
  });

  // 注册所有房间相关 Socket 事件（register-host / request-join / approve-join /
  // reject-join / watch-together-* / add-movie / remove-movie / play-movie /
  // request-movie-list / request-current-movie / update-room-mode /
  // viewer-ready / signal-offer / signal-answer / signal-ice-candidate /
  // disconnect 等），内部维护独立的 connection 处理器
  registerRoomHandlers(io);

  // 启动 Node-Media-Server（RTMP + HTTP-FLV）用于 OBS 推流模式
  // 启动失败不影响主进程运行
  const stopNms = startNodeMediaServer(io);

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on(
      'create-room',
      async (
        payload: { name?: string; password?: string; maxViewers?: number; requireApproval?: boolean; mode?: 'screen-share' | 'watch-together' },
        callback: (response: { success: boolean; roomId?: string; mode?: 'screen-share' | 'watch-together'; message?: string }) => void,
      ) => {
        try {
          const userId: number = socket.data.userId;
          const role: UserRole = socket.data.role;
          if (role !== 'root' && role !== 'admin') {
            return callback({ success: false, message: '无权限：仅管理员可创建房间' });
          }

          const roomRepo = getRoomRepository();
          const sessionRepo = getSessionRepository();
          const roomId = await generateUniqueRoomId();

          const room = roomRepo.create({
            roomId,
            name: payload.name?.trim() || `房间 ${roomId}`,
            password: payload.password ?? null,
            maxViewers: payload.maxViewers ?? 10,
            status: 'active',
            mode: payload.mode ?? 'screen-share',
            requireApproval: payload.requireApproval ?? true,
            ownerUserId: userId || null,
          });
          await roomRepo.save(room);
          await roomRepo.update({ roomId }, { lastAccessedAt: new Date() });

          const session = sessionRepo.create({
            roomId,
            socketId: socket.id,
            role: 'sharer',
          });
          await sessionRepo.save(session);

          socket.join(roomId);
          callback({ success: true, roomId, mode: room.mode });
        } catch (err) {
          console.error('create-room error:', err);
          callback({ success: false, message: '创建房间失败' });
        }
      },
    );

    socket.on(
      'update-room-name',
      async (
        payload: { roomId: string; name: string },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const userId: number = socket.data.userId;
          const role: UserRole = socket.data.role;
          const roomRepo = getRoomRepository();
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }
          if (
            role !== 'root' &&
            !(role === 'admin' && room.ownerUserId === userId)
          ) {
            return callback({ success: false, message: '无权限：仅 root 或房间创建者可修改房间名称' });
          }

          const trimmed = payload.name?.trim();
          if (!trimmed) {
            return callback({ success: false, message: '房间名称不能为空' });
          }

          room.name = trimmed;
          await roomRepo.save(room);

          io.to(payload.roomId).emit('room-name-updated', {
            roomId: payload.roomId,
            name: trimmed,
          });

          callback({ success: true });
        } catch (err) {
          console.error('update-room-name error:', err);
          callback({ success: false, message: '修改房间名称失败' });
        }
      },
    );

    // P2P 直连开关：房主切换 P2P 开关时广播给房间内所有成员，
    // 其他成员的 SharingStatusPanel 收到后同步本地开关状态与共享模式标签。
    socket.on(
      'p2p-mode-change',
      async (
        payload: { roomId: string; enabled: boolean },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }
          socket.to(payload.roomId).emit('p2p-mode-change', {
            roomId: payload.roomId,
            enabled: payload.enabled,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('p2p-mode-change error:', err);
          callback?.({ success: false, message: '广播 P2P 模式失败' });
        }
      },
    );

    socket.on(
      'close-room',
      async (
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '无权限关闭房间' });
          }

          const timer = hostReconnectTimers.get(sharer.roomId);
          if (timer) {
            clearTimeout(timer);
            hostReconnectTimers.delete(sharer.roomId);
          }

          await closeRoomAndNotify(io, sharer.roomId, socket.id);
          socket.leave(sharer.roomId);
          callback({ success: true });
        } catch (err) {
          console.error('close-room error:', err);
          callback({ success: false, message: '关闭房间失败' });
        }
      },
    );

    socket.on(
      'admin-close-room',
      async (
        payload: { roomId: string },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (socket.data.role !== 'admin' && socket.data.role !== 'root') {
            return callback({ success: false, message: '无权限：仅管理员可关闭房间' });
          }

          const roomRepo = getRoomRepository();
          const sessionRepo = getSessionRepository();
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }

          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '分享端不在线' });
          }

          const timer = hostReconnectTimers.get(payload.roomId);
          if (timer) {
            clearTimeout(timer);
            hostReconnectTimers.delete(payload.roomId);
          }

          await closeRoomAndNotify(io, payload.roomId, sharer.socketId);
          callback({ success: true });
        } catch (err) {
          console.error('admin-close-room error:', err);
          callback({ success: false, message: '关闭房间失败' });
        }
      },
    );

    async function getUsername(): Promise<string> {
      if (socket.data.username) {
        return socket.data.username as string;
      }
      const userRepo = getUserRepository();
      const user = await userRepo.findOneBy({ id: socket.data.userId as number });
      const username = user?.username ?? '未知用户';
      socket.data.username = username;
      return username;
    }

    // 检查当前 socket 用户是否被房主禁言。
    // 房主（sharer）自身永不被禁言；观众查询 Room.mutedViewers 是否包含其 userId。
    async function isViewerMuted(roomId: string): Promise<boolean> {
      const userId = socket.data.userId as number | undefined;
      if (!userId) return false;
      const roomRepo = getRoomRepository();
      const room = await roomRepo.findOneBy({ roomId });
      if (!room) return false;
      try {
        const muted: number[] = JSON.parse(room.mutedViewers || '[]');
        return muted.includes(userId);
      } catch {
        return false;
      }
    }

    socket.on(
      'send-comment',
      async (
        payload: { roomId: string; content: string; isDanmaku?: boolean },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback({ success: false, message: '不在该房间中' });
          }

          const content = typeof payload.content === 'string' ? payload.content.trim() : '';
          if (!content) {
            return callback({ success: false, message: '评论内容不能为空' });
          }

          // 禁言校验：被房主禁言的观众不能发送评论
          if (await isViewerMuted(payload.roomId)) {
            return callback({ success: false, message: '您已被房主禁言' });
          }

          const commentRepo = getCommentRepository();
          const username = await getUsername();
          const comment = commentRepo.create({
            roomId: payload.roomId,
            username,
            content,
            isDanmaku: payload.isDanmaku ?? false,
          });
          await commentRepo.save(comment);

          io.to(payload.roomId).emit('new-comment', {
            id: comment.id,
            roomId: comment.roomId,
            username: comment.username,
            content: comment.content,
            isDanmaku: comment.isDanmaku,
            createdAt: comment.createdAt.toISOString(),
          });

          callback({ success: true });
        } catch (err) {
          console.error('send-comment error:', err);
          callback({ success: false, message: '发送评论失败' });
        }
      },
    );

    socket.on(
      'comment-history',
      async (
        payload: { roomId: string },
        callback: (response: {
          success: boolean;
          comments?: Array<{
            id: number;
            roomId: string;
            username: string;
            content: string;
            isDanmaku: boolean;
            createdAt: string;
          }>;
          message?: string;
        }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback({ success: false, message: '不在该房间中' });
          }

          const commentRepo = getCommentRepository();
          const comments = await commentRepo.find({
            where: { roomId: payload.roomId },
            order: { createdAt: 'ASC' },
          });

          callback({
            success: true,
            comments: comments.map((c) => ({
              id: c.id,
              roomId: c.roomId,
              username: c.username,
              content: c.content,
              isDanmaku: c.isDanmaku,
              createdAt: c.createdAt.toISOString(),
            })),
          });
        } catch (err) {
          console.error('comment-history error:', err);
          callback({ success: false, message: '获取评论历史失败' });
        }
      },
    );

    socket.on(
      'send-danmaku',
      async (
        payload: { roomId: string; content: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const content = typeof payload.content === 'string' ? payload.content.trim() : '';
          if (!content) {
            return callback?.({ success: false, message: '弹幕内容不能为空' });
          }

          // 禁言校验：被房主禁言的观众不能发送弹幕
          if (await isViewerMuted(payload.roomId)) {
            return callback?.({ success: false, message: '您已被房主禁言' });
          }

          const username = await getUsername();
          io.to(payload.roomId).emit('danmaku', {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            text: content,
            sender: username,
          });

          callback?.({ success: true });
        } catch (err) {
          console.error('send-danmaku error:', err);
          callback?.({ success: false, message: '发送弹幕失败' });
        }
      },
    );

    socket.on(
      'annotation-stroke',
      async (
        payload: { roomId: string; stroke: AnnotationStroke },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          io.to(payload.roomId).emit('annotation-stroke', {
            stroke: payload.stroke,
            senderId: socket.id,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('annotation-stroke error:', err);
          callback?.({ success: false, message: '同步批注失败' });
        }
      },
    );

    socket.on(
      'clear-annotations',
      async (
        payload: { roomId: string },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback({ success: false, message: '无权限清空批注' });
          }

          io.to(payload.roomId).emit('clear-annotations');
          callback({ success: true });
        } catch (err) {
          console.error('clear-annotations error:', err);
          callback({ success: false, message: '清空批注失败' });
        }
      },
    );
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 已被占用，请先结束占用该端口的进程后再启动后端。`);
    } else {
      console.error('HTTP server error:', err);
    }
    process.exit(1);
  });

  const listenOptions: { port: number; host?: string } = { port: PORT };
  if (HOST) {
    listenOptions.host = HOST;
  }

  httpServer.listen(listenOptions, () => {
    const displayHost = HOST === '::' ? '[::]' : HOST ?? '*';
    console.log(`Server is running on http://${displayHost}:${PORT}`);
  });

  // 主进程退出时停止 NMS
  const gracefulShutdown = () => {
    try {
      stopNms();
    } catch (err) {
      console.error('[NMS] graceful shutdown error:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);
}

bootstrap().catch((err) => {
  console.error('Error during bootstrap:', err);
  process.exit(1);
});
