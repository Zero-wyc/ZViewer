/**
 * 统一网络工具：内网地址判断 + 服务器 URL 规范化。
 *
 * 历史问题：http-proxy / openlist-errors / webdav / emby-client 各自实现了
 * 一套「内网判断」或「serverUrl 规范化」，语义不一致（如 http-proxy 版本不认
 * localhost/IPv6，emby-client 版本不补 scheme）。此模块收敛为单一事实源。
 */

/**
 * 判断主机名是否为内网/回环地址。
 *
 * 覆盖范围（RFC 1918 / RFC 4193 / loopback / link-local）：
 * - IPv4: 127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16
 * - IPv6: ::1、fc00::/7（唯一本地地址）、fe80::/10（链路本地）
 * - 主机名: localhost、*.localhost、*.local（mDNS）
 * - IPv4 映射的 IPv6（::ffff:192.168.1.1）
 *
 * @param hostname 已解析的主机名（不含端口、不含协议）
 */
export function isInternalNetworkHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;

  // 主机名 localhost / mDNS .local
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }

  // IPv4 回环 127.x.x.x
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  // IPv4 私有：10.x.x.x
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  // IPv4 私有：192.168.x.x
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  // IPv4 私有：172.16.x.x ~ 172.31.x.x
  const m172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv4 链路本地 169.254.x.x
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;

  // IPv6 环回
  if (host === '::1') return true;

  // IPv6 唯一本地地址 fc00::/7（fcxx 或 fdxx 开头）
  if (/^f[cd][0-9a-f]{2}(?::|$)/.test(host)) return true;

  // IPv6 链路本地 fe80::/10
  if (/^fe[89ab][0-9a-f]?(?::|$)/.test(host)) return true;

  // IPv4 映射的 IPv6 ::ffff:127.0.0.1 等
  const v4Mapped = /^::ffff:([0-9.]+)$/i.exec(host);
  if (v4Mapped) return isInternalNetworkHost(v4Mapped[1]);

  return false;
}

/**
 * 判断服务器 URL 是否指向内网。
 *
 * 解析 URL 的 hostname（无协议前缀时默认按 http:// 处理，
 * 兼容用户输入 `192.168.1.5:8096` 这类裸地址），委托给 isInternalNetworkHost。
 * URL 解析失败时返回 false（保守策略，不做强制限制）。
 */
export function isInternalServerUrl(serverUrl: string): boolean {
  let url = serverUrl.trim();
  if (!url) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  try {
    const parsed = new URL(url);
    return isInternalNetworkHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 规范化用户输入的服务器地址（通用版，不含业务特有路径补全）：
 * - 去除首尾空白
 * - 若无协议前缀，补默认 scheme（http://）——NAS 用户常省略协议，
 *   不补会导致运行时 new URL 抛错
 * - 去除末尾多余斜杠
 */
export function normalizeServerUrlWithScheme(serverUrl: string): string {
  let normalized = serverUrl.trim();
  if (!normalized) return normalized;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    normalized = `http://${normalized}`;
  }
  while (normalized.endsWith('/') && !/:\/\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
