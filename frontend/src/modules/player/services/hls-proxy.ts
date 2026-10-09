/** The playlist base is the upstream URL, never the proxy endpoint. */
export interface HlsProxySource {
  url: string
  endpoint: string
  parameters: Record<string, string>
}

export function readHlsProxySource(raw: string, apiBase: string): HlsProxySource | null {
  try {
    const proxy = new URL(raw, apiBase)
    if (!/\/api\/stream\/(?:kazumi\/|anisubs\/)?proxy$/.test(proxy.pathname)) return null
    const target = proxy.searchParams.get('url')
    if (!target || !/^https?:$/.test(new URL(target).protocol)) return null
    const parameters: Record<string, string> = {}
    // Preserve anti-leech headers, including explicitly empty values. Client
    // authentication belongs to the proxy request and must never reach a CDN.
    for (const key of ['referer', 'userAgent', 'origin', 'cookie']) {
      if (proxy.searchParams.has(key)) parameters[key] = proxy.searchParams.get(key)!
    }
    return { url: target, endpoint: proxy.origin + proxy.pathname, parameters }
  } catch { return null }
}

export function buildHlsProxyRequest(url: string, proxy: HlsProxySource): string {
  return `${proxy.endpoint}?${new URLSearchParams({ url, ...proxy.parameters })}`
}

export function isServerApiUrl(raw: string, apiBase: string): boolean {
  try {
    const base = new URL(apiBase)
    const url = new URL(raw, apiBase)
    return url.origin === base.origin && url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/api/')
  } catch { return false }
}
