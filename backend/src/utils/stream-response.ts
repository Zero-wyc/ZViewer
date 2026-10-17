/**
 * 媒体流端点的错误响应工具。
 *
 * 收编此前在 webdav/openlist/emby-like-factory 中逐字复制的两类片段：
 * 1. StreamMovieError 收尾块（熔断静默 + headersSent 判断 + destroy）
 * 2. 挂载错误码 → HTTP 状态码映射
 */
import type { Response } from 'express';
import { StreamMovieError } from '../services/proxy';

export interface StreamMovieErrorResponseOptions {
  /** 日志前缀（不含方括号） */
  logTag: string;
  /** 附加日志（如 movieId），跟在 warn 行末尾 */
  extraLog?: string;
}

/**
 * StreamMovieError 统一收尾：
 * - 熔断缓存命中（非首次判定）完全静默：客户端重试风暴不应刷日志
 * - headers 未发送时回 JSON 错误；已发送（分片已出）时只能销毁连接
 */
export function sendStreamMovieErrorResponse(
  res: Response,
  err: StreamMovieError,
  opts: StreamMovieErrorResponseOptions,
): void {
  if (!err.fromCache) {
    console.warn(
      `[${opts.logTag}] stream ${err.code} ${err.status}: ${err.message}${opts.extraLog ? ` ${opts.extraLog}` : ''}`,
    );
  }
  if (!res.headersSent) {
    res.status(err.status).json({ success: false, message: err.message, code: err.code });
  } else {
    res.destroy();
  }
}

/**
 * 挂载错误码 → HTTP 状态码映射。
 * - AUTH_FAILED 一律 401
 * - notFound（默认 true）：NOT_FOUND → 404（openlist/webdav 目录浏览语义）
 * - timeout：传入时 TIMEOUT → 指定值（emby 系海报/浏览端点 504）
 * - 其余返回 fallback
 */
export function mapMountErrorCodeToStatus(
  code: string,
  fallback: number,
  opts: { notFound?: boolean; timeout?: number } = {},
): number {
  const { notFound = true, timeout } = opts;
  if (code === 'AUTH_FAILED') return 401;
  if (notFound && code === 'NOT_FOUND') return 404;
  if (timeout !== undefined && code === 'TIMEOUT') return timeout;
  return fallback;
}
