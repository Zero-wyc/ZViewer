/**
 * 统一 HTTP 上游媒体代理（v2 重写）。
 *
 * 历史问题：B站 CDN 代理、图片代理、anisubs/kazumi 等 5+ 个端点各自复制
 * 「构造上游请求头 → fetch → 透传 Range/Content-* 头 → 管道输出」逻辑，
 * 且 CORS 处理不一致。此模块收敛为单一实现，各端点仅声明差异项。
 *
 * v2 改进：
 * - 上游超时控制（默认 30s，可配置），超时返回 504；
 * - 客户端断连时通过 AbortController 中断上游请求，避免无效带宽消耗；
 * - 错误分类：超时 504 / 上游非 2xx 透传状态码 / 网络异常 502；
 * - 响应头透传收敛为白名单，逐一处理；
 * - 流量日志：记录每次代理的 URL / 传输字节数 / 耗时，便于排查带宽来源。
 */

import { Request, Response } from 'express';
import { Readable, Transform } from 'node:stream';
import { isInternalNetworkHost } from '../network-utils';

/** 将字节数格式化为人类可读单位 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

/** 上游请求默认 UA（桌面 Chrome），防盗链场景使用 */
export const DEFAULT_PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 上游请求默认超时（毫秒） */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/**
 * 通配 CORS 头。video.src 跨源加载媒体时需要 ACAO:*，否则会被 ORB 阻止。
 * 注意：携带凭证（credentials: include）的请求不能使用通配 CORS，
 * 此类端点应传 cors: 'global' 交给全局 cors 中间件反射 Origin。
 */
export function setWildcardCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, Range',
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'Content-Range, Accept-Ranges, Content-Length',
  );
}

export interface UpstreamHeaderOptions {
  referer?: string;
  origin?: string;
  userAgent?: string;
  cookie?: string;
  /** 追加或覆盖上游请求头 */
  extra?: Record<string, string>;
}

export interface ProxyHttpOptions {
  /** 上游 URL（调用方需已完成校验） */
  url: string;
  headers?: UpstreamHeaderOptions;
  /**
   * wildcard：手动设置 ACAO:*（无凭证的 video.src 直连场景）；
   * global：交给全局 cors 中间件（fetch credentials: 'include' 场景，
   * 手动设置 ACAO:* 会导致浏览器拒绝响应）。
   * 默认 wildcard。
   */
  cors?: 'wildcard' | 'global';
  /** 上游未返回 Content-Type 时的兜底值，默认 application/octet-stream */
  defaultContentType?: string;
  /** 可选 Cache-Control 响应头（如图片代理的 max-age） */
  cacheControl?: string;
  /** 上游请求超时（毫秒），默认 30000 */
  timeoutMs?: number;
  /** 日志前缀，如 'stream'、'anisubs' */
  logTag: string;
  /** 502 错误响应的 message 文案 */
  errorMessage: string;
}

/** 需要透传给客户端的上游响应头（白名单） */
const PASSTHROUGH_HEADERS = [
  'content-length',
  'accept-ranges',
  'content-range',
  'etag',
  'last-modified',
] as const;

/** 构造上游请求头：UA / Referer / Origin / Cookie / Range 透传 */
function buildUpstreamHeaders(
  req: Request,
  h: UpstreamHeaderOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent':
      h.userAgent && h.userAgent.trim() ? h.userAgent : DEFAULT_PROXY_UA,
    Accept: '*/*',
    ...h.extra,
  };
  if (h.referer && h.referer.trim()) headers.Referer = h.referer;
  if (h.origin && h.origin.trim()) headers.Origin = h.origin;
  if (h.cookie && h.cookie.trim()) headers.Cookie = h.cookie;
  // Range 头归一：极端场景下 req.headers.range 可能是 string[]（重复头），
  // 直接传给 fetch 会抛 TypeError，取首个值兜底。
  const rangeValue = Array.isArray(req.headers.range)
    ? req.headers.range[0]
    : req.headers.range;
  if (rangeValue) headers.Range = rangeValue;
  // 条件请求头透传：ETag/Last-Modified 已通过白名单回传给客户端，
  // 补传协商请求头以激活 304 协商缓存（否则透传的 ETag 是"死头"）。
  const ifNoneMatch = Array.isArray(req.headers['if-none-match'])
    ? req.headers['if-none-match'][0]
    : req.headers['if-none-match'];
  if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
  const ifRange = Array.isArray(req.headers['if-range'])
    ? req.headers['if-range'][0]
    : req.headers['if-range'];
  if (ifRange) headers['If-Range'] = ifRange;
  return headers;
}

/** https 上游是否允许降级 http 重试（仅内网目标，判定统一走 network-utils） */
function shouldDowngradeToHttp(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && isInternalNetworkHost(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 代理一个 HTTP 上游资源：
 * - 透传客户端 Range 头，回传 Content-Range / Accept-Ranges / Content-Length；
 * - 上游非 2xx 时透传状态码并结束；
 * - 上游超时返回 504（未发头时）；
 * - 客户端断连时中断上游请求；
 * - 网络异常时 502（已发头则直接断流）。
 */
export async function proxyHttpUpstream(
  req: Request,
  res: Response,
  opts: ProxyHttpOptions,
): Promise<void> {
  const {
    url,
    cors = 'wildcard',
    defaultContentType = 'application/octet-stream',
    cacheControl,
    timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    logTag,
    errorMessage,
  } = opts;
  const h = opts.headers ?? {};

  // 流量追踪：记录传输字节数与耗时
  const startTime = Date.now();
  let bytesSent = 0;
  const rangeHeader = req.headers.range as string | undefined;

  // 客户端断连 / 超时统一中断上游
  let controller = new AbortController();
  let abortedByTimeout = false;
  // 超时只覆盖「连接 + 等待响应头」阶段：fetch resolve 后即取消，
  // 开放式 Range 下载（bytes=0-）的 body 传输可能持续数分钟，不应被超时中断。
  let timeout = setTimeout(() => {
    abortedByTimeout = true;
    controller.abort();
  }, timeoutMs);
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  // 实际请求的上游 URL：内网 https 失败时会降级 http 重试（catch 分支更新）
  let requestUrl = url;
  // 是否已降级过：降级重试只允许一次，重试再失败直接按网络异常处理
  let hasDowngraded = false;

  try {
    const startUpstreamFetch = () =>
      fetch(requestUrl, {
        method: req.method,
        headers: buildUpstreamHeaders(req, h),
        signal: controller.signal,
      });

    // 转发原始 HTTP 方法：HEAD 请求转发为 HEAD（避免上游下载整个视频体），
    // GET 请求转发为 GET（含 Range 头时上游返回 206 部分内容）。
    const upstream = await startUpstreamFetch().catch(async (fetchErr: unknown) => {
      const isAbort =
        fetchErr instanceof Error && fetchErr.name === 'AbortError';
      const isTimeoutAbort = isAbort && abortedByTimeout;
      const downgradable = shouldDowngradeToHttp(requestUrl);
      if (hasDowngraded || !downgradable) throw fetchErr;
      // 客户端主动断连导致的中断：重试无意义，直接抛回
      if (isAbort && !isTimeoutAbort) throw fetchErr;
      // 覆盖两类内网 scheme 配错症状（NAS 媒体端口只提供 http 却配成 https）：
      // 1. 快速失败：ECONNREFUSED / 证书校验错误；
      // 2. TLS 握手挂死直到超时（AbortError）——最常见的配错表现。
      hasDowngraded = true;
      requestUrl = requestUrl.replace(/^https:\/\//i, 'http://');
      const reason =
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.warn(
        `[${logTag}] https 上游失败（${reason}），降级 http 重试: ${requestUrl.slice(0, 100)}`,
      );
      // 重建超时与中断控制器：旧 controller 已 abort，旧计时器已触发
      clearTimeout(timeout);
      controller = new AbortController();
      abortedByTimeout = false;
      timeout = setTimeout(() => {
        abortedByTimeout = true;
        controller.abort();
      }, timeoutMs);
      return startUpstreamFetch();
    });
    // 响应头已到达，取消连接阶段超时；body 传输阶段由客户端断连检测兜底
    clearTimeout(timeout);

    if (cors === 'wildcard') {
      setWildcardCors(res);
    }

    if (!upstream.ok) {
      console.log(
        `[${logTag}] proxy ${upstream.status} ${formatBytes(bytesSent)} ${Date.now() - startTime}ms range=${rangeHeader || '-'} ${requestUrl.slice(0, 100)}`,
      );
      res.status(upstream.status);
      // 透传语义头：如 416 的 Content-Range: bytes */size（RFC 9110 要求），
      // 让客户端能感知分片边界；若一个头都不透传，Range 语义完全丢失。
      for (const name of PASSTHROUGH_HEADERS) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      res.end();
      return;
    }

    // 转发上游状态码：Range 请求上游返回 206 时必须转发 206，
    // 否则前端 fetch 看到 200 会误判为完整响应（而非部分内容），
    // 影响后续 Content-Range / Content-Length 解析与缓存语义。
    res.status(upstream.status);

    // Content-Type 处理：B站 CDN 偶发返回 application/json（实际是视频数据），
    // 此时使用调用方提供的 defaultContentType（如 video/mp4）纠正，
    // 避免 MSE 引擎或浏览器因 Content-Type 不匹配而拒绝处理。
    const upstreamContentType = upstream.headers.get('content-type');
    const isJsonMismatch =
      upstreamContentType &&
      upstreamContentType.toLowerCase().includes('application/json') &&
      defaultContentType &&
      !defaultContentType.toLowerCase().includes('json');
    if (isJsonMismatch) {
      res.setHeader('Content-Type', defaultContentType);
    } else {
      res.setHeader('Content-Type', upstreamContentType || defaultContentType);
    }
    for (const name of PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    // 确保浏览器知道支持 Range 请求：代理透传 Range 头到上游，
    // 上游返回 206 时代理也转发 206，因此始终支持分段请求。
    // 若上游未返回 Accept-Ranges（部分服务器不默认返回），
    // 浏览器不会发起 Range 请求，导致整文件下载而非流式播放。
    if (!res.getHeader('accept-ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }
    // 视频/媒体流代理：提示反向代理不要缓冲整个响应体。
    // Nginx 默认会先把上游响应缓冲到临时文件再发给客户端，对于大体积、
    // 长连接的 Range 流会导致延迟、超时或内存/磁盘耗尽。
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Proxy-Buffering', 'no');

    // Cache-Control：优先使用调用方传入的缓存策略，并追加 no-transform
    // 禁止中间代理转换/压缩响应体（如把 video/mp4 当文本处理）。
    const finalCacheControl = cacheControl
      ? `${cacheControl}, no-transform`
      : 'no-transform';
    res.setHeader('Cache-Control', finalCacheControl);

    if (!upstream.body) {
      // HEAD 请求：上游 body 为 null，status 已由上游设置（200/206），
      // 仅返回头信息，不传输 body。
      // 非 HEAD 的无 body 响应（如 204）：保持上游状态码。
      console.log(
        `[${logTag}] proxy ${res.statusCode} ${formatBytes(0)} ${Date.now() - startTime}ms range=${rangeHeader || '-'} ${requestUrl.slice(0, 100)}`,
      );
      res.end();
      return;
    }

    const stream = Readable.fromWeb(
      upstream.body as unknown as import('node:stream/web').ReadableStream,
    );
    // 追踪实际传输给客户端的字节数
    const byteCounter = new Transform({
      transform(chunk, _encoding, callback) {
        bytesSent += chunk.length;
        callback(null, chunk);
      },
    });
    stream.on('error', (err) => {
      console.error(`[${logTag}] proxy upstream stream error:`, err);
      console.log(
        `[${logTag}] proxy ERROR ${formatBytes(bytesSent)} ${Date.now() - startTime}ms range=${rangeHeader || '-'} ${requestUrl.slice(0, 100)}`,
      );
      if (!res.headersSent) {
        res.status(502).json({ success: false, message: errorMessage });
      } else {
        res.destroy();
      }
    });
    // 响应结束时输出流量日志
    res.on('finish', () => {
      console.log(
        `[${logTag}] proxy ${res.statusCode} ${formatBytes(bytesSent)} ${Date.now() - startTime}ms range=${rangeHeader || '-'} ${requestUrl.slice(0, 100)}`,
      );
    });
    stream.pipe(byteCounter).pipe(res);
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    if (isAbort && res.writableEnded) return; // 客户端主动断连，无需响应
    if (isAbort) {
      // 超时触发的中断
      console.warn(
        `[${logTag}] proxy TIMEOUT ${formatBytes(bytesSent)} ${Date.now() - startTime}ms range=${rangeHeader || '-'} ${requestUrl.slice(0, 100)}`,
      );
      if (!res.headersSent) {
        res.status(504).json({ success: false, message: '上游请求超时' });
      } else {
        res.end();
      }
      return;
    }
    console.error(`[${logTag}] proxy error:`, err);
    console.log(
      `[${logTag}] proxy ERR ${formatBytes(bytesSent)} ${Date.now() - startTime}ms range=${rangeHeader || '-'} ${requestUrl.slice(0, 100)}`,
    );
    if (!res.headersSent) {
      res.status(502).json({ success: false, message: errorMessage });
    } else {
      res.end();
    }
  } finally {
    clearTimeout(timeout);
  }
}
