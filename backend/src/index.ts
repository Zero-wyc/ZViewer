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
import { AppDataSource } from './data-source';
import {
  PROJECT_ROOT,
  AVATARS_DIR,
  ensureDataDirs,
  migrateLegacyDataIfNeeded,
} from './services/paths';
import { ensureDatabaseFile } from './services/db-persistence';
import { ensureUploadsRoot } from './services/server-files/pathResolver';
import { getSystemSettings } from './services/system-settings';
import {
  applyVoiceTransportMode,
  startEmbeddedLivekit,
} from './services/livekit-server.manager';
import { seedRootAdmin } from './services/seed.service';
import { startRoomCleanupScheduler } from './modules/room/room-cleanup.service';
import { attachLivekitWsTunnel } from './services/livekit-tunnel';
import { socketAuthMiddleware } from './middleware/socket-auth';
import { createSocketRegistry } from './modules/socket/register-handlers';
import { registerHttpRoutes } from './routes/register';
import { roomStateService } from './modules/room';
import {
  playbackBroadcasterService,
  playbackMemoryService,
} from './modules/playback-memory';
import { musicBroadcasterService } from './modules/music/music-broadcaster.service';
import { musicPlaybackMemoryService } from './modules/music/music-playback-memory.service';
import { nmsService } from './modules/stream-push';
import {
  startNcmApiService,
  stopNcmApiService,
} from './modules/music/ncm-api.service';
import { PORT, HOST, CORS_ORIGIN, USE_HTTPS } from './services/server-env';

/**
 * 后端启动入口（纯装配）。
 *
 * 各职责已按域拆分，本文件只负责按顺序调用：
 * - 环境配置         → services/server-env.ts
 * - 种子数据         → services/seed.service.ts
 * - 房间清理定时任务 → modules/room/room-cleanup.service.ts
 * - LiveKit 隧道     → services/livekit-tunnel.ts
 * - socket 鉴权      → middleware/socket-auth.ts
 * - socket 处理器    → modules/socket/register-handlers.ts
 * - REST 路由与静态  → routes/register.ts
 */
async function bootstrap() {
  // 数据目录迁移与初始化：必须在 DataSource.initialize 之前完成，
  // 否则 SQLite 会在旧路径创建空库，导致迁移逻辑误判。
  migrateLegacyDataIfNeeded();
  ensureDataDirs();

  // 数据库文件健康检查：滚动备份 + 全零/损坏自愈（详见 services/db-persistence.ts）。
  // 必须在 initialize 之前执行——sql.js 加载坏文件会直接抛「file is not a database」。
  ensureDatabaseFile();

  await AppDataSource.initialize();
  console.log('TypeORM Data Source has been initialized.');
  await seedRootAdmin();
  ensureUploadsRoot();

  // 语音聊天：自动拉起 livekit-server 伴生进程（含环境变量缺省值注入；
  // 开发模式二进制缺失时自动下载到 backend/dev-bin。fire-and-forget，
  // 下载期间 /api/voice/token 会 503，前端有「语音未就绪」提示兜底）。
  // 放在 DB 初始化之后：启动参数需先从系统设置读取语音传输模式（udp/tcp）。
  try {
    const bootSettings = await getSystemSettings();
    await applyVoiceTransportMode(bootSettings.voiceTransportMode);
  } catch {
    /* 设置读取失败时按默认 udp 模式启动 */
  }
  void startEmbeddedLivekit();

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

  // ==================== HTTPS 模式 ====================
  // 当 HTTPS=true 时，使用自签证书创建 HTTPS 服务器。
  let httpServer: ReturnType<typeof createHttpServer>;
  if (USE_HTTPS) {
    const sslDir = path.resolve(PROJECT_ROOT, 'config/ssl');
    const certPath = process.env.SSL_CERT_PATH || path.join(sslDir, 'cert.pem');
    const keyPath = process.env.SSL_KEY_PATH || path.join(sslDir, 'key.pem');

    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
      console.error(`[HTTPS] SSL 证书文件不存在: ${certPath}`);
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
    // engine.io 默认会在 1s 后销毁非自身路径的 upgrade 连接——
    // LiveKit /rtc 信令反代走的就是 upgrade 通道，必须关闭
    destroyUpgrade: false,
  });

  // 注入 io：playbackMemoryService.isHostOnline 据此校验 hostSocketId 的
  // socket 是否实际在线（后端重启后 DB 恢复的旧 socket id 已失效）
  playbackMemoryService.setIo(io);
  // 挂到 app 上：HTTP 路由（如 admin 关房/删房）需要广播 room-closed 时取用
  app.set('io', io);

  // LiveKit 信令 WS 隧道 + 周期性房间清理 + socket 鉴权
  attachLivekitWsTunnel(httpServer);
  startRoomCleanupScheduler(io);
  io.use(socketAuthMiddleware);

  // 启动 Node-Media-Server（RTMP 3334 + HTTP-FLV 3335）用于 OBS 推流模式。
  // 仅使用「观看类共享」（网页/挂载/网盘等）的部署可设
  // STREAM_PUSH_ENABLED=0 完全不启动 NMS，释放 3334/3335 两个监听；
  // 禁用后 stream-push 共享方式不可用（/live 会返回 404）。
  let stopNms: (() => void) | null = null;
  if (process.env.STREAM_PUSH_ENABLED === '0') {
    console.log('[stream-push] 已通过 STREAM_PUSH_ENABLED=0 禁用（3334/3335 不监听）');
  } else {
    stopNms = nmsService.start(io);
  }

  // 启动 NCM API 内部服务（一起听音乐模块，绑定 127.0.0.1）：
  // 失败不阻塞主服务，音乐相关接口将返回 503 降级
  try {
    await startNcmApiService();
  } catch (err) {
    console.error('[music] NCM API 内部服务启动失败，音乐功能不可用:', err);
  }

  // 新模块化架构：通过 SocketRegistry 统一注册所有 socket 事件处理器
  const socketRegistry = createSocketRegistry();
  // REST 路由 + 静态资源 + SPA 回退（顺序见 routes/register.ts）
  registerHttpRoutes(app, io);

  // 启动播放记忆定时广播服务（房主断开期间由服务器接管广播）
  playbackBroadcasterService.start(io);
  // 启动一起听音乐服务器心跳广播（观众进度唯一权威来源）
  musicBroadcasterService.start(io);

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
    const protocol = USE_HTTPS ? 'https' : 'http';
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
      await musicPlaybackMemoryService.flushAllDirty();
    } catch (err) {
      console.error('[flushAllDirty] error:', err);
    }
    try {
      stopNms?.();
    } catch (err) {
      console.error('[NMS] graceful shutdown error:', err);
    }
    try {
      stopNcmApiService();
    } catch (err) {
      console.error('[music] NCM API graceful shutdown error:', err);
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
