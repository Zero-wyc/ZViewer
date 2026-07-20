import type { ProxyModule } from './types'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

/**
 * 构建代理播放 URL
 * @param module 模块类型（openlist / webdav）
 * @param params 查询参数（如 { url: 'xxx' } 或 { mountId: 1, path: '/video.mp4' }）
 */
export function buildProxyUrl(
  module: ProxyModule,
  params: Record<string, string | number>
): string {
  const query = new URLSearchParams(
    Object.entries(params).reduce(
      (acc, [k, v]) => {
        acc[k] = String(v)
        return acc
      },
      {} as Record<string, string>
    )
  ).toString()
  return `${API_URL}/api/${module}/proxy?${query}`
}

/**
 * 判断是否使用直链模式
 * @param source 来源类型
 * @param directLink 直链标记
 */
export function isDirectLink(_source: string, directLink?: boolean): boolean {
  return directLink === true
}

/**
 * 根据直链模式决定最终播放 URL
 * @param source 来源类型
 * @param directLink 直链标记
 * @param originalUrl 原始 URL（直链模式使用）
 * @param proxyModule 代理模块（代理模式使用）
 * @param proxyParams 代理参数（代理模式使用）
 */
export function resolvePlayUrl(
  source: string,
  directLink: boolean | undefined,
  originalUrl: string,
  proxyModule: ProxyModule,
  proxyParams: Record<string, string | number>
): string {
  if (isDirectLink(source, directLink)) {
    return originalUrl
  }
  return buildProxyUrl(proxyModule, proxyParams)
}
