/**
 * GitHub CDN 加速代理。
 *
 * 将 github.com / raw.githubusercontent.com / api.github.com 的公开请求
 * 重写为公共代理前缀（gh-proxy.com，与系统设置「CDN 加速」的默认地址
 * 一致），以提高国内访问稳定性。
 *
 * 历史：曾使用自建 CDN（github.cdn.zero251.xyz，域名替换式），该服务
 * 已下线（实测连接超时），现已切换为 gh-proxy.com 前缀式代理：
 *
 * 规则（gh-proxy 为前缀式，原完整 URL 拼接在代理域名之后）：
 * - https://github.com/owner/repo/... -> https://gh-proxy.com/https://github.com/owner/repo/...
 * - https://raw.githubusercontent.com/... -> https://gh-proxy.com/https://raw.githubusercontent.com/...
 * - https://api.github.com/... -> https://gh-proxy.com/https://api.github.com/...
 *
 * 非 GitHub 地址原样返回。
 */

export const GITHUB_CDN_BASE = 'https://gh-proxy.com'

export function proxyGitHubUrl(url: string): string {
  if (!url || typeof url !== 'string') return url

  if (url.startsWith('https://github.com/')) {
    return `${GITHUB_CDN_BASE}/${url}`
  }

  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return `${GITHUB_CDN_BASE}/${url}`
  }

  if (url.startsWith('https://api.github.com/')) {
    return `${GITHUB_CDN_BASE}/${url}`
  }

  return url
}

/** 批量转换 URL 列表 */
export function proxyGitHubUrls(urls: string[]): string[] {
  return urls.map(proxyGitHubUrl)
}
