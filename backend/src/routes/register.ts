import express, { type Express } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { Server as SocketIOServer } from 'socket.io';
import { PROJECT_ROOT, AVATARS_DIR } from '../services/paths';
import { proxyHttpUpstream } from '../services/proxy/http-proxy';
import { livekitHttpProxy } from '../services/livekit-tunnel';
import { nmsService, streamPushRouter } from '../modules/stream-push';
import { createMovieRouter } from '../modules/movie';
import { PROCESS_STARTED_AT, RESTART_COUNT } from '../services/server-env';
import authRoutes from './auth';
import adminRoutes from './admin';
import streamRoutes from './stream';
import danmakuRoutes from './danmaku';
import animeSourcesRoutes from './animeSources';
import anisubsRoutes from './anisubs';
import kazumiRoutes from './kazumi';
import cmsRoutes from './cms';
import serverFilesRoutes from './serverFiles';
import musicRoutes from './music';
import { createMountRouter } from './webdav';
import openlistRoutes from './openlist';
import directResolveRoutes from './direct-resolve';
import ftpRoutes from './ftp';
import embyRoutes from './emby';
import jellyfinRoutes from './jellyfin';
import subtitlesRoutes from './subtitles';
import updaterRoutes from './updater';
import statsRoutes from './stats';
import clientLogsRoutes from './client-logs';
import cliRoutes from './cli';
import { createRoomsRouter } from './rooms';
import voiceRoutes from './voice.routes';

/**
 * HTTP 路由与静态资源装配（从根 index.ts 抽出）。
 *
 * 顺序即行为，与原 index.ts 逐条对应，改动时必须保持：
 * API → /health → 前端静态 → io 依赖路由 → /live → /rtc → SPA 回退。
 */
export function registerHttpRoutes(app: Express, io: SocketIOServer): void {
  // 前端浏览器控制台日志上报（不强制鉴权，便于收集 guest/未登录用户日志）
  app.use('/api/client-logs', clientLogsRoutes);
  // 头像静态文件服务（无需鉴权，头像通过 URL 公开访问）
  app.use(
    '/uploads/avatars',
    express.static(AVATARS_DIR, {
      maxAge: '7d',
      immutable: true,
    }),
  );
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/stream/danmaku', danmakuRoutes);
  app.use('/api/stream/anime', animeSourcesRoutes);
  app.use('/api/stream/anisubs', anisubsRoutes);
  app.use('/api/stream/kazumi', kazumiRoutes);
  app.use('/api/stream/cms', cmsRoutes);
  app.use('/api/server-files', serverFilesRoutes);
  // 一起听音乐模块：NCM API 通用转发 / 登录态 / 音频流代理（可选鉴权，游客可匿名调用）
  app.use('/api/music', musicRoutes);
  app.use('/api/stream', streamRoutes);
  // CLI 本地代理端点：供 ZViewer CLI 使用，使用用户自己的 Cookie 解析高画质
  app.use('/api/cli', cliRoutes);
  app.use('/api/openlist', openlistRoutes);
  // 直链实时解析：前端播放时按 movieId 获取新鲜直链（openlist/webdav）
  app.use('/api/direct-resolve', directResolveRoutes);
  app.use(
    '/api/webdav',
    createMountRouter({
      type: 'webdav',
      proxyPrefix: '/api/webdav',
      logTag: 'webdav',
      displayName: 'WebDAV',
    }),
  );
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
      }),
    );
    app.use(express.static(frontendDist));
    // SPA 回退延迟到所有 API 路由注册之后（见本函数末尾）
  } else {
    console.warn(`[static] 警告：前端构建产物不存在: ${frontendDist}`);
    console.warn(
      '[static] 后端无法提供前端页面，请先构建前端（npm run build -w frontend）',
    );
  }

  // 依赖 io 的路由：房主关房/删房需要广播 room-closed
  app.use('/api/rooms', createRoomsRouter(io));
  // 挂载新模块的 REST 路由
  app.use('/api/rooms', createMovieRouter(io));
  // 语音聊天（LiveKit）：签发接入凭证 + 管理操作；实时音频由 LiveKit 服务承载
  app.use('/api/voice', voiceRoutes);

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

  // LiveKit 信令 HTTP 反代：livekit-client 连接前会先 GET /rtc/v1/validate
  // （HTTP 请求，不走 upgrade 通道），必须与 WS 隧道一并代理，
  // 否则 HTTPS 页面下 validate 请求会被混合内容策略拦截。
  app.use('/rtc', livekitHttpProxy);

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
}
