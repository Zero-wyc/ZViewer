import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import cors from 'cors';
import { customAlphabet } from 'nanoid';
import bcrypt from 'bcryptjs';
import { IsNull, LessThan } from 'typeorm';
import { AppDataSource } from './data-source';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { SystemSettings } from './entities/SystemSettings';
import { Movie as MovieEntity } from './entities/Movie';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import streamRoutes from './routes/stream';
import danmakuRoutes from './routes/danmaku';
import animeSourcesRoutes from './routes/animeSources';
import userMountsRoutes from './routes/userMounts';
import { createRoomsRouter } from './routes/rooms';
import { verifyAccessToken } from './middleware/auth';

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

interface Movie {
  id: string;
  sourceType: 'bilibili' | 'mp4' | 'webdav' | 'ftp' | 'openlist' | 'smb';
  title: string;
  url: string;
  cid?: number;
  duration?: number;
  videoUrl?: string;
  audioUrl?: string;
  videoCodec?: string;
  audioCodec?: string;
  format?: 'dash' | 'mp4';
  quality?: string;
  createdAt: number;
}

interface BiliCompatState {
  currentTime: number;
  paused: boolean;
  url: string;
  bvid: string | null;
  lastUpdate: number;
}

interface BiliCompatViewerState {
  currentTime: number;
  lastUpdate: number;
}

interface RoomRuntimeState {
  movies: Movie[];
  currentMovieId: string | null;
  biliCompatState?: BiliCompatState;
  biliCompatViewerStates?: Map<string, BiliCompatViewerState>;
}

const roomStates = new Map<string, RoomRuntimeState>();

// 房主断线后允许的恢复窗口，避免刷新页面直接关闭房间
const HOST_RECONNECT_GRACE_MS = 10_000;
const hostReconnectTimers = new Map<string, NodeJS.Timeout>();

// B站兼容模式：5 秒周期同步检查 + 3 秒偏差阈值
const BILI_COMPAT_SYNC_INTERVAL_MS = 5_000;
const BILI_COMPAT_DRIFT_THRESHOLD_SEC = 3;
// 观众状态超过此时间未上报，则不计入同步检查
const BILI_COMPAT_VIEWER_STALE_MS = 15_000;
const biliCompatSyncTimers = new Map<string, NodeJS.Timeout>();

function getRoomState(roomId: string): RoomRuntimeState {
  if (!roomStates.has(roomId)) {
    roomStates.set(roomId, { movies: [], currentMovieId: null });
  }
  return roomStates.get(roomId)!;
}

function stopBiliCompatSyncTimer(roomId: string) {
  const timer = biliCompatSyncTimers.get(roomId);
  if (timer) {
    clearInterval(timer);
    biliCompatSyncTimers.delete(roomId);
  }
}

function startBiliCompatSyncTimer(io: SocketIOServer, roomId: string) {
  stopBiliCompatSyncTimer(roomId);
  const timer = setInterval(() => {
    void checkBiliCompatSync(io, roomId);
  }, BILI_COMPAT_SYNC_INTERVAL_MS);
  biliCompatSyncTimers.set(roomId, timer);
}

function checkBiliCompatSync(io: SocketIOServer, roomId: string) {
  const state = roomStates.get(roomId);
  if (!state?.biliCompatState) return;
  const hostState = state.biliCompatState;
  const viewers = state.biliCompatViewerStates;
  if (!viewers || viewers.size === 0) return;

  const now = Date.now();
  const elapsedSec = hostState.paused
    ? 0
    : (now - hostState.lastUpdate) / 1000;
  const expectedHostTime = hostState.currentTime + elapsedSec;

  for (const [socketId, viewerState] of viewers) {
    if (now - viewerState.lastUpdate > BILI_COMPAT_VIEWER_STALE_MS) continue;
    const drift = Math.abs(viewerState.currentTime - expectedHostTime);
    if (drift > BILI_COMPAT_DRIFT_THRESHOLD_SEC) {
      io.to(socketId).emit('bili-compat-seek', {
        currentTime: expectedHostTime,
        paused: hostState.paused,
      });
    }
  }
}

function clearBiliCompatState(roomId: string) {
  stopBiliCompatSyncTimer(roomId);
  const state = roomStates.get(roomId);
  if (state) {
    state.biliCompatState = undefined;
    state.biliCompatViewerStates = undefined;
  }
}

function deleteRoomState(roomId: string) {
  stopBiliCompatSyncTimer(roomId);
  roomStates.delete(roomId);
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
  const commentRepo = AppDataSource.getRepository(Comment);

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
      role: 'admin',
    });
    await userRepo.save(root);
    console.log('Default admin user created: root / root');
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

async function closeRoomAndNotify(
  io: SocketIOServer,
  roomId: string,
  sharerSocketId: string,
) {
  const roomRepo = getRoomRepository();
  const sessionRepo = getSessionRepository();

  await roomRepo.update({ roomId }, { status: 'closed' });
  await sessionRepo.update(
    { roomId, role: 'sharer', endedAt: IsNull() },
    { endedAt: new Date() },
  );

  io.to(roomId).emit('room-closed', { roomId });
  deleteRoomState(roomId);

  const sockets = await io.in(roomId).fetchSockets();
  for (const sock of sockets) {
    if (sock.id !== sharerSocketId) {
      sock.leave(roomId);
      sock.disconnect(true);
    }
  }
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
  app.use('/api/users/mounts', userMountsRoutes);

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
      next();
    } catch (err) {
      next(new Error('认证令牌无效或已过期'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on(
      'create-room',
      async (
        payload: { name?: string; password?: string; maxViewers?: number; requireApproval?: boolean; mode?: 'screen-share' | 'watch-together' | 'bili-compat' },
        callback: (response: { success: boolean; roomId?: string; mode?: 'screen-share' | 'watch-together' | 'bili-compat'; message?: string }) => void,
      ) => {
        try {
          if (socket.data.role !== 'admin') {
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
      'register-host',
      async (
        payload: { roomId: string },
        callback: (response: { success: boolean; message?: string; mode?: 'screen-share' | 'watch-together' | 'bili-compat'; name?: string | null }) => void,
      ) => {
        try {
          if (socket.data.role !== 'admin') {
            return callback({ success: false, message: '无权限：仅管理员可注册为房主' });
          }

          const roomRepo = getRoomRepository();
          const sessionRepo = getSessionRepository();
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });

          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }
          if (room.status !== 'active') {
            return callback({ success: false, message: '房间已关闭' });
          }

          // 取消可能存在的关闭房间定时器
          const timer = hostReconnectTimers.get(payload.roomId);
          if (timer) {
            clearTimeout(timer);
            hostReconnectTimers.delete(payload.roomId);
          }

          const existingSharer = await sessionRepo.findOne({
            where: { roomId: payload.roomId, role: 'sharer' },
            order: { startedAt: 'DESC' },
          });

          if (existingSharer) {
            existingSharer.socketId = socket.id;
            existingSharer.endedAt = null;
            await sessionRepo.save(existingSharer);
          } else {
            const sharerSession = sessionRepo.create({
              roomId: payload.roomId,
              socketId: socket.id,
              role: 'sharer',
            });
            await sessionRepo.save(sharerSession);
          }

          await roomRepo.update(
            { roomId: payload.roomId },
            { lastAccessedAt: new Date() },
          );

          socket.join(payload.roomId);
          callback({ success: true, mode: room.mode, name: room.name });
        } catch (err) {
          console.error('register-host error:', err);
          callback({ success: false, message: '恢复房主身份失败' });
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
          if (socket.data.role !== 'admin') {
            return callback({ success: false, message: '无权限：仅管理员可修改房间名称' });
          }

          const roomRepo = getRoomRepository();
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback({ success: false, message: '房间不存在' });
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

    socket.on(
      'request-join',
      async (
        payload: { roomId: string; password?: string },
        callback: (response: { success: boolean; message?: string; mode?: 'screen-share' | 'watch-together' | 'bili-compat' }) => void,
      ) => {
        try {
          const roomRepo = getRoomRepository();
          const sessionRepo = getSessionRepository();
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });

          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }
          if (room.status !== 'active') {
            return callback({ success: false, message: '房间已关闭' });
          }
          if (room.password && room.password !== (payload.password ?? '')) {
            return callback({ success: false, message: '密码错误' });
          }

          const viewerCount = await sessionRepo.count({
            where: { roomId: payload.roomId, role: 'viewer', endedAt: IsNull() },
          });
          if (viewerCount >= room.maxViewers) {
            return callback({ success: false, message: '房间观看人数已达上限' });
          }

          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '分享端不在线' });
          }

          if (room.requireApproval === false) {
            socket.join(payload.roomId);

            const viewerSession = sessionRepo.create({
              roomId: payload.roomId,
              socketId: socket.id,
              role: 'viewer',
            });
            await sessionRepo.save(viewerSession);
            await roomRepo.update(
              { roomId: payload.roomId },
              { lastAccessedAt: new Date() },
            );

            io.to(socket.id).emit('join-approved', {
              roomId: payload.roomId,
              mode: room.mode,
              name: room.name,
            });

            const roomState = getRoomState(payload.roomId);
            io.to(socket.id).emit('movie-list', { movies: roomState.movies });
            io.to(socket.id).emit('current-movie', { movieId: roomState.currentMovieId });

            io.to(sharer.socketId).emit('viewer-joined', {
              viewerSocketId: socket.id,
            });
            return callback({ success: true, message: '已加入房间', mode: room.mode });
          }

          io.to(sharer.socketId).emit('join-request', {
            viewerSocketId: socket.id,
          });
          callback({ success: true, message: '等待分享端确认', mode: room.mode });
        } catch (err) {
          console.error('request-join error:', err);
          callback({ success: false, message: '加入房间失败' });
        }
      },
    );

    socket.on(
      'approve-join',
      async (
        payload: { viewerSocketId: string },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const roomRepo = getRoomRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '无权限确认' });
          }

          const viewerSocket = io.sockets.sockets.get(payload.viewerSocketId);
          if (!viewerSocket) {
            return callback({ success: false, message: '观看者已断开连接' });
          }

          const room = await roomRepo.findOneBy({ roomId: sharer.roomId });

          viewerSocket.join(sharer.roomId);

          const viewerSession = sessionRepo.create({
            roomId: sharer.roomId,
            socketId: payload.viewerSocketId,
            role: 'viewer',
          });
          await sessionRepo.save(viewerSession);
          await roomRepo.update(
            { roomId: sharer.roomId },
            { lastAccessedAt: new Date() },
          );

          io.to(payload.viewerSocketId).emit('join-approved', {
            roomId: sharer.roomId,
            mode: room?.mode ?? 'screen-share',
            name: room?.name ?? null,
          });

          const roomState = getRoomState(sharer.roomId);
          io.to(payload.viewerSocketId).emit('movie-list', { movies: roomState.movies });
          io.to(payload.viewerSocketId).emit('current-movie', { movieId: roomState.currentMovieId });

          io.to(sharer.socketId).emit('viewer-joined', {
            viewerSocketId: payload.viewerSocketId,
          });

          callback({ success: true });
        } catch (err) {
          console.error('approve-join error:', err);
          callback({ success: false, message: '确认失败' });
        }
      },
    );

    socket.on(
      'reject-join',
      async (
        payload: { viewerSocketId: string },
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
            return callback({ success: false, message: '无权限拒绝' });
          }

          io.to(payload.viewerSocketId).emit('join-rejected', {
            roomId: sharer.roomId,
          });
          callback({ success: true });
        } catch (err) {
          console.error('reject-join error:', err);
          callback({ success: false, message: '拒绝失败' });
        }
      },
    );

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

    async function isRoomHost(socket: Socket, roomId: string): Promise<boolean> {
      const sessionRepo = getSessionRepository();
      const sharer = await sessionRepo.findOneBy({
        socketId: socket.id,
        roomId,
        role: 'sharer',
        endedAt: IsNull(),
      });
      return !!sharer;
    }

    socket.on(
      'signal-offer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(socket, payload.to);
        if (!roomId) {
          return callback?.({ success: false, message: '不在同一房间' });
        }
        io.to(payload.to).emit('signal-offer', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    socket.on(
      'signal-answer',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(socket, payload.to);
        if (!roomId) {
          return callback?.({ success: false, message: '不在同一房间' });
        }
        io.to(payload.to).emit('signal-answer', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    socket.on(
      'signal-ice-candidate',
      async (
        payload: { to: string; data: unknown },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const roomId = await validateSignalPair(socket, payload.to);
        if (!roomId) {
          return callback?.({ success: false, message: '不在同一房间' });
        }
        io.to(payload.to).emit('signal-ice-candidate', {
          from: socket.id,
          data: payload.data,
        });
        callback?.({ success: true });
      },
    );

    socket.on(
      'viewer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        if (!socket.rooms.has(payload.roomId)) {
          return callback?.({ success: false, message: '不在该房间中' });
        }

        const sessionRepo = getSessionRepository();
        const sharer = await sessionRepo.findOneBy({
          roomId: payload.roomId,
          role: 'sharer',
          endedAt: IsNull(),
        });
        if (!sharer) {
          return callback?.({ success: false, message: '分享端不在线' });
        }

        io.to(sharer.socketId).emit('viewer-ready', {
          from: socket.id,
        });

        const roomState = getRoomState(payload.roomId);
        io.to(socket.id).emit('movie-list', { movies: roomState.movies });
        io.to(socket.id).emit('current-movie', { movieId: roomState.currentMovieId });

        callback?.({ success: true });
      },
    );

    socket.on(
      'watch-together-state',
      async (
        payload: {
          roomId: string;
          state: {
            sourceUrl: string;
            sourceType: 'url' | 'webdav' | 'ftp' | 'openlist' | 'smb' | 'bilibili';
            audioUrl?: string;
            format?: 'mp4' | 'dash';
            videoCodec?: string;
            audioCodec?: string;
            cid?: number;
            isPlaying: boolean;
            currentTime: number;
            playbackRate: number;
            duration?: number;
          };
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback?.({ success: false, message: '无权限同步' });
          }

          socket.to(payload.roomId).emit('watch-together-state', {
            state: payload.state,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('watch-together-state error:', err);
          callback?.({ success: false, message: '同步失败' });
        }
      },
    );

    socket.on(
      'watch-together-control',
      async (
        payload: {
          roomId: string;
          action: 'play' | 'pause' | 'seek' | 'rate';
          value?: number;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback?.({ success: false, message: '无权限控制' });
          }

          socket.to(payload.roomId).emit('watch-together-control', {
            action: payload.action,
            value: payload.value,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('watch-together-control error:', err);
          callback?.({ success: false, message: '控制失败' });
        }
      },
    );

    socket.on(
      'watch-together-request-state',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }
          socket.to(payload.roomId).emit('watch-together-request-state');
          callback?.({ success: true });
        } catch (err) {
          console.error('watch-together-request-state error:', err);
          callback?.({ success: false, message: '请求失败' });
        }
      },
    );

    socket.on(
      'add-movie',
      async (
        payload: { roomId: string; movie: Movie },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (
            socket.data.role !== 'host' &&
            !(await isRoomHost(socket, payload.roomId))
          ) {
            return callback?.({ success: false, message: '无权限添加影片' });
          }

          const movie: Movie = {
            ...payload.movie,
            id: payload.movie.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: payload.movie.createdAt || Date.now(),
          };

          const roomState = getRoomState(payload.roomId);
          if (!roomState.movies.some((m) => m.id === movie.id)) {
            roomState.movies.push(movie);
          }

          io.to(payload.roomId).emit('movie-list', { movies: roomState.movies });
          callback?.({ success: true });
        } catch (err) {
          console.error('add-movie error:', err);
          callback?.({ success: false, message: '添加影片失败' });
        }
      },
    );

    socket.on(
      'remove-movie',
      async (
        payload: { roomId: string; movieId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (
            socket.data.role !== 'host' &&
            !(await isRoomHost(socket, payload.roomId))
          ) {
            return callback?.({ success: false, message: '无权限移除影片' });
          }

          const roomState = getRoomState(payload.roomId);
          roomState.movies = roomState.movies.filter(
            (m) => m.id !== payload.movieId,
          );
          if (roomState.currentMovieId === payload.movieId) {
            roomState.currentMovieId = null;
          }

          io.to(payload.roomId).emit('movie-list', { movies: roomState.movies });
          io.to(payload.roomId).emit('current-movie', {
            movieId: roomState.currentMovieId,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('remove-movie error:', err);
          callback?.({ success: false, message: '移除影片失败' });
        }
      },
    );

    socket.on(
      'play-movie',
      async (
        payload: { roomId: string; movieId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (
            socket.data.role !== 'host' &&
            !(await isRoomHost(socket, payload.roomId))
          ) {
            return callback?.({ success: false, message: '无权限播放影片' });
          }

          const roomState = getRoomState(payload.roomId);
          const movie = roomState.movies.find((m) => m.id === payload.movieId);
          if (!movie) {
            return callback?.({ success: false, message: '影片不存在' });
          }

          roomState.currentMovieId = payload.movieId;
          io.to(payload.roomId).emit('current-movie', {
            movieId: roomState.currentMovieId,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('play-movie error:', err);
          callback?.({ success: false, message: '播放影片失败' });
        }
      },
    );

    socket.on(
      'request-movie-list',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const roomState = getRoomState(payload.roomId);
          socket.emit('movie-list', { movies: roomState.movies });
          callback?.({ success: true });
        } catch (err) {
          console.error('request-movie-list error:', err);
          callback?.({ success: false, message: '获取影片列表失败' });
        }
      },
    );

    socket.on(
      'request-current-movie',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const roomState = getRoomState(payload.roomId);
          socket.emit('current-movie', { movieId: roomState.currentMovieId });
          callback?.({ success: true });
        } catch (err) {
          console.error('request-current-movie error:', err);
          callback?.({ success: false, message: '获取当前影片失败' });
        }
      },
    );

    socket.on(
      'update-room-mode',
      async (
        payload: { roomId: string; mode: 'screen-share' | 'watch-together' | 'bili-compat' },
        callback: (response: { success: boolean; message?: string; mode?: 'screen-share' | 'watch-together' | 'bili-compat' }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const roomRepo = getRoomRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback({ success: false, message: '无权限切换房间模式' });
          }

          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }

          const previousMode = room.mode;
          await roomRepo.update({ roomId: payload.roomId }, { mode: payload.mode });

          // 处理 bili-compat 模式切换：进入时初始化状态并启动同步计时器，离开时清理
          if (payload.mode === 'bili-compat') {
            const roomState = getRoomState(payload.roomId);
            if (!roomState.biliCompatState) {
              roomState.biliCompatState = {
                currentTime: 0,
                paused: true,
                url: '',
                bvid: null,
                lastUpdate: Date.now(),
              };
            }
            if (!roomState.biliCompatViewerStates) {
              roomState.biliCompatViewerStates = new Map();
            }
            startBiliCompatSyncTimer(io, payload.roomId);
          } else if (previousMode === 'bili-compat') {
            clearBiliCompatState(payload.roomId);
          }

          io.to(payload.roomId).emit('room-mode-changed', { mode: payload.mode });
          callback({ success: true, mode: payload.mode });
        } catch (err) {
          console.error('update-room-mode error:', err);
          callback({ success: false, message: '切换房间模式失败' });
        }
      },
    );

    // B站兼容模式：房主上报当前播放状态，服务端存储并广播给房间内其他成员
    socket.on(
      'bili-compat-host-state',
      async (
        payload: {
          roomId: string;
          currentTime: number;
          paused: boolean;
          url: string;
          bvid: string | null;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback?.({ success: false, message: '无权限上报状态' });
          }

          const roomState = getRoomState(payload.roomId);
          roomState.biliCompatState = {
            currentTime: payload.currentTime,
            paused: payload.paused,
            url: payload.url,
            bvid: payload.bvid,
            lastUpdate: Date.now(),
          };
          if (!roomState.biliCompatViewerStates) {
            roomState.biliCompatViewerStates = new Map();
          }

          socket.to(payload.roomId).emit('bili-compat-state', {
            currentTime: payload.currentTime,
            paused: payload.paused,
            url: payload.url,
            bvid: payload.bvid,
          });

          // 启动/重置 5 秒同步检查计时器
          startBiliCompatSyncTimer(io, payload.roomId);
          callback?.({ success: true });
        } catch (err) {
          console.error('bili-compat-host-state error:', err);
          callback?.({ success: false, message: '上报状态失败' });
        }
      },
    );

    // B站兼容模式：观众定期上报自己进度，服务端比对偏差，超过阈值时下发 seek
    socket.on(
      'bili-compat-viewer-state',
      async (
        payload: { roomId: string; currentTime: number },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const roomState = getRoomState(payload.roomId);
          if (!roomState.biliCompatState) {
            return callback?.({ success: false, message: '房主状态未就绪' });
          }

          if (!roomState.biliCompatViewerStates) {
            roomState.biliCompatViewerStates = new Map();
          }
          const now = Date.now();
          roomState.biliCompatViewerStates.set(socket.id, {
            currentTime: payload.currentTime,
            lastUpdate: now,
          });

          const hostState = roomState.biliCompatState;
          const elapsedSec = hostState.paused
            ? 0
            : (now - hostState.lastUpdate) / 1000;
          const expectedHostTime = hostState.currentTime + elapsedSec;
          const drift = Math.abs(payload.currentTime - expectedHostTime);
          if (drift > BILI_COMPAT_DRIFT_THRESHOLD_SEC) {
            io.to(socket.id).emit('bili-compat-seek', {
              currentTime: expectedHostTime,
              paused: hostState.paused,
            });
          }

          callback?.({ success: true });
        } catch (err) {
          console.error('bili-compat-viewer-state error:', err);
          callback?.({ success: false, message: '上报状态失败' });
        }
      },
    );

    // B站兼容模式：房主 seek/pause/play 动作，立即广播给所有观众
    socket.on(
      'bili-compat-host-action',
      async (
        payload: {
          roomId: string;
          action: 'seek' | 'pause' | 'play';
          currentTime: number;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = getSessionRepository();
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            return callback?.({ success: false, message: '无权限发送动作' });
          }

          // 同步更新本地状态，保证后续 viewer-state 比对基于最新动作
          const roomState = getRoomState(payload.roomId);
          if (roomState.biliCompatState) {
            roomState.biliCompatState.currentTime = payload.currentTime;
            roomState.biliCompatState.paused = payload.action === 'pause';
            roomState.biliCompatState.lastUpdate = Date.now();
          }

          socket.to(payload.roomId).emit('bili-compat-action', {
            action: payload.action,
            currentTime: payload.currentTime,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('bili-compat-host-action error:', err);
          callback?.({ success: false, message: '发送动作失败' });
        }
      },
    );

    // B站兼容模式：观众加入或切换模式时请求当前房主状态
    socket.on(
      'bili-compat-join',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const roomState = getRoomState(payload.roomId);
          if (!roomState.biliCompatState) {
            return callback?.({ success: false, message: '房主状态未就绪' });
          }

          const state = roomState.biliCompatState;
          // 根据已播放时长推算当前时间，避免下发陈旧 currentTime
          const now = Date.now();
          const elapsedSec = state.paused
            ? 0
            : (now - state.lastUpdate) / 1000;
          const expectedTime = state.currentTime + elapsedSec;

          io.to(socket.id).emit('bili-compat-state', {
            currentTime: expectedTime,
            paused: state.paused,
            url: state.url,
            bvid: state.bvid,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('bili-compat-join error:', err);
          callback?.({ success: false, message: '加入同步失败' });
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
          if (socket.data.role !== 'admin') {
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

    socket.on('disconnect', async () => {
      console.log(`Socket disconnected: ${socket.id}`);
      try {
        const sessionRepo = getSessionRepository();
        const session = await sessionRepo.findOneBy({
          socketId: socket.id,
          endedAt: IsNull(),
        });
        if (!session) return;

        if (session.role === 'sharer') {
          // 标记 sharer 会话结束并预留重连窗口，期间不直接关闭房间
          await sessionRepo.update(
            { id: session.id },
            { endedAt: new Date() },
          );
          io.to(session.roomId).emit('host-disconnected', {
            roomId: session.roomId,
          });
          const timer = setTimeout(() => {
            hostReconnectTimers.delete(session.roomId);
            void closeRoomAndNotify(io, session.roomId, socket.id);
          }, HOST_RECONNECT_GRACE_MS);
          hostReconnectTimers.set(session.roomId, timer);
        } else {
          await sessionRepo.update(
            { socketId: socket.id, role: 'viewer', endedAt: IsNull() },
            { endedAt: new Date() },
          );
          // 清理 B站兼容模式下的观众状态条目，避免 Map 残留导致下次同步检查误判
          const viewerState = roomStates.get(session.roomId);
          if (viewerState?.biliCompatViewerStates) {
            viewerState.biliCompatViewerStates.delete(socket.id);
          }
          const sharer = await sessionRepo.findOneBy({
            roomId: session.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (sharer) {
            io.to(sharer.socketId).emit('viewer-left', {
              viewerSocketId: socket.id,
            });
          }
        }
      } catch (err) {
        console.error('disconnect handler error:', err);
      }
    });
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
}

bootstrap().catch((err) => {
  console.error('Error during bootstrap:', err);
  process.exit(1);
});
