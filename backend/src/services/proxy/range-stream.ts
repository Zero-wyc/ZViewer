/**
 * Range 请求解析与流式响应输出（v2 重写）。
 *
 * 供「本地流 / 协议流」类代理端点（WebDAV / FTP / OpenList / 服务器文件）复用：
 * 统一的 Range 解析、206/200 状态、Content-Range/Content-Length 头与错误处理。
 *
 * v2 改进：
 * - 新增 sendRangeNotSatisfiable：416 响应统一出口（含 Content-Range: bytes *\/size）；
 * - pipeRangeStream 支持客户端断连时销毁上游流，避免无效读取。
 */

import { Response } from 'express';
import { Readable, Transform } from 'node:stream';
import { setWildcardCors } from './http-proxy';

export interface ParsedRange {
  start: number;
  end: number;
}

/** 普通网页/代理请求继续使用 8 MiB 分片，控制客户端取消时可能浪费的流量。 */
export const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 解析单段字节范围。默认按 8 MiB 分片；AVPlayer 专用流传入 null，
 * 保留完整请求范围以满足其 Content-Range 检查。
 * 无 Range 返回 null；非法、不可满足或不支持的多段范围返回 'invalid'。
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
  maxChunkBytes: number | null = MAX_RANGE_CHUNK_BYTES,
): ParsedRange | null | 'invalid' {
  if (!rangeHeader) return null;
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) return 'invalid';
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';

  // BigInt 避免超大合法十进制数发生精度丢失；裁到文件边界后再转 number。
  const size = BigInt(fileSize);
  if (!match[1]) {
    const suffixLength = BigInt(match[2]);
    if (suffixLength === 0n) return 'invalid';
    // 有上限时仍从真正的文件尾部截取，供播放器的尾部元数据探测使用。
    const effectiveLength = maxChunkBytes === null
      ? suffixLength
      : [suffixLength, BigInt(maxChunkBytes)].reduce((smallest, value) => value < smallest ? value : smallest);
    const start = Number(effectiveLength >= size ? 0n : size - effectiveLength);
    return { start, end: fileSize - 1 };
  }
  const start = BigInt(match[1]);
  const requestedEnd = match[2] ? BigInt(match[2]) : size - 1n;
  if (start >= size || requestedEnd < start) return 'invalid';
  return {
    start: Number(start),
    end: Number(
      maxChunkBytes === null
        ? (requestedEnd >= size ? size - 1n : requestedEnd)
        : [requestedEnd, size - 1n, start + BigInt(maxChunkBytes) - 1n]
          .reduce((smallest, value) => value < smallest ? value : smallest),
    ),
  };
}

/**
 * 统一的 416（Range Not Satisfiable）响应。
 * 按 RFC 9110 携带 `Content-Range: bytes *\/size` 告知可用范围。
 */
export function sendRangeNotSatisfiable(res: Response, fileSize: number): void {
  res.status(416);
  res.setHeader('Content-Range', `bytes */${fileSize}`);
  res.json({ success: false, message: '请求的范围无效' });
}

export interface PipeRangeStreamOptions {
  stream: Readable;
  contentType: string;
  /** 文件总大小；ranged 为 true 时必填 */
  fileSize?: number;
  /** 本次输出的字节区间（含端点）；无 Range 时省略 */
  start?: number;
  end?: number;
  /** 是否响应 Range 请求（决定 206 与 Content-Range） */
  ranged: boolean;
  /**
   * wildcard：设置 ACAO:*（video.src 跨源直连场景，默认）；
   * global：不手动设置 CORS，交给全局 cors 中间件（携带凭证的 fetch 场景）。
   */
  cors?: 'wildcard' | 'global';
  /** 日志前缀 */
  logTag: string;
  /** 流未开始时出错的 502 文案 */
  errorMessage: string;
  /** 可选业务错误码 */
  errorCode?: string;
  /** 已发头后出错时用 res.destroy()（默认）还是 res.end() */
  softDestroy?: boolean;
  /** AVPlayer 专用流的传输速率上限；默认不节流。 */
  maxBytesPerSecond?: number;
  /** 速率限制前允许立即发送的字节数。 */
  initialBurstBytes?: number;
}

/** 在不改变 Content-Range/Content-Length 的前提下限制持续预读。 */
class RateLimitedStream extends Transform {
  private availableBytes: number;
  private lastRefillAt = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly bytesPerSecond: number, private readonly burstBytes: number) {
    super();
    this.availableBytes = burstBytes;
  }

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const now = Date.now();
    this.availableBytes = Math.min(
      this.burstBytes,
      this.availableBytes + Math.max(0, now - this.lastRefillAt) * this.bytesPerSecond / 1000,
    );
    this.lastRefillAt = now;
    const delay = Math.max(0, (chunk.length - this.availableBytes) * 1000 / this.bytesPerSecond);
    this.availableBytes = Math.max(0, this.availableBytes - chunk.length);
    this.lastRefillAt += delay;
    const emitChunk = () => {
      this.timer = undefined;
      if (!this.destroyed) this.push(chunk);
      callback();
    };
    if (delay > 0) this.timer = setTimeout(emitChunk, delay);
    else emitChunk();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.timer) clearTimeout(this.timer);
    callback(error);
  }
}

/**
 * 将一个字节流以统一的响应头与错误处理输出：
 * 通配 CORS + Content-Type + Accept-Ranges + (206) Content-Range/Content-Length。
 * 调用前若 Range 非法，应使用 sendRangeNotSatisfiable 返回 416。
 * 客户端提前断连时自动销毁上游流。
 */
export function pipeRangeStream(
  res: Response,
  opts: PipeRangeStreamOptions,
): void {
  const {
    stream,
    contentType,
    fileSize,
    start,
    end,
    ranged,
    cors = 'wildcard',
    logTag,
    errorMessage,
    errorCode,
    softDestroy = false,
    maxBytesPerSecond,
    initialBurstBytes = 0,
  } = opts;

  if (cors === 'wildcard') {
    setWildcardCors(res);
  }
  res.setHeader('Content-Type', contentType);
  res.setHeader('Accept-Ranges', 'bytes');

  if (ranged && fileSize !== undefined && start !== undefined && end !== undefined) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    res.setHeader('Content-Length', (end - start + 1).toString());
  } else {
    res.status(200);
    if (fileSize !== undefined) {
      res.setHeader('Content-Length', fileSize.toString());
    }
  }

  // HEAD 请求：只返回响应头，不 pipe 流体（避免 socket hang up）
  if (res.req?.method === 'HEAD') {
    stream.destroy();
    res.end();
    return;
  }

  const throttle = maxBytesPerSecond && maxBytesPerSecond > 0
    ? new RateLimitedStream(maxBytesPerSecond, initialBurstBytes)
    : null;
  const output = throttle ?? stream;

  // 客户端断连：销毁上游流，停止无用读取（「用户下线后流量仍在跑」的关键防护）。
  // 注意：Node 的 pipe 在目标关闭时只 unpipe、不销毁源流，必须显式 destroy；
  // close 与 error 都覆盖（网络异常/客户端强杀不会触发 close 的完成分支）。
  const destroyUpstream = () => {
    if (!res.writableFinished) {
      if (!stream.destroyed) stream.destroy();
      if (throttle && !throttle.destroyed) throttle.destroy();
    }
  };
  res.on('close', destroyUpstream);
  res.on('error', destroyUpstream);

  const onStreamError = (err: Error) => {
    console.error(`[${logTag}] proxy stream error:`, err);
    if (throttle && !throttle.destroyed) throttle.destroy();
    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: errorMessage,
        ...(errorCode ? { code: errorCode } : {}),
      });
    } else if (softDestroy) {
      res.end();
    } else {
      res.destroy();
    }
  };
  stream.on('error', onStreamError);
  if (throttle) throttle.on('error', onStreamError);
  output.pipe(res);
  if (throttle) stream.pipe(throttle);
}
