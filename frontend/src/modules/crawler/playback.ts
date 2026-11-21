/**
 * 爬虫引擎影片的播放前刷新。
 *
 * 站点规则解析出的直链通常带签名/时效（几分钟后就会 402/403），
 * 所以真正播放前要用原始详情页重新解析一次，并把新地址写回影片记录，
 * 由后端广播 movie-list 让全房间拿到同一份新地址。
 *
 * 站点规则还可以返回多档清晰度（play 脚本的 qualities）：切换清晰度时同样
 * 重新解析一次，取对应档位的地址——签名地址不能长期缓存。
 */
import { detectMediaFormat } from '@/lib/mediaFormat'
import { buildAntileechProxyUrl } from '@/lib/antileech-proxy-url'
import {
  useRoomStore,
  type CrawlerSourceMeta,
  type Movie,
  type MovieSourceMeta,
} from '@/store/roomStore'
import { resolveCrawlerPlay, type CrawlerPlayQuality } from './api'
import { t } from '@/i18n'

function isCrawlerMeta(
  meta: MovieSourceMeta | null | undefined
): meta is CrawlerSourceMeta {
  const candidate = meta as
    { kind?: string; pageUrl?: string } | null | undefined
  return Boolean(candidate && candidate.kind === 'crawler' && candidate.pageUrl)
}

/** 该影片是否需要在播放前重新解析（爬虫引擎来源）。 */
export function needsCrawlerRefresh(movie: Movie | undefined | null): boolean {
  return isCrawlerMeta(movie?.sourceMeta)
}

/** 把解析出的直链包装成可直接播放的地址（防盗链 headers 编码进代理 URL）。 */
function toPlayableUrl(url: string, headers?: Record<string, string>): string {
  return headers && Object.keys(headers).length > 0
    ? buildAntileechProxyUrl('cms', url, headers, {
        force: true,
        // 相对路径入库：否则会把房主的 localhost/内网地址写进影片记录，
        // 通过隧道加入的观众拿到后无法访问。
        relative: true,
      })
    : url
}

/** 一次解析的结果：可直接播放的地址 + 要写回影片记录的元数据。 */
export interface CrawlerPlaySelection {
  /** 可直接赋给播放器的地址（已按需要包装防盗链代理） */
  url: string
  /** 播放器应使用的格式（引擎给出或按地址推断；推断不出时为空） */
  format?: string
  title: string
  /** 与 url 对应的元数据（含 qualities/quality），需要整份写回影片记录 */
  sourceMeta: CrawlerSourceMeta
}

/**
 * 解析爬虫影片的播放地址，但不写回影片记录。
 *
 * @param qualityName 目标清晰度档位名；缺省用引擎给的默认档
 * @returns 非爬虫影片返回 null；解析失败抛错（由调用方提示）
 */
export async function resolveCrawlerSelection(
  roomId: string,
  movie: Movie,
  qualityName?: string
): Promise<CrawlerPlaySelection | null> {
  const meta = movie.sourceMeta
  if (!isCrawlerMeta(meta)) return null
  const resolved = await resolveCrawlerPlay(roomId, meta.pageUrl)
  if (resolved.format === 'iframe' || !resolved.url) {
    throw new Error(resolved.note || t('没有解析到可播放地址，请打开原站查看'))
  }

  const qualities: CrawlerPlayQuality[] = (resolved.qualities || []).filter(
    (quality) => Boolean(quality && quality.url)
  )
  const picked = qualityName
    ? qualities.find((quality) => quality.name === qualityName)
    : undefined
  const chosenUrl = picked?.url || resolved.url
  const chosenHeaders = picked?.headers || resolved.headers
  const detected = detectMediaFormat(chosenUrl)
  const format =
    picked?.format ||
    resolved.format ||
    (detected !== 'unknown' ? detected : undefined)

  // 记录当前档位名：优先用选中的档位，其次找引擎默认地址对应的档位。
  const defaultQuality =
    qualities.find((quality) => quality.url === resolved.url)?.name ||
    qualities[0]?.name
  const quality = picked?.name || defaultQuality
  const qualityNames = qualities.map((item) => item.name)

  return {
    url: toPlayableUrl(chosenUrl, chosenHeaders),
    format,
    title: resolved.title || movie.title,
    sourceMeta: {
      ...meta,
      headers: chosenHeaders,
      ruleId: resolved.ruleId || meta.ruleId,
      qualities: qualityNames.length > 0 ? qualityNames : undefined,
      quality,
    },
  }
}

/**
 * 重新解析并更新影片地址（可指定清晰度档位）。返回 true 表示已刷新；
 * false 表示不是爬虫影片，调用方可直接按原地址播放。解析失败抛错，由调用方提示。
 */
export async function refreshCrawlerMovie(
  roomId: string,
  movie: Movie,
  qualityName?: string
): Promise<boolean> {
  const selection = await resolveCrawlerSelection(roomId, movie, qualityName)
  if (!selection) return false
  await useRoomStore.getState().updateMovie(roomId, movie.id, {
    url: selection.url,
    title: selection.title || movie.title,
    format: selection.format,
    sourceMeta: selection.sourceMeta,
  })
  return true
}
