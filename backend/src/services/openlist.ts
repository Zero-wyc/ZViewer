/**
 * OpenList 服务层
 *
 * OpenList（基于 AList）支持 WebDAV 协议访问，默认端点为 `/dav`。
 * 本模块复用 `services/webdav.ts` 的 WebDAV 客户端能力，仅提供 OpenList 专属的
 * 错误类型与挂载参数转换辅助函数，避免重复实现。
 */
import type { WebDAVConnectionParams } from './webdav';
import type { UserMount } from '../entities/UserMount';

// OpenList 错误类型：复用 WebDAV 的错误码体系（AUTH_FAILED/UNREACHABLE/NOT_FOUND/TIMEOUT）
export class OpenListError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'OpenListError';
    this.code = code;
  }
}

/**
 * 规范化 OpenList 服务器地址：
 * - 去除首尾空白
 * - 若无协议前缀，补 `http://`（OpenList 实例通常以 HTTP 暴露 WebDAV）
 * - 若 URL 仅有协议+域名（无路径或路径为 `/`），自动补 `/dav`
 *   OpenList/AList 的 WebDAV 端点默认为 `/dav`，用户在 UI 中通常只填域名，
 *   自动补全可避免"测试连接失败"的困惑。
 * - 去除末尾多余的斜杠
 */
export function normalizeOpenListServerUrl(serverUrl: string): string {
  let normalized = serverUrl.trim();
  if (!normalized) return normalized;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  // 解析 URL，若 path 部分为空或仅 /，自动补 /dav
  try {
    const parsed = new URL(normalized);
    if (!parsed.pathname || parsed.pathname === '/' || parsed.pathname === '') {
      normalized = `${parsed.origin}/dav`;
    }
  } catch {
    // URL 解析失败时保持原样，让后续 WebDAV 客户端报错
  }
  return normalized;
}

/**
 * 将 UserMount 记录转换为 WebDAVConnectionParams。
 * OpenList 的 serverUrl 应为完整的 WebDAV 端点（如 `http://host/dav`）。
 */
export function mountToOpenListParams(mount: UserMount): WebDAVConnectionParams {
  return {
    serverUrl: normalizeOpenListServerUrl(mount.serverUrl || ''),
    path: mount.path || '/',
    username: mount.username || undefined,
    password: mount.password || undefined,
  };
}
