import 'reflect-metadata';
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { IsNull, LessThan } from 'typeorm';
import { AppDataSource } from './data-source';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { SystemSettings } from './entities/SystemSettings';
import { Movie as MovieEntity } from './entities/Movie';
import { PlaybackState } from './entities/PlaybackState';
import { PROJECT_ROOT } from './services/paths';
import { proxyHttpUpstream } from './services/proxy/http-proxy';
import authRoutes from './routes/auth';
import adminRoutes from './routes/admin';
import streamRoutes from './routes/stream';
import danmakuRoutes from './routes/danmaku';
import animeSourcesRoutes from './routes/animeSources';
import anisubsRoutes from './routes/anisubs';
import kazumiRoutes from './routes/kazumi';
import serverFilesRoutes from './routes/serverFiles';
import { createMountRouter } from './routes/webdav';
import openlistRoutes from './routes/openlist';
import ftpRoutes from './routes/ftp';
import embyRoutes from './routes/emby';
import jellyfinRoutes from './routes/jellyfin';
import subtitlesRoutes from './routes/subtitles';
import updaterRoutes from './routes/updater';
import statsRoutes from './routes/stats';
import clientLogsRoutes from './routes/client-logs';
import cliRoutes from './routes/cli';
import { createRoomsRouter } from './routes/rooms';
import { verifyAccessToken } from './middleware/auth';

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
  SubtitleSyncHandler,
} from './modules/sync-playback';
import {
  PlaybackMemoryHandler,
  playbackBroadcasterService,
  playbackMemoryService,
} from './modules/playback-memory';
import { CommentHandler } from './modules/comment';
import { CliHandler } from './modules/cli';
import { nmsService, StreamPushHandler, streamPushRouter } from './modules/stream-push';
import { SignalingHandler, ViewerEventsHandler } from './modules/webrtc-signaling';
import { VoiceChatHandler } from './modules/voice-chat';
import { ensureUploadsRoot } from './services/server-files/pathResolver';
import {
  AVATARS_DIR,
  ensureDataDirs,
  migrateLegacyDataIfNeeded,
} from './services/paths';
// getSystemSettings 抽到独立服务文件，避免子模块从根 index.ts 导入造成循环依赖。
import { getSystemSettings } from './services/system-settings';
export { getSystemSettings };

export async function deleteRoomAndRelations(
  roomId: string,
  io?: SocketIOServer,
): Promise<void> {
  const roomRepo = AppDataSource.getRepository(Room);
  const sessionRepo = AppDataSource.getRepository(Session);
  const movieRepo = AppDataSource.getRepository(MovieEntity);
  const commentRepo = AppDataSource.getRepository(Comment);
  const playbackStateRepo = AppDataSource.getRepository(PlaybackState);

  // 清理运行时状态（通过 RoomStateService 而非直接操作全局 Map）
  roomStateService.delete(roomId);

  // 结束所有未结束会话
  await sessionRepo.update(
    { roomId, endedAt: IsNull() },
    { endedAt: new Date() },
  );

  // 删除关联数据
  // 注意删除顺序：PlaybackState 通过外键引用 Room，必须在删除 Room 之前清除，
  // 否则 SQLite 会抛 FOREIGN KEY constraint failed（Movie/Comment 无外键约束不敏感）
  await movieRepo.delete({ roomId });
  await commentRepo.delete({ roomId });
  await playbackStateRepo.delete({ roomId });

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

// 进程启动时间戳与重启次数（由 supervisor 通过 RESTART_COUNT 环境变量传入）。
// 前端通过 /health 对比 startedAt 判断后端是否已自动重启，并在网页内提示。
const PROCESS_STARTED_AT = Date.now();
const RESTART_COUNT = parseInt(process.env.RESTART_COUNT || '0', 10);

function parseCorsOrigin(
  value: string | undefined,
): boolean | string | string[] {
  if (value) {
    if (value === 'false') return false;
    // 注意：CORS 规范要求 credentials: true 时 origin 不能为 '*'，需要返回 true 让 socket.io/express 反射请求 Origin
    if (value === '*') return true;
    return value.split(',').map((s) => s.trim());
  }
  // 默认允许所有来源（反射 Origin），兼容 localhost / 127.0.0.1 / 内网 IP / 公网域名访问。
  // 公网部署时建议显式设置 CORS_ORIGIN 为具体域名，避免开放跨域。
  return true;
}

const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);

async function seedRootAdmin() {
  const userRepo = AppDataSource.getRepository(User);
  // 通过 role 查找而非 username 查找，避免 root 用户改名后服务器重启
  // 时重新创建默认 root 账户，导致出现两个超级管理员。
  const existingRoot = await userRepo.findOneBy({ role: 'root' });
  if (!existingRoot) {
    // 也没有 username='root' 的用户（首次启动或全新数据库），创建默认 root
    const existingByName = await userRepo.findOneBy({ username: 'root' });
    if (!existingByName) {
      const root = userRepo.create({
        username: 'root',
        passwordHash: bcrypt.hashSync('root', 10),
        role: 'root',
        status: 'active',
      });
      await userRepo.save(root);
      console.log('Default root user created: root / root');
    } else if (existingByName.role !== 'root') {
      // 迁移旧版管理员为 root
      existingByName.role = 'root';
      existingByName.status = 'active';
      await userRepo.save(existingByName);
      console.log('Existing root user role migrated to root');
    }
  }
  // 已存在 role='root' 的用户（可能是改过名的 root），不重新创建
}

async function bootstrap() {
  // 数据目录迁移与初始化：必须在 DataSource.initialize 之前完成，
  // 否则 SQLite 会在旧路径创建空库，导致迁移逻辑误判。
  migrateLegacyDataIfNeeded();
  ensureDataDirs();

  await AppDataSource.initialize();
  console.log('TypeORM Data Source has been initialized.');
  await seedRootAdmin();
  ensureUploadsRoot();

  // P3-Opt#13：从 DB 恢复所有活跃房间的运行时状态（movies、currentMovieId、播放记忆）
  await roomStateService.initFromDb();

  // 头像目录已在 ensureDataDirs() 中创建（config/uploads/avatars），
  // 此处保留防御性检查以兼容旧版手动部署场景
  if (!fs.existsSync(AVATARS_DIR)) {
    fs.mkdirSync(AVATARS_DIR, { recursive: true });
  }

  const app = express();
  // 信任反向代理头（X-Forwarded-Proto / X-Forwarded-For）：
  // - req.secure / req.protocol / req.ip 才能反映真实客户端协议
  // - cookie 的 secure 属性才能根据真实协议动态决定（HTTP 下不强制 Secure）
  // 信任所有私有网络范围（含 Docker 172.x.x.x / 10.x.x.x / 192.168.x.x），
  // 确保 Nginx/Caddy 反向代理后 req.protocol 能正确反映 HTTPS。
  // 公网部署时建议改为具体代理 IP 以提高安全性。
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal', '172.16.0.0/12', '10.0.0.0/8', '192.168.0.0/16']);
  app.use(
    cors({
      origin: CORS_ORIGIN,
      credentials: true,
      // 暴露 Content-Range / Accept-Ranges 给前端，用于媒体代理的断点续传
      exposedHeaders: ['Content-Range', 'Accept-Ranges'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // 轻量请求流量日志：记录所有 /api/ 请求的方法、路径、状态码、响应大小、耗时
  // 用于排查带宽来源（区分代理流量 /api/stream/proxy vs 解析流量 /api/stream/resolve-bilibili）
  app.use((req, res, next) => {
    // 跳过健康检查和静态资源，减少噪音
    if (req.path === '/health' || req.path.startsWith('/uploads/')) {
      return next();
    }
    const start = Date.now();
    res.on('finish', () => {
      if (!req.path.startsWith('/api/')) return;
      const elapsed = Date.now() - start;
      // 从 Content-Length 响应头读取响应大小（proxyHttpUpstream 会透传上游的 Content-Length）
      const contentLength = res.getHeader('content-length');
      const bytes = contentLength ? Number(contentLength) : 0;
      const size = bytes > 0
        ? bytes < 1024 * 1024
          ? `${(bytes / 1024).toFixed(1)}KB`
          : `${(bytes / (1024 * 1024)).toFixed(2)}MB`
        : '-';
      console.log(
        `[req] ${req.method} ${res.statusCode} ${size} ${elapsed}ms ${req.path}`,
      );
    });
    next();
  });
  // 前端浏览器控制台日志上报（不强制鉴权，便于收集 guest/未登录用户日志）
  app.use('/api/client-logs', clientLogsRoutes);
  // 头像静态文件服务（无需鉴权，头像通过 URL 公开访问）
  app.use('/uploads/avatars', express.static(AVATARS_DIR, {
    maxAge: '7d',
    immutable: true,
  }));
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/stream/danmaku', danmakuRoutes);
  app.use('/api/stream/anime', animeSourcesRoutes);
  app.use('/api/stream/anisubs', anisubsRoutes);
  app.use('/api/stream/kazumi', kazumiRoutes);
  app.use('/api/server-files', serverFilesRoutes);
  app.use('/api/stream', streamRoutes);
  // CLI 本地代理端点：供 zcontrol-cli 使用，使用用户自己的 Cookie 解析高画质
  app.use('/api/cli', cliRoutes);
  app.use('/api/openlist', openlistRoutes);
  app.use('/api/webdav', createMountRouter({
    type: 'webdav',
    proxyPrefix: '/api/webdav',
    logTag: 'webdav',
    displayName: 'WebDAV',
  }));
  app.use('/api/emby', embyRoutes);
  app.use('/api/jellyfin', jellyfinRoutes);
  app.use('/api/ftp', ftpRoutes);
  app.use('/api/subtitles', subtitlesRoutes);
  app.use('/api/system/update', updaterRoutes);
  app.use('/api/stats', statsRoutes);
  app.use('/api/stream-push', streamPushRouter);

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      startedAt: PROCESS_STARTED_AT,
      restartCount: RESTART_COUNT,
    });
  });

  // ==================== HTTPS 模式 ====================
  // 当 HTTPS=true 时，使用自签证书创建 HTTPS 服务器。
  const useHttps = process.env.HTTPS === 'true';

  // 前端静态文件统一由后端托管（HTTP 与 HTTPS 模式均生效），
  // 实现前后端共用同一端口（默认 3333），无需单独启动前端服务。
  const frontendDist = path.resolve(PROJECT_ROOT, 'frontend/dist');
  const hasFrontendDist = fs.existsSync(frontendDist);
  if (hasFrontendDist) {
    console.log(`[static] 提供前端静态文件: ${frontendDist}`);
    // ffmpeg.wasm 核心文件（~32MB）与 JASSUB 字体等大体积资源：
    // 强缓存（immutable + 1 年），配合文件名/ETag 变化自动失效。
    // 避免每次初始化 wasm 引擎都重新下载 32MB 核心。
    app.use(
      '/ffmpeg',
      express.static(path.join(frontendDist, 'ffmpeg'), {
        fallthrough: false,
        maxAge: '1y',
        immutable: true,
      })
    );
    app.use(express.static(frontendDist));
    // SPA 回退延迟到所有 API 路由注册之后（见文件末尾）
  } else {
    console.warn(`[static] 警告：前端构建产物不存在: ${frontendDist}`);
    console.warn('[static] 后端无法提供前端页面，请先构建前端（npm run build -w frontend）');
  }

  let httpServer: ReturnType<typeof createHttpServer>;
  if (useHttps) {
    const sslDir = path.resolve(PROJECT_ROOT, 'config/ssl');
    const certPath = process.env.SSL_CERT_PATH || path.join(sslDir, 'cert.pem');
    const keyPath = process.env.SSL_KEY_PATH || path.join(sslDir, 'key.pem');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(
        `[HTTPS] SSL 证书文件不存在: ${certPath}`,
      );
      console.error('[HTTPS] 请先运行 node scripts/generate-cert.js 生成证书');
      process.exit(1);
    }

    console.log(`[HTTPS] 使用证书: ${certPath}`);
    httpServer = createHttpsServer(
      {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      },
      app,
    );
  } else {
    httpServer = createHttpServer(app);
  }

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: CORS_ORIGIN,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    // 房主广播的 subtitle-update 含完整轨道 cues（手动上传的 ASS 特效
    // 字幕可达数 MB），默认 1MB 会让大字幕同步静默失败
    maxHttpBufferSize: 20 * 1024 * 1024,
  });

  // 注入 io：playbackMemoryService.isHostOnline 据此校验 hostSocketId 的
  // socket 是否实际在线（后端重启后 DB 恢复的旧 socket id 已失效）
  playbackMemoryService.setIo(io);

  app.use('/api/rooms', createRoomsRouter(io));

  // 周期性自动删除长期无人访问的房间
  setInterval(() => {
    void cleanupInactiveRooms(io);
  }, 60 * 60 * 1000);
  void cleanupInactiveRooms(io);

  io.use((socket, next) => {
    // CLI 代理（zcontrol-cli）使用独立连接语义：无需浏览器用户的 access_token，
    // 只需在 cli-register 中提供 roomId 即可加入房间。此处按 agent 标识放行，
    // 后续 CliHandler 会校验 roomId 与 proxyUrl。
    if (socket.handshake.auth.agent === 'zcontrol-cli') {
      socket.data.isCliAgent = true;
      return next();
    }

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

  // 屏幕共享子模块已迁移为新式架构（SocketEventHandler），
  // 与 stream-push 一起通过 SocketRegistry 统一注册，消除旧 services/ 风格。

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
    .add(new SubtitleSyncHandler())
    .add(new SeekApprovalHandler())
    .add(new CommentHandler())
    .add(new CliHandler())
    .add(new StreamPushHandler())
    // WebRTC 信令 + 观众就绪事件（迁移自 services/screen-sharing/）
    .add(new SignalingHandler())
    .add(new ViewerEventsHandler())
    // 语音聊天服务器中转（从 signaling.ts 中分离）
    .add(new VoiceChatHandler());

  // 挂载新模块的 REST 路由
  app.use('/api/rooms', createMovieRouter(io));

  // /live 反向代理到 NMS HTTP-FLV（统一端口后由后端代理，
  // 前端使用相对路径 /live 即可，无需单独暴露 NMS 端口）。
  // 必须在 SPA 回退之前注册，否则 /live 请求会被回退为 index.html。
  const httpFlvPort = process.env.HTTP_FLV_PORT
    ? parseInt(process.env.HTTP_FLV_PORT, 10)
    : 3335;
  app.use('/live', (req, res, next) => {
    if (!nmsService.isAvailable()) return next();
    void proxyHttpUpstream(req, res, {
      url: `http://localhost:${httpFlvPort}${req.originalUrl}`,
      cors: 'wildcard',
      defaultContentType: 'video/x-flv',
      logTag: 'live',
      errorMessage: 'HTTP-FLV 拉流代理失败',
    });
  });

  // SPA 回退：必须在所有 API 路由与 /live 代理注册之后，否则会拦截请求返回 HTML。
  // /api/ 路径不应被 SPA 回退处理 —— 未匹配的 API 请求返回 404 JSON，
  // 避免前端收到 HTML（index.html）后 JSON.parse 报错。
  if (hasFrontendDist) {
    app.use((req, res) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ success: false, message: 'API 路径不存在' });
        return;
      }
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

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
    const protocol = useHttps ? 'https' : 'http';
    console.log(`Server is running on ${protocol}://${displayHost}:${PORT}`);
    if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
      console.warn(
        '警告：未设置 CORS_ORIGIN，当前允许所有来源跨域访问。公网部署请设置 CORS_ORIGIN 为具体域名。',
      );
    }
  });

  // 主进程退出时停止 NMS 并刷新脏数据
  const gracefulShutdown = async () => {
    // 先刷新所有脏数据到 DB，避免最多 2s 的播放进度丢失
    try {
      await playbackMemoryService.flushAllDirty();
    } catch (err) {
      console.error('[flushAllDirty] error:', err);
    }
    try {
      stopNms();
    } catch (err) {
      console.error('[NMS] graceful shutdown error:', err);
    }
    process.exit(0);
  };
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  // 全局兜底：未捕获的 Promise rejection 不崩溃进程
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });
}

bootstrap().catch((err) => {
  console.error('Error during bootstrap:', err);
  process.exit(1);
});
