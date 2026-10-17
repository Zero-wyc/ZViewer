import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import net from 'node:net';
import type { RequestHandler } from 'express';
import { proxyHttpUpstream } from './proxy/http-proxy';

/**
 * LiveKit 统一端口隧道（从根 index.ts 抽出）。
 *
 * 语音聊天由 LiveKit 承载，浏览器需要与页面同端口访问其信令：
 * - WebSocket：/rtc* 升级请求原样隧道到 LiveKit（升级后是不透明字节流，
 *   纯 TCP 双向管道即可）；
 * - HTTP：livekit-client 连接前会 GET /rtc/v1/validate，必须一并代理，
 *   否则 HTTPS 页面下会被混合内容策略拦截。
 *
 * 上游地址每次请求时从 LIVEKIT_API_HOST 解析，以兼容运行时注入的 env。
 */

/** 解析 LiveKit 上游 host/port（裸机 127.0.0.1:3336 / compose livekit:3336） */
function resolveUpstream(): { host: string; port: number } {
  let upstreamHost = '127.0.0.1';
  let upstreamPort = 3336;
  try {
    const u = new URL(process.env.LIVEKIT_API_HOST || 'http://127.0.0.1:3336');
    upstreamHost = u.hostname;
    upstreamPort = Number(u.port) || 3336;
  } catch {
    /* 缺省值兜底 */
  }
  return { host: upstreamHost, port: upstreamPort };
}

/**
 * 把 /rtc* 的 WebSocket 升级请求隧道到 LiveKit。
 *
 * engine.io 需设置 destroyUpgrade: false，否则非 socket.io 路径的 upgrade
 * 会在 1s 后被销毁（见 index.ts 的 SocketIOServer 配置）。
 */
export function attachLivekitWsTunnel(httpServer: HttpServer): void {
  httpServer.on(
    'upgrade',
    (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = req.url ?? '';
      if (url.startsWith('/socket.io')) return; // socket.io 自行处理
      if (!url.startsWith('/rtc')) {
        socket.destroy(); // 非 socket.io 且非 LiveKit：直接拒绝
        return;
      }
      const { host: upstreamHost, port: upstreamPort } = resolveUpstream();
      const upstream = net.connect(upstreamPort, upstreamHost, () => {
        // upgrade 事件只给剩余字节，请求头需按 rawHeaders 重建回写
        const headerLines = req.rawHeaders
          .reduce<string[]>((acc, _v, i) => {
            if (i % 2 === 0)
              acc.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
            return acc;
          }, [])
          .join('\r\n');
        upstream.write(`${req.method} ${url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    },
  );
}

/** LiveKit 信令 HTTP 反代（/rtc/v1/validate 等） */
export const livekitHttpProxy: RequestHandler = (req, res) => {
  const { host, port } = resolveUpstream();
  void proxyHttpUpstream(req, res, {
    url: `http://${host}:${port}${req.originalUrl}`,
    logTag: 'rtc',
    errorMessage: 'LiveKit 信令代理失败',
  });
};
