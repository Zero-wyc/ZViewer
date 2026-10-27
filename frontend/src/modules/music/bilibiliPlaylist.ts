import { getBilibiliVideoView, type BilibiliVideoItem, type BilibiliVideoViewInfo } from '@/modules/bilibili/bilibiliApi'
import type { MusicQueueItem } from './types'
import { portableMusicCoverUrl } from './utils/neteaseImage'

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
  return expandBilibiliParts(item, await getBilibiliVideoView(item.bvid))
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
