import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
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
import anisubsRoutes from './routes/anisubs';
import kazumiRoutes from './routes/kazumi';
import openlistRoutes from './routes/openlist';
import webdavRoutes from './routes/webdav';
import ftpRoutes from './routes/ftp';
import updaterRoutes from './routes/updater';
import { createRoomsRouter } from './routes/rooms';
import { verifyAccessToken } from './middleware/auth';
// 屏幕共享子模块保持原有注册方式（内部自管理 io.on('connection')）
import { registerScreenSharingHandlers } from './services/screen-sharing';

// 新模块化架构
import { SocketRegistry } from './modules/socket';
import {
  RoomLifecycleHandler,
  RoomSettingsHandler,
  RoomDisconnectHandler,
  RegisterHostHandler,
  roomStateService,
} from './modules/room';
import {
  ViewerJoinHandler,
  ViewerManagementHandler,
} from './modules/viewer';
import {
  MovieListHandler,
  PreviewHandler,
  createMovieRouter,
} from './modules/movie';
import {
  HeartbeatHandler,
  TrackSyncHandler,
  SeekApprovalHandler,
} from './modules/sync-playback';
import {
  PlaybackMemoryHandler,
  playbackBroadcasterService,
} from './modules/playback-memory';
import { CommentHandler } from './modules/comment';
import { nmsService, StreamPushHandler, streamPushRouter } from './modules/stream-push';

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
  const roomRepo = AppDataSource.getRepository(Room);
  const sessionRepo = AppDataSource.getRepository(Session);
  const movieRepo = AppDataSource.getRepository(MovieEntity);
  const commentRepo = AppDataSource.getRepository(Comment);

  // 清理运行时状态（通过 RoomStateService 而非直接操作全局 Map）
  roomStateService.delete(roomId);

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
    const roomRepo = AppDataSource.getRepository(Room);
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

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3333;
// 默认不指定 host，让 Node 同时监听 IPv4 与 IPv6（双栈），避免 Windows 上 '::' 无法接收 IPv4 连接的问题。
const HOST = process.env.HOST || undefined;

function parseCorsOrigin(
  value: string | undefined,
): boolean | string | string[] {
  if (value) {
    if (value === 'false') return false;
    // 注意：CORS 规范要求 credentials: true 时 origin 不能为 '*'，需要返回 true 让 socket.io/express 反射请求 Origin
    if (value === '*') return true;
    return value.split(',').map((s) => s.trim());
  }
  // 开发环境默认允许所有来源（反射 Origin），生产环境未配置则禁止跨域
  return process.env.NODE_ENV === 'production' ? false : true;
}

const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);

async function seedRootAdmin() {
  const userRepo = AppDataSource.getRepository(User);
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

async function bootstrap() {
  await AppDataSource.initialize();
  console.log('TypeORM Data Source has been initialized.');
  await seedRootAdmin();

  const app = express();
  app.use(
    cors({
      origin: CORS_ORIGIN,
      credentials: true,
      // 暴露 Content-Range / Accept-Ranges 给前端，用于媒体代理的断点续传
      exposedHeaders: ['Content-Range', 'Accept-Ranges'],
    }),
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/stream/danmaku', danmakuRoutes);
  app.use('/api/stream/anime', animeSourcesRoutes);
  app.use('/api/stream/anisubs', anisubsRoutes);
  app.use('/api/stream/kazumi', kazumiRoutes);
  app.use('/api/stream', streamRoutes);
  app.use('/api/openlist', openlistRoutes);
  app.use('/api/webdav', webdavRoutes);
  app.use('/api/ftp', ftpRoutes);
  app.use('/api/system/update', updaterRoutes);
  app.use('/api/stream-push', streamPushRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: CORS_ORIGIN,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  app.use('/api/rooms', createRoomsRouter(io));

  // 周期性自动删除长期无人访问的房间
  setInterval(() => {
    void cleanupInactiveRooms(io);
  }, 60 * 60 * 1000);
  void cleanupInactiveRooms(io);

  io.use((socket, next) => {
    // 优先从 handshake.headers.cookie 读取 access_token（httpOnly cookie）
    // 兼容旧 auth.token / query.token 字段以支持过渡期客户端
    const cookieHeader = socket.handshake.headers.cookie;
    let token: string | undefined;

    if (cookieHeader) {
      // 简单解析 cookie 字符串，避免引入额外依赖
      const cookies = Object.fromEntries(
        cookieHeader.split(';').map((c) => {
          const [k, ...v] = c.trim().split('=');
          return [k, decodeURIComponent(v.join('='))];
        }),
      );
      token = cookies.access_token;
    }

    // 退化路径：客户端在 auth.token 显式带 token（旧版前端兼容）
    if (!token) {
      const rawToken =
        socket.handshake.auth.token || socket.handshake.query.token;
      token = typeof rawToken === 'string' ? rawToken : undefined;
    }

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

  // 屏幕共享子模块保持原有注册方式（内部自管理 io.on('connection')）
  registerScreenSharingHandlers(io);

  // 启动 Node-Media-Server（RTMP + HTTP-FLV）用于 OBS 推流模式
  // 启动失败不影响主进程运行
  const stopNms = nmsService.start(io);

  // 新模块化架构：通过 SocketRegistry 统一注册所有 socket 事件处理器
  // 消除旧架构中 index.ts 与 room.ts 两个 io.on('connection') 注册点的分裂
  const socketRegistry = new SocketRegistry();
  socketRegistry
    .add(new RoomLifecycleHandler())
    .add(new RoomSettingsHandler())
    .add(new RoomDisconnectHandler())
    .add(new RegisterHostHandler())
    .add(new ViewerJoinHandler())
    .add(new ViewerManagementHandler())
    .add(new MovieListHandler())
    .add(new PreviewHandler())
    // PlaybackMemoryHandler 取代旧 SyncStateHandler + SyncControlHandler
    // 统一处理 watch-together-state / watch-together-request-state / watch-together-control
    // 并将状态持久化到 DB，支持房主断开后观众继续观看
    .add(new PlaybackMemoryHandler())
    .add(new HeartbeatHandler())
    .add(new TrackSyncHandler())
    .add(new SeekApprovalHandler())
    .add(new CommentHandler())
    .add(new StreamPushHandler());

  // 挂载新模块的 REST 路由
  app.use('/api/rooms', createMovieRouter(io));

  // 启动播放记忆定时广播服务（房主断开期间由服务器接管广播）
  playbackBroadcasterService.start(io);

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);
    socketRegistry.registerAll(socket, io);
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
