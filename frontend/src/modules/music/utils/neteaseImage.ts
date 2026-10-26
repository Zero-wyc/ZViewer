/** CDN avatars can arrive over HTTP, which secure native Web origins block. */
export function neteaseImageUrl(source: string | null | undefined, size: number): string {
  if (!source) return ''
  try {
    const url = new URL(source.startsWith('//') ? `https:${source}` : source)
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (url.protocol === 'http:' && (url.hostname === 'music.126.net' || url.hostname.endsWith('.music.126.net'))) url.protocol = 'https:'
    url.searchParams.set('param', `${size}y${size}`)
    return url.href
  } catch { return '' }
}

export const NCM_AVATAR_FALLBACK = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#dce4ea"/><circle cx="20" cy="14" r="7" fill="#71808e"/><path d="M7 38v-4a13 13 0 0 1 26 0v4" fill="#71808e"/></svg>')}`

function isBilibiliImageHost(host: string): boolean {
  return ['hdslb.com', 'biliimg.com', 'bilivideo.com', 'bilibili.com'].some(domain => host === domain || host.endsWith(`.${domain}`))
}

/** Queue metadata must not contain another device's localhost or private channel. */
export function portableMusicCoverUrl(source: string | null | undefined): string {
  if (!source) return ''
  let candidate = source
  for (let depth = 0; depth < 5; depth++) {
    try {
      const url = new URL(candidate.startsWith('//') ? `https:${candidate}` : candidate, 'https://cover.invalid/')
      if (!['http:', 'https:'].includes(url.protocol)) return source
      if (isBilibiliImageHost(url.hostname)) {
        url.protocol = 'https:'
        return url.href
      }
      if (!url.pathname.endsWith('/api/stream/proxy-image')) return source
      const nested = url.searchParams.get('url')
      if (!nested) return source
      candidate = nested
    } catch { return source }
  }
  return source
}

/** Bilibili playback artwork is resolved against the viewer's current server. */
export function musicCoverUrl(source: string | null | undefined, size = 600, serverBase?: string): string {
  if (!source) return ''
  if (serverBase) {
    const portable = portableMusicCoverUrl(source)
    try {
      const url = new URL(portable)
      if (isBilibiliImageHost(url.hostname)) return `${serverBase.replace(/\/$/, '')}/api/stream/proxy-image?url=${encodeURIComponent(portable)}`
    } catch { /* Preserve non-Bilibili local artwork. */ }
  }
  try {
    const url = new URL(source.startsWith('//') ? `https:${source}` : source)
    if (url.hostname === 'music.126.net' || url.hostname.endsWith('.music.126.net')) return neteaseImageUrl(source, size)
  } catch { /* 本地相对资源由宿主解析 */ }
  return source
}

export function fallbackNcmAvatar(event: { currentTarget: HTMLImageElement }): void {
  if (event.currentTarget.getAttribute('src') !== NCM_AVATAR_FALLBACK) event.currentTarget.src = NCM_AVATAR_FALLBACK
}
