import { useAuthStore } from '@/store/authStore'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface QualityOption {
  id: number
  label: string
  resolution?: string
}

export interface ResolvedSource {
  title?: string
  videoUrl: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
  format: 'mp4' | 'dash'
  loggedIn?: boolean
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
}

export interface BilibiliQrData {
  qrcodeKey: string
  qrUrl: string
  qrDataUrl: string
}

export interface BilibiliUserInfo {
  name: string
  avatar: string
  vipStatus?: 0 | 1
}

/**
 * 将 B站 返回的图片地址统一补全为 HTTPS 完整 URL。
 * 兼容协议相对地址（//...）和缺少协议的相对地址。
 */
function normalizeBilibiliImageUrl(url: string): string {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (!/^https?:\/\//i.test(url)) return `https://${url}`
  return url
}

export async function getBilibiliQrCode(): Promise<BilibiliQrData> {
  const res = await fetch(`${API_URL}/api/stream/bilibili/qr`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    qrcodeKey?: string
    qrUrl?: string
    qrDataUrl?: string
  }
  if (!res.ok || !data.success || !data.qrcodeKey || !data.qrDataUrl) {
    throw new Error(data.message || '获取二维码失败')
  }
  return {
    qrcodeKey: data.qrcodeKey,
    qrUrl: data.qrUrl || '',
    qrDataUrl: data.qrDataUrl,
  }
}

export async function pollBilibiliQrCode(
  qrcodeKey: string
): Promise<{ status: number; message: string; loggedIn: boolean }> {
  const res = await fetch(
    `${API_URL}/api/stream/bilibili/qr/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    status?: number
    loggedIn?: boolean
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '轮询二维码状态失败')
  }
  return {
    status: data.status ?? -1,
    message: data.message || '',
    loggedIn: !!data.loggedIn,
  }
}

export async function getBilibiliLoginStatus(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/stream/bilibili/login-status`, {
      headers: getAuthHeaders(),
    })
    const data = (await res.json()) as { success: boolean; loggedIn?: boolean }
    return !!data.loggedIn
  } catch {
    return false
  }
}

export async function logoutBilibili(): Promise<void> {
  await fetch(`${API_URL}/api/stream/bilibili/logout`, {
    method: 'POST',
    headers: getAuthHeaders(),
  })
}

export async function getBilibiliUserInfo(): Promise<BilibiliUserInfo | null> {
  try {
    const res = await fetch(`${API_URL}/api/stream/bilibili/user-info`, {
      headers: getAuthHeaders(),
    })
    const data = (await res.json()) as {
      success: boolean
      name?: string
      face?: string
      avatar?: string
      vipStatus?: 0 | 1
      message?: string
    }
    if (!res.ok || !data.success || !data.name) {
      return null
    }
    return {
      name: data.name,
      avatar: normalizeBilibiliImageUrl(data.face || data.avatar || ''),
      vipStatus: data.vipStatus,
    }
  } catch {
    return null
  }
}

interface ResolveProgressLine {
  success?: boolean
  status: 'parsing' | 'done' | 'error'
  step?: string
  message?: string
  code?: string
  title?: string
  videoUrl?: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
  format?: 'mp4' | 'dash'
  loggedIn?: boolean
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
}

function mapResolvedBilibili(data: ResolveProgressLine): ResolvedSource {
  return {
    title: data.title,
    videoUrl: data.videoUrl ?? '',
    audioUrl: data.audioUrl,
    videoCodec: data.videoCodec,
    audioCodec: data.audioCodec,
    duration: data.duration,
    format: data.format || 'mp4',
    loggedIn: data.loggedIn,
    cid: data.cid,
    currentQn: data.currentQn,
    acceptQuality: data.acceptQuality,
  }
}

async function parseNdjsonStream(
  res: Response,
  onProgress?: (step: string, message: string) => void
): Promise<ResolvedSource> {
  // 先完整读取 NDJSON 文本再逐行解析：
  // 部分浏览器/嵌入环境在 UI 点击触发的流式读取中会记录 net::ERR_ABORTED，
  // 一次性读取文本可避免该问题，同时仍能按顺序回调进度信息。
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    console.warn('[resolveBilibili] 读取响应体失败:', err)
    throw new Error('解析响应失败')
  }

  let resolved: ResolvedSource | null = null
  let streamError: Error | null = null

  const lines = text.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const data = JSON.parse(line) as ResolveProgressLine
      if (data.status === 'parsing' && data.step && data.message) {
        onProgress?.(data.step, data.message)
      } else if (data.status === 'done' && data.videoUrl) {
        resolved = mapResolvedBilibili(data)
      } else if (data.status === 'error') {
        if (data.code === 'NO_PERMISSION') {
          streamError = new Error(data.message || '无权限播放，可能需要大会员')
        } else {
          streamError = new Error(data.message || '解析 B站 视频失败')
        }
      }
    } catch (err) {
      console.warn('[resolveBilibili] 解析进度行失败:', line, err)
    }
  }

  if (streamError) {
    throw streamError
  }

  if (resolved) {
    return resolved
  }

  throw new Error('解析 B站 视频未完成')
}

const STORAGE_KEY = 'zcontrol:bilibili-parse-options'

export type BilibiliCodec = 'auto' | 'avc' | 'hevc' | 'av1'

export interface BilibiliParseOptions {
  fnval?: number
  preferCdn?: string
  codec?: BilibiliCodec
}

const codecToFnval: Record<BilibiliCodec, number | undefined> = {
  auto: undefined,
  avc: 80,
  hevc: 2128,
  av1: 1104,
}

function readBilibiliParseOptions(): BilibiliParseOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as BilibiliParseOptions
  } catch {
    // 忽略 localStorage 读取异常
  }
  return {}
}

export function getBilibiliParseOptions(): BilibiliParseOptions & {
  codec: BilibiliCodec
} {
  const stored = readBilibiliParseOptions()
  const codec = stored.codec || 'auto'
  return {
    ...stored,
    codec,
    fnval: stored.fnval ?? codecToFnval[codec],
  }
}

export function setBilibiliParseOptions(
  options: Partial<BilibiliParseOptions>
): void {
  const current = readBilibiliParseOptions()
  const next: BilibiliParseOptions = { ...current, ...options }
  if (options.codec) {
    next.fnval = codecToFnval[options.codec]
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略写入异常（例如隐私模式）
  }
}

export async function resolveBilibili(
  url: string,
  qn?: number,
  onProgress?: (step: string, message: string) => void,
  options?: { fnval?: number; preferCdn?: string }
): Promise<ResolvedSource> {
  let fetchUrl = `${API_URL}/api/stream/resolve-bilibili?url=${encodeURIComponent(url)}`
  if (qn != null && Number.isFinite(qn)) {
    fetchUrl += `&qn=${qn}`
  }
  if (options?.fnval != null && Number.isFinite(options.fnval)) {
    fetchUrl += `&fnval=${options.fnval}`
  }
  if (options?.preferCdn) {
    fetchUrl += `&preferCdn=${encodeURIComponent(options.preferCdn)}`
  }
  const res = await fetch(fetchUrl, { headers: getAuthHeaders() })
  const contentType = res.headers.get('content-type') || ''

  if (contentType.includes('application/x-ndjson')) {
    return parseNdjsonStream(res, onProgress)
  }

  // 兜底：兼容旧版纯 JSON 响应
  const data = (await res.json()) as ResolveProgressLine
  if (!res.ok || !data.success || !data.videoUrl) {
    if (data.code === 'NO_PERMISSION') {
      throw new Error(data.message || '无权限播放，可能需要大会员')
    }
    throw new Error(data.message || '解析 B站 视频失败')
  }
  return mapResolvedBilibili(data)
}

export interface WebDAVParams {
  serverUrl: string
  path: string
  username?: string
  password?: string
}

export async function resolveWebDAV(
  params: WebDAVParams
): Promise<ResolvedSource> {
  const query = new URLSearchParams({
    serverUrl: params.serverUrl,
    path: params.path,
    ...(params.username ? { username: params.username } : {}),
    ...(params.password ? { password: params.password } : {}),
  }).toString()
  const res = await fetch(`${API_URL}/api/stream/resolve-webdav?${query}`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: 'mp4' | 'dash'
    duration?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 WebDAV 文件失败')
  }
  return {
    title: data.title,
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration,
  }
}

export interface FTPParams {
  serverUrl: string
  path: string
  port?: number
  username?: string
  password?: string
}

export async function resolveFTP(params: FTPParams): Promise<ResolvedSource> {
  const query = new URLSearchParams({
    serverUrl: params.serverUrl,
    path: params.path,
    ...(params.username ? { username: params.username } : {}),
    ...(params.password ? { password: params.password } : {}),
    ...(params.port ? { port: String(params.port) } : {}),
  }).toString()
  const res = await fetch(`${API_URL}/api/stream/resolve-ftp?${query}`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    videoUrl?: string
    format?: 'mp4' | 'dash'
    duration?: number
  }
  if (!res.ok || !data.success || !data.videoUrl) {
    throw new Error(data.message || '解析 FTP 文件失败')
  }
  return {
    title: data.title,
    videoUrl: data.videoUrl,
    format: data.format || 'mp4',
    duration: data.duration,
  }
}

export interface OpenListEntry {
  name: string
  url: string
  type?: string
  size?: number
}

export interface OpenListResolved {
  title?: string
  items: OpenListEntry[]
}

export async function resolveOpenList(
  indexUrl: string
): Promise<OpenListResolved> {
  const res = await fetch(
    `${API_URL}/api/stream/resolve-openlist?url=${encodeURIComponent(indexUrl)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    title?: string
    items?: OpenListEntry[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.items)) {
    throw new Error(data.message || '解析 OpenList 索引失败')
  }
  return {
    title: data.title,
    items: data.items,
  }
}

export function buildOpenListProxyUrl(originalUrl: string): string {
  return `${API_URL}/api/stream/proxy-openlist?url=${encodeURIComponent(originalUrl)}`
}

export interface AnimeSearchResult {
  id: string
  title: string
  cover?: string
  description?: string
  source: string
}

export interface AnimeEpisode {
  id: string
  title: string
  episodeNumber: number
  playbackParams: Record<string, unknown>
}

export interface AnimeSource {
  id: string
  name: string
}

export async function getAnimeSources(): Promise<AnimeSource[]> {
  const res = await fetch(`${API_URL}/api/stream/anime/sources`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    sources?: AnimeSource[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.sources)) {
    throw new Error(data.message || '获取番剧数据源失败')
  }
  return data.sources
}

export async function searchAnime(
  source: string,
  keyword: string
): Promise<AnimeSearchResult[]> {
  const res = await fetch(
    `${API_URL}/api/stream/anime/search?source=${encodeURIComponent(source)}&keyword=${encodeURIComponent(keyword)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    results?: AnimeSearchResult[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '搜索番剧失败')
  }
  return data.results
}

export async function getAnimeEpisodes(
  source: string,
  identifier: string
): Promise<AnimeEpisode[]> {
  const res = await fetch(
    `${API_URL}/api/stream/anime/episodes?source=${encodeURIComponent(source)}&identifier=${encodeURIComponent(identifier)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    episodes?: AnimeEpisode[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取番剧集数失败')
  }
  return data.episodes
}

export async function resolveAnimeEpisode(
  source: string,
  episode: AnimeEpisode
): Promise<{ url: string; headers?: Record<string, string> }> {
  const res = await fetch(`${API_URL}/api/stream/anime/resolve`, {
    method: 'POST',
    headers: {
      ...getAuthHeaders(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    url?: string
    headers?: Record<string, string>
  }
  if (!res.ok || !data.success || !data.url) {
    throw new Error(data.message || '解析番剧播放地址失败')
  }
  return { url: data.url, headers: data.headers }
}

export interface FollowingBangumi {
  seasonId: number
  title: string
  cover: string
  progress: string
  total: number
}

export async function getFollowingBangumi(): Promise<FollowingBangumi[]> {
  const res = await fetch(`${API_URL}/api/stream/bilibili/following-bangumi`, {
    headers: getAuthHeaders(),
  })
  const data = (await res.json()) as {
    success: boolean
    message?: string
    list?: FollowingBangumi[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.list)) {
    throw new Error(data.message || '获取关注番剧列表失败')
  }
  return data.list
}

export interface BangumiEpisode {
  bvid: string
  cid: number
  title: string
  index: number
}

export async function getBangumiEpisodes(
  seasonId: number
): Promise<BangumiEpisode[]> {
  const res = await fetch(
    `${API_URL}/api/stream/bilibili/bangumi-episodes?seasonId=${encodeURIComponent(seasonId)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    episodes?: BangumiEpisode[]
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取番剧集数失败')
  }
  return data.episodes
}

export function isBilibiliUrl(url: string): boolean {
  return /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/i.test(url)
}

export function buildBilibiliVideoUrl(bvid: string): string {
  return `https://www.bilibili.com/video/${bvid}`
}

/**
 * 通过后端免认证代理加载 B站 CDN 图片，绕过浏览器 Referer/CORS 限制。
 */
export function buildBilibiliImageProxyUrl(originalUrl: string): string {
  if (!originalUrl) return ''
  return `${API_URL}/api/stream/proxy-image?url=${encodeURIComponent(originalUrl)}`
}
