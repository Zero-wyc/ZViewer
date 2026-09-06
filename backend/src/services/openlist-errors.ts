/**
 * OpenList 错误类型与工具函数
 *
 * 抽离到独立文件避免循环依赖：
 * - openlist-client.ts 使用 OpenListError
 * - openlist.ts 同时使用两者
 */

import { isInternalServerUrl } from './network-utils';

/** OpenList 错误码（与 WebDAV 错误码保持一致语义，便于上层复用） */
export type OpenListErrorCode =
  | 'AUTH_FAILED'
  | 'UNREACHABLE'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'INVALID_URL';

export class OpenListError extends Error {
  code: OpenListErrorCode;
  constructor(message: string, code: OpenListErrorCode) {
    super(message);
    this.name = 'OpenListError';
    this.code = code;
  }
}

/**
 * 规范化 OpenList 服务器地址：
 * - 去除首尾空白
 * - 若无协议前缀，补 `http://`
 * - 若 URL 仅有协议+域名（无路径或路径为 `/`），自动补 `/dav`
 *   OpenList/AList 的 WebDAV 端点默认为 /dav，用户通常只填域名，
 *   自动补全可避免"测试连接失败"的困惑。
 *   注意：HTTP API 基地址会通过 toApiBaseUrl() 去掉 /dav 后缀，
 *   因此这里保留 /dav 以兼容旧数据。
 * - 去除末尾多余的斜杠
 */
export function normalizeOpenListServerUrl(serverUrl: string): string {
  let normalized = serverUrl.trim();
  if (!normalized) return normalized;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  try {
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname === '') {
      normalized = `${parsed.origin}/dav`;
    }
  } catch {
    // URL 解析失败时保持原样
  }
  return normalized;
}

/** 从错误中提取错误码 */
export function extractOpenListErrorCode(err: unknown): OpenListErrorCode {
  if (err instanceof OpenListError) return err.code;
  return 'UNREACHABLE';
}

/**
 * 内网判断已统一迁移到 network-utils.ts（单一事实源，
 * 覆盖 IPv4/IPv6/localhost/mDNS，语义与历史版本一致并更完整）。
 * 此处保留 re-export 以兼容既有引用。
 */
export {
  isInternalNetworkHost,
  isInternalServerUrl,
} from './network-utils';

/**
 * 判断 OpenList 服务器 URL 是否指向内网
 * （浏览器无法直连时必须强制使用服务器中转，directLink=false）。
 * 实现已统一到 network-utils 的 isInternalServerUrl。
 */
export function isInternalOpenListServer(serverUrl: string): boolean {
  return isInternalServerUrl(serverUrl);
}
