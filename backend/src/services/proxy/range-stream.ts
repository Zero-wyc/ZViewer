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
import { Readable } from 'node:stream';
import { setWildcardCors } from './http-proxy';

export interface ParsedRange {
  start: number;
  end: number;
}

/**
 * 单个 Range 响应的最大分片长度（字节，默认 8MB）。
 *
 * 客户端（浏览器 <video>）的探测性请求常为开放式（`bytes=0-`）或显式全量
 * （`bytes=0-<size-1>`）。若原样透传，服务端会把整个数百 MB～数 GB 的文件
 * 一次性推向客户端——客户端通常在解析完 moov/缓冲足够后立即断开，已传输的
 * 部分即成为无效流量（实测日志中单次 709MB 传输即由此产生；用户 seek/关闭
 * 时的浪费更常见）。限制为固定分片后，客户端会按 Content-Range 继续请求后续
 * 分片，播放行为完全不变，但单次最大浪费被限制在分片大小内。
 */
export const MAX_RANGE_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * 解析 `bytes=start-end` 请求头，并把分片长度收敛到 MAX_RANGE_CHUNK_BYTES
 * （见该常量的流量说明；尾部 suffix 请求 `bytes=-N` 不受影响）。
 * @returns 解析结果；无 Range 头返回 null；格式非法或越界返回 'invalid'。
 */
export function parseRangeHeader(
  rangeHeader: string | undefined,
  fileSize: number,
): ParsedRange | null | 'invalid' {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  const start = match[1] ? parseInt(match[1], 10) : 0;
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
  if (start >= fileSize || start > end) return 'invalid';
  // 限制单片长度：开放式（bytes=start-）与超长区间都截断为 8MB 分片
  const cappedEnd = Math.min(end, start + MAX_RANGE_CHUNK_BYTES - 1);
  return { start, end: Math.min(cappedEnd, fileSize - 1) };
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

  // 客户端断连：销毁上游流，停止无用读取（「用户下线后流量仍在跑」的关键防护）。
  // 注意：Node 的 pipe 在目标关闭时只 unpipe、不销毁源流，必须显式 destroy；
  // close 与 error 都覆盖（网络异常/客户端强杀不会触发 close 的完成分支）。
  const destroyUpstream = () => {
    if (!res.writableFinished && !stream.destroyed) stream.destroy();
  };
  res.on('close', destroyUpstream);
  res.on('error', destroyUpstream);

  stream.on('error', (err) => {
    console.error(`[${logTag}] proxy stream error:`, err);
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
  });
  stream.pipe(res);
}
