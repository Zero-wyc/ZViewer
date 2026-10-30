import type { ResolvedSource } from './types'
import { getBilibiliVideoView } from './bilibiliApi'

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
 * 从 B站 链接中提取已指定的分 P 序号（`?p=3` / `&page=3`）。
 *
 * 链接里带 p 说明用户在搜索弹窗或外部链接里已经选过集，
 * 解析时应直接取该 P，不再二次弹分集选择。
 */
export function extractBilibiliPage(url: string): number | undefined {
  if (!url) return undefined
  const match = url.match(/[?&](?:p|page)=(\d+)/i)
  if (!match) return undefined
  const page = Number(match[1])
  return Number.isSafeInteger(page) && page > 0 ? page : undefined
}

/**
 * 从任意输入提取番剧/影视（PGC）标识：ep 集号或 ss 季号。
 *
 * 与后端 resolver.extractBangumiId 语义一致：显式 /bangumi/play/ 路径直接命中；
 * 裸 ep(\d+)/ss(\d+) 仅在无 BV/av 上下文、且 ep/ss 前非字母数字时认定。
 */
export function extractBangumiId(
  input: string
): { epId?: number; seasonId?: number } | null {
  if (!input) return null
  const pathMatch = input.match(/bangumi\/play\/(ep|ss)(\d+)/i)
  if (pathMatch) {
    return pathMatch[1].toLowerCase() === 'ep'
      ? { epId: Number(pathMatch[2]) }
      : { seasonId: Number(pathMatch[2]) }
  }
  if (extractBvid(input) || /av\d+/i.test(input)) return null
  const epMatch = input.match(/(?:^|[^a-z0-9])ep(\d+)/i)
  if (epMatch) return { epId: Number(epMatch[1]) }
  const ssMatch = input.match(/(?:^|[^a-z0-9])ss(\d+)/i)
  if (ssMatch) return { seasonId: Number(ssMatch[1]) }
  return null
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
  /** CLI 错误统一以 {"error":"..."} 返回（http.Error 分支），不带 message 字段 */
  error?: string
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
    epId?: number
    badge?: string
  }>
  currentPage?: number
  /** PGC：当前播放集 ep_id */
  epId?: number
  /** PGC：整季 season_id */
  seasonId?: number
  /** PGC：整季标题（番剧/影视名） */
  seasonTitle?: string
  /** PGC：当前集为试看/预览流 */
  preview?: boolean
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
 * CLI 解析前置查询失败（拿不到首个分 P 的 cid，无法向 CLI 发起解析）。
 *
 * 这一层失败与 CLI 本身是否可用无关，调用方应按「静默回退服务器端」处理，
 * 不要弹「CLI 解析失败」打扰用户。
 */
export class CliPrecheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliPrecheckError'
  }
}

/**
 * `${bvid}#${page}` → 该分 P 的 cid 缓存。
 *
 * 同一 bvid 的 cid 不会变化，多 P 视频按分 P 调用时上游已带 cid，只有首次解析会用到缓存。
 */
const pageCidCache = new Map<string, number>()

/**
 * 取指定分 P（缺省第一 P）的 cid。
 *
 * CLI 的 `/resolve` 对 UGC（bvid）分支强制要求 cid：只有 bvid 时直接返回
 * 400 `{"error":"缺少 bvid 或 cid"}`。而刚粘贴链接做首次解析时前端还没有 cid，
 * 不补这一步就会每次先失败一次：前端抛 CliResolveError → 弹「…已回退到服务器端解析」
 * → 最终走服务器端解析，CLI 高画质在首解析上永远不生效。
 *
 * 因此这里借后端 view 接口（匿名可查）补目标 P 的 cid 再发起 CLI 解析。
 */
async function resolvePageCid(bvid: string, page = 1): Promise<number> {
  const key = `${bvid}#${page}`
  const cached = pageCidCache.get(key)
  if (cached) return cached
  let view: Awaited<ReturnType<typeof getBilibiliVideoView>>
  try {
    view = await getBilibiliVideoView(bvid)
  } catch {
    throw new CliPrecheckError('获取视频信息失败，改用服务器端解析')
  }
  const cid =
    view.pages?.find((p) => p.page === page)?.cid ||
    (page === 1 ? view.cid || view.pages?.[0]?.cid : 0) ||
    0
  if (!cid)
    throw new CliPrecheckError(
      page > 1
        ? `未取到 P${page} 的 cid，改用服务器端解析`
        : '未取到视频分 P 的 cid，改用服务器端解析'
    )
  // 简单容量上限，避免长时间运行后无限增长
  if (pageCidCache.size >= 200) pageCidCache.clear()
  pageCidCache.set(key, cid)
  return cid
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
 * @param cid 视频分 P 的 cid（可选，缺省时先经 view 接口补第一 P 的 cid）
 * @param qn 清晰度 qn（可选）
 * @param preferMp4 是否优先 MP4（可选，默认 false）
 * @param forceDash 是否强制使用 DASH 并禁用 MP4 降级（CLI 代理已连接时使用）
 * @param page 目标分 P 序号（可选，仅在没有 cid 时用于补齐 cid）
 */
export async function resolveBilibiliViaCli(
  proxyUrl: string,
  bvid: string,
  cid?: number,
  qn?: number,
  preferMp4?: boolean,
  forceDash?: boolean,
  page?: number
): Promise<ResolvedSource> {
  const base = proxyUrl.replace(/\/$/, '')
  // CLI 缺 cid 会直接 400，首次解析（刚粘贴链接）先补目标 P 的 cid。
  const effectiveCid =
    cid != null && Number.isFinite(cid)
      ? cid
      : await resolvePageCid(bvid, page ?? 1)
  const params = new URLSearchParams({
    bvid,
    cid: String(effectiveCid),
  })
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
      'CLI 代理连接失败，请确认本地 ZViewer CLI 已启动'
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
      data.message ||
        data.error ||
        `CLI 解析 B站 视频失败（HTTP ${res.status}）`
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
    cid: data.cid ?? effectiveCid,
    currentQn: data.currentQn,
    acceptQuality: data.acceptQuality,
    vipStatus: data.vipStatus,
    pages: data.pages,
    currentPage: data.currentPage,
    epId: data.epId,
    seasonId: data.seasonId,
    seasonTitle: data.seasonTitle,
    preview: data.preview,
  }

  // CLI /resolve 已返回代理 URL，但本地包装可确保旧版 CLI 与兜底场景也走代理。
  return wrapResolvedSourceWithCliProxy(proxyUrl, resolved)
}

/**
 * 通过本地 CLI 代理解析 B站 番剧/影视（PGC ep/ss）。
 *
 * 与 resolveBilibiliViaCli 的差异仅在于标识参数：epId（+ 可选 cid）替代 bvid。
 * CLI 侧（Go）使用用户自己的 Cookie 调 pgc/player/web/playurl 获取播放地址。
 */
export async function resolveBangumiViaCli(
  proxyUrl: string,
  epId: number,
  cid?: number,
  qn?: number,
  preferMp4?: boolean,
  forceDash?: boolean
): Promise<ResolvedSource> {
  const base = proxyUrl.replace(/\/$/, '')
  const params = new URLSearchParams({
    epId: String(epId),
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
    throw new CliConnectionError(
      'CLI 代理连接失败，请确认本地 ZViewer CLI 已启动'
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
      data.message ||
        data.error ||
        `CLI 解析 B站 番剧失败（HTTP ${res.status}）`
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
    epId: data.epId ?? epId,
    seasonId: data.seasonId,
    seasonTitle: data.seasonTitle,
    preview: data.preview,
  }

  return wrapResolvedSourceWithCliProxy(proxyUrl, resolved)
}
