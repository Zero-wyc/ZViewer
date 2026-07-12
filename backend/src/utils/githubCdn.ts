/**
 * GitHub CDN 加速代理。
 *
 * 将 github.com / raw.githubusercontent.com / api.github.com 的公开请求
 * 重写为 https://github.cdn.zero251.xyz/ 前缀，以提高国内访问稳定性。
 *
 * 规则：
 * - https://github.com/owner/repo/... -> https://github.cdn.zero251.xyz/owner/repo/...
 * - https://raw.githubusercontent.com/owner/repo/... -> https://github.cdn.zero251.xyz/owner/repo/...
 * - https://api.github.com/repos/owner/repo/... -> https://github.cdn.zero251.xyz/repos/owner/repo/...
 *
 * 非 GitHub 地址原样返回。
 */

const CDN_BASE = 'https://github.cdn.zero251.xyz';

export function proxyGitHubUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;

  if (url.startsWith('https://github.com/')) {
    return `${CDN_BASE}${url.slice('https://github.com'.length)}`;
  }

  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return `${CDN_BASE}${url.slice('https://raw.githubusercontent.com'.length)}`;
  }

  if (url.startsWith('https://api.github.com/')) {
    return `${CDN_BASE}${url.slice('https://api.github.com'.length)}`;
  }

  return url;
}

/** 批量转换 URL 列表 */
export function proxyGitHubUrls(urls: string[]): string[] {
  return urls.map(proxyGitHubUrl);
}
