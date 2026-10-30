import { getBilibiliVideoView, type BilibiliVideoItem, type BilibiliVideoViewInfo } from '@/modules/bilibili/bilibiliApi'
import type { MusicQueueItem } from './types'
import { portableMusicCoverUrl } from './utils/neteaseImage'
import { pickBiliPartMeta, type BiliPartMeta } from './utils/biliPartName'

/**
 * 视频详情短缓存（bvid → 进行中的请求）。
 *
 * 相关推荐一次要命名 3 条、续播时又可能重复命中同一合集，逐条打
 * `/api/stream/bilibili/view` 会平白多出数次往返；这里按 bvid 合并并发
 * 请求并缓存 10 分钟（分P列表几乎不会在会话内变化）。失败立即剔除，
 * 交给下一次调用重试。
 */
const VIEW_CACHE_TTL_MS = 10 * 60 * 1000
const viewCache = new Map<
  string,
  { at: number; promise: Promise<BilibiliVideoViewInfo> }
>()

export function loadBilibiliView(bvid: string): Promise<BilibiliVideoViewInfo> {
  const now = Date.now()
  const hit = viewCache.get(bvid)
  if (hit && now - hit.at < VIEW_CACHE_TTL_MS) return hit.promise
  const promise = getBilibiliVideoView(bvid)
  viewCache.set(bvid, { at: now, promise })
  void promise.catch(() => {
    if (viewCache.get(bvid)?.promise === promise) viewCache.delete(bvid)
  })
  return promise
}

/**
 * 解析一个 B站 条目应有的曲名（多分P → 分P名）。
 *
 * 供「相关推荐」这类**只有视频级信息**（bvid/cid/标题）的入队路径使用；
 * 拿不到详情时静默回退标题，不能让推荐流程因为命名失败而中断。
 */
export async function resolveBiliPartMeta(
  bvid: string,
  cid: number | null | undefined,
  fallbackTitle: string
): Promise<BiliPartMeta> {
  try {
    return pickBiliPartMeta(await loadBilibiliView(bvid), cid, fallbackTitle)
  } catch {
    return { name: fallbackTitle, album: '', durationSec: 0, multiPart: false }
  }
}

/** A BV's total duration is not the duration of any one CID. */
export function expandBilibiliParts(item: BilibiliVideoItem, view: BilibiliVideoViewInfo): MusicQueueItem[] {
  const seen = new Set<number>()
  const pages = (view.pages || []).filter(page => {
    if (!Number.isSafeInteger(page.cid) || page.cid <= 0 || seen.has(page.cid)) return false
    seen.add(page.cid)
    return true
  })
    .sort((a, b) => a.page - b.page)
  if (!pages.length && (view.cid || item.cid)) pages.push({ page: 1, cid: view.cid || item.cid!, part: item.title, duration: view.duration })
  if (!pages.length) throw new Error('没有找到可播放的分P')
  return pages.map((page, index) => {
    const duration = page.duration ?? (pages.length === 1 ? view.duration : 0)
    return { id: -1, roomId: '', songId: 0,
    name: pages.length > 1 ? page.part?.trim() || `${view.title || item.title} · P${page.page}` : item.title,
    artist: view.upName || item.upName || '哔哩哔哩', album: pages.length > 1 ? view.title || item.title : '',
    cover: portableMusicCoverUrl(view.pic || item.pic),
    durationMs: Number.isFinite(duration) ? Math.round(Math.max(0, duration) * 1000) : 0,
    vip: false, order: index, addedBy: '', biliBvid: item.bvid, biliCid: page.cid }
  })
}

export async function loadBilibiliParts(item: BilibiliVideoItem): Promise<MusicQueueItem[]> {
  return expandBilibiliParts(item, await loadBilibiliView(item.bvid))
}

/** Append in order; only start after the first acknowledged queue write. */
export async function enqueueBilibiliParts(tracks: readonly MusicQueueItem[], deps: {
  enqueue: (track: MusicQueueItem) => Promise<void>
  isCurrent: () => boolean
  play?: (track: MusicQueueItem) => void
}): Promise<void> {
  for (let index = 0; index < tracks.length; index++) {
    if (!deps.isCurrent()) return
    await deps.enqueue(tracks[index])
    if (!deps.isCurrent()) return
    if (index === 0) deps.play?.(tracks[index])
  }
}
