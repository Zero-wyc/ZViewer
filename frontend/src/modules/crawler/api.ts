/**
 * 爬虫引擎搜索 API。
 *
 * 规则、页面抓取与字段抽取全在桌面端爬虫引擎（后端只做转发与权限校验），
 * 前端只负责把关键词/站点发出去并展示已解析好的结果。
 */
import { apiGet, apiPost } from '@/lib/api'
import { t } from '@/i18n'

export interface CrawlerSite {
  id: string
  name: string
  site: string
  aliases?: string[]
  enabled?: boolean
  visibility?: string
  allowedRooms?: string[]
  description?: string
  createdBy?: string
  updatedAt?: string
  stats?: {
    searches?: number
    successes?: number
    failures?: number
    lastUsedAt?: string | null
    lastError?: string | null
  }
}

export interface CrawlerSearchItem {
  title: string
  url: string
  cover?: string
  description?: string
  duration?: string
  author?: string
  extra?: Record<string, unknown>
}

export interface CrawlerChallenge {
  id: string
  proxyUrl: string
  site?: string
  name?: string
  reason?: string
  note?: string
  pageUrl?: string
  status?: number
  expiresAt?: string
}

/** 站点要求人工验证时抛出，携带可直接嵌入 iframe 的验证页地址。 */
export class CrawlerChallengeError extends Error {
  readonly challenge: CrawlerChallenge

  constructor(message: string, challenge: CrawlerChallenge) {
    super(message)
    this.name = 'CrawlerChallengeError'
    this.challenge = challenge
  }
}

export interface CrawlerSearchResult {
  success: boolean
  site?: { id?: string; name?: string; site?: string }
  ruleId?: string
  mode?: string
  keyword?: string
  count?: number
  items?: CrawlerSearchItem[]
  warnings?: string[]
  pageUrl?: string
  tookMs?: number
  repaired?: boolean
}

export interface CrawlerPlayEpisode {
  name?: string
  url?: string
}

/** 站点提供的清晰度档位（规则 play 脚本返回，引擎规范化后透传）。 */
export interface CrawlerPlayQuality {
  name: string
  url: string
  format?: string
  headers?: Record<string, string>
}

/** 站点详情页/播放页解析出的可播放地址（引擎侧完成解析）。 */
export interface CrawlerPlayResult {
  success?: boolean
  site?: string
  ruleId?: string
  ruleName?: string
  title?: string
  format?: string
  url?: string
  headers?: Record<string, string>
  pageUrl?: string
  episodes?: CrawlerPlayEpisode[]
  source?: string
  note?: string
  /** 多清晰度档位；无该字段表示站点只有一档。 */
  qualities?: CrawlerPlayQuality[]
}

interface CrawlerSitesResponse {
  success?: boolean
  sites?: CrawlerSite[]
  count?: number
  error?: string
  message?: string
}

function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>
    const msg = record.error || record.message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  return fallback
}

/** 把详情页/播放页解析成可播放地址；解析规则与浏览器兜底都在引擎侧。 */
export async function resolveCrawlerPlay(
  roomId: string,
  url: string
): Promise<CrawlerPlayResult> {
  const { data, ok } = await apiPost<CrawlerPlayResult & { error?: string }>(
    '/api/crawler/play/resolve',
    { roomId, url }
  )
  if (!ok || !data || data.success === false) {
    throw new Error(errorMessage(data, t('解析播放地址失败')))
  }
  return data
}

/** 查询当前房间可用的站点规则（后端已按房间与身份过滤）。 */
export async function fetchCrawlerSites(
  roomId: string
): Promise<CrawlerSite[]> {
  const { data, ok } = await apiGet<CrawlerSitesResponse>(
    `/api/crawler/sites?roomId=${encodeURIComponent(roomId)}`
  )
  if (!ok || !data?.success) {
    throw new Error(errorMessage(data, t('获取站点列表失败')))
  }
  // 引擎已过滤停用规则；前端再兜一层，停用的站点不进入「全网搜片」列表。
  return Array.isArray(data.sites)
    ? data.sites.filter((site) => site.enabled !== false)
    : []
}

/** 在单个站点执行搜索。 */
export async function searchCrawlerSite(
  roomId: string,
  site: string,
  keyword: string,
  limit = 30
): Promise<CrawlerSearchResult> {
  const { data, ok } = await apiPost<
    CrawlerSearchResult & {
      error?: string
      code?: string
      details?: Record<string, unknown>
    }
  >('/api/crawler/search', { roomId, site, keyword, limit })
  if (!ok || !data?.success) {
    const details = data?.details
    if (
      data?.code === 'challenge_required' &&
      details &&
      typeof details.challengeId === 'string'
    ) {
      const text = (key: string): string | undefined => {
        const value = details[key]
        return typeof value === 'string' && value ? value : undefined
      }
      throw new CrawlerChallengeError(errorMessage(data, t('需要人工验证')), {
        id: details.challengeId,
        proxyUrl:
          text('proxyUrl') ||
          `/api/crawler/challenge/${encodeURIComponent(details.challengeId)}/site`,
        site: text('site') || site,
        name: text('name'),
        reason: text('reason'),
        note: text('note'),
        pageUrl: text('pageUrl'),
        status: typeof details.status === 'number' ? details.status : undefined,
        expiresAt: text('expiresAt'),
      })
    }
    throw new Error(errorMessage(data, t('搜索失败')))
  }
  return data
}

/** 提交「我已完成验证」，成功后返回该站点的搜索结果。 */
export async function verifyCrawlerChallenge(
  challengeId: string
): Promise<CrawlerSearchResult> {
  const { data, ok } = await apiPost<{
    success?: boolean
    verified?: boolean
    result?: CrawlerSearchResult
    error?: string
  }>(`/api/crawler/challenge/${encodeURIComponent(challengeId)}/verify`)
  if (!ok || !data?.success || !data.result) {
    throw new Error(errorMessage(data, t('验证还没有完成')))
  }
  return data.result
}

/** 从搜索结果里挑一个可播放的媒体直链（规则显式给 play_url 的站点才会命中）。 */
export function pickPlayableUrl(item: CrawlerSearchItem): string {
  const candidates: string[] = [item.url]
  const extra = item.extra
  if (extra && typeof extra === 'object') {
    for (const key of [
      'playUrl',
      'play_url',
      'videoUrl',
      'video_url',
      'm3u8',
      'url',
    ]) {
      const value = (extra as Record<string, unknown>)[key]
      if (typeof value === 'string' && value.trim())
        candidates.push(value.trim())
    }
  }
  return (
    candidates.find((value) =>
      /\.(m3u8|mp4|webm|mov|mkv|flv)(\?|#|$)/i.test(value)
    ) || ''
  )
}
