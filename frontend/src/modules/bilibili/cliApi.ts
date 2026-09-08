import type { ResolvedSource } from './types'

const BV_REGEX = /BV[0-9A-Za-z]{10}/

/**
 * 从 B站 完整 URL 或 BV 号字符串中提取 BV 号。
 */
export function extractBvid(url: string): string | null {
  if (!url) return null
  const match = url.match(BV_REGEX)
  return match ? match[0] : null
}

/**
 * 将任意 URL 包装为 CLI 本地代理 URL。
 * CLI 代理会注入正确的 Referer/Origin/User-Agent 头，绕过 B站 CDN 防盗链。
 *
 * 若 targetUrl 本身已是该 CLI 代理地址，则直接返回避免双重包装。
 */
export function buildCliProxyUrl(proxyUrl: string, targetUrl: string): string {
  const base = proxyUrl.replace(/\/$/, '')
  const proxyPrefix = `${base}/proxy?url=`
  if (targetUrl.startsWith(proxyPrefix)) {
    return targetUrl
  }
  return `${proxyPrefix}${encodeURIComponent(targetUrl)}`
}

/**
 * 将解析结果中的 B站 CDN URL 全部重写为 CLI 代理 URL。
 *
 * 重写后：
 * - 视频流（videoUrl）走本地 CLI 代理
 * - 音频流（audioUrl）走本地 CLI 代理
 * - 播放器/下载器无需感知代理细节，直接请求 localhost 即可
 */
export function wrapResolvedSourceWithCliProxy(
  proxyUrl: string,
  resolved: ResolvedSource
): ResolvedSource {
  return {
    ...resolved,
    videoUrl: buildCliProxyUrl(proxyUrl, resolved.videoUrl),
    audioUrl: resolved.audioUrl
      ? buildCliProxyUrl(proxyUrl, resolved.audioUrl)
      : undefined,
  }
}

interface CliResolveResponse {
  success?: boolean
  message?: string
  title?: string
  duration?: number
  cid?: number
  videoUrl?: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  format?: 'mp4' | 'dash' | string
  loggedIn?: boolean
  vipStatus?: number
  currentQn?: number
  acceptQuality?: Array<{
    id: number
    label: string
    resolution?: string
  }>
  pages?: Array<{
    page: number
    cid: number
    part: string
    duration: number
  }>
  currentPage?: number
}

/** CLI 代理连接失败（网络不可达 / CORS / 进程未启动） */
export class CliConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliConnectionError'
  }
}

/** CLI 代理解析失败（后端返回错误或响应数据不完整） */
export class CliResolveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliResolveError'
  }
}

/**
 * 通过本地 CLI 代理解析 B站 视频。
 *
 * CLI 使用用户自己的 Cookie 向后端 /api/cli/resolve 请求，可获取大会员等高画质地址。
 * 解析成功后，本函数将返回的 CDN URL 重写为 CLI 代理 URL，浏览器直接请求本地即可播放。
 *
 * 失败时抛出 CliConnectionError（网络不可达）或 CliResolveError（解析失败），
 * 调用方可据此决定是否回退到服务器端解析。
 *
 * @param proxyUrl CLI 本地代理地址，例如 http://127.0.0.1:9333
 * @param bvid BV 号
 * @param cid 视频分 P 的 cid（可选，未指定时后端自动使用第一 P）
 * @param qn 清晰度 qn（可选）
 * @param preferMp4 是否优先 MP4（可选，默认 false）
 * @param forceDash 是否强制使用 DASH 并禁用 MP4 降级（CLI 代理已连接时使用）
 */
export async function resolveBilibiliViaCli(
  proxyUrl: string,
  bvid: string,
  cid?: number,
  qn?: number,
  preferMp4?: boolean,
  forceDash?: boolean
): Promise<ResolvedSource> {
  const base = proxyUrl.replace(/\/$/, '')
  const params = new URLSearchParams({
    bvid,
  })
  if (cid != null && Number.isFinite(cid)) {
    params.set('cid', String(cid))
  }
  if (qn != null && Number.isFinite(qn)) {
    params.set('qn', String(qn))
  }
  if (preferMp4) {
    params.set('preferMp4', 'true')
  }
  if (forceDash) {
    params.set('forceDash', 'true')
  }

  let res: Response
  try {
    res = await fetch(`${base}/resolve?${params.toString()}`, {
      method: 'GET',
    })
  } catch {
    // fetch 抛出 TypeError：网络不可达、CORS 被拦截、进程未启动等
    throw new CliConnectionError(
      'CLI 代理连接失败，请确认本地 zcontrol-cli 已启动'
    )
  }

  let data: CliResolveResponse
  try {
    data = (await res.json()) as CliResolveResponse
  } catch {
    throw new CliResolveError(`CLI 代理返回了无效响应（HTTP ${res.status}）`)
  }

  if (!res.ok || data.success === false || !data.videoUrl) {
    throw new CliResolveError(
      data.message || `CLI 解析 B站 视频失败（HTTP ${res.status}）`
    )
  }

  const resolved: ResolvedSource = {
    title: data.title,
    videoUrl: data.videoUrl,
    audioUrl: data.audioUrl,
    videoCodec: data.videoCodec,
    audioCodec: data.audioCodec,
    duration: data.duration,
    format: (data.format as ResolvedSource['format']) || 'mp4',
    loggedIn: data.loggedIn,
    cid: data.cid ?? cid,
    currentQn: data.currentQn,
    acceptQuality: data.acceptQuality,
    vipStatus: data.vipStatus,
    pages: data.pages,
    currentPage: data.currentPage,
  }

  // CLI /resolve 已返回代理 URL，但本地包装可确保旧版 CLI 与兜底场景也走代理。
  return wrapResolvedSourceWithCliProxy(proxyUrl, resolved)
}
