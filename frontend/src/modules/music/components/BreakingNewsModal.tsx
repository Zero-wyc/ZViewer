/**
 * 突发新闻（BREAKING NEWS）详情弹窗 —— Hydrogen BreakingNewsDetailModal
 * + breakingNewsDetail util 的 1:1 平移。
 *
 * 目标解析（resolveBreakingNewsTarget）：banner.targetType/targetId 优先，
 * targetType=3000 或缺失时回退从 url 解析（orpheus://song|album|playlist|mv/
 * <id> 或音乐网页 ['#/?]/(kind)?id= 链接）。
 *
 * 详情获取（getBreakingNewsDetail）：
 * - 1 歌曲详情 / 10 专辑 / 1000 歌单 / 1004 MV；不可解析 → external 外链
 * - 模块级 detailCache 缓存 + pending 去重 + cover 预热（与 Hydrogen 同名语义）
 * - prefetchBreakingNewsDetails：idle 分批（2 个/批）预取全部可解析 banner
 *
 * 弹窗 UI：遮罩 + 面板四角框 + 头部 chip/type 标 + 42% 封面 + 58% 信息列
 * （标题/副标题/描述滚动/统计 + 加载/错误态）+ 主按钮/复制链接双操作。
 * 主按钮行为按 target 类映射 ZViewer 语境：song = 入队立即播放（队列权校验）、
 * album/playlist = 跳「我的音乐」详情、mv/external = 新标签页打开链接。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import type { NcmBannerItem, NcmSong } from '../types'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { useMusicStore } from '../store'
import { cn } from '@/lib/utils'

/** 可解析详情的目标类型（Hydrogen RESOLVABLE_TARGET_TYPES 同名同值） */
const RESOLVABLE_TARGET_TYPES = new Set([1, 10, 1000, 1004])

type BreakingNewsKind =
  'song' | 'album' | 'playlist' | 'mv' | 'external' | 'fallback'

/** 详情数据（Hydrogen fetchBreakingNewsDetail 返回结构） */
interface BreakingNewsDetailData {
  kind: BreakingNewsKind
  title: string
  subtitle: string
  desc: string
  stats: string
  cover: string
  shareUrl: string
  /** kind=song 时附带完整歌曲（主按钮立即播放用） */
  song?: NcmSong
}

/** banner → NcmSong（》（song/detail 同构字段集合） */
function mapBannerSong(s: {
  id: number
  name: string
  ar?: Array<{ name?: string }>
  al?: { name?: string; picUrl?: string }
  dt?: number
  duration?: number
  fee?: number
}): NcmSong {
  return {
    songId: s.id,
    name: s.name,
    artist: (s.ar ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: s.al?.name ?? '',
    cover: s.al?.picUrl ?? '',
    durationMs: s.dt ?? s.duration ?? 0,
    vip: s.fee === 1 || s.fee === 4,
  }
}

const toValidNumber = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

const toValidResourceId = (value: unknown): number | null => {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

const normalizeUrl = (value: string | undefined): string =>
  typeof value === 'string' ? value.trim() : ''

/** URL → { type, id }（Hydrogen parseBreakingNewsTargetFromUrl 1:1：orpheus
 *  客户端私有协议与音乐网 Web 链接两种形态） */
export const parseBreakingNewsTargetFromUrl = (rawUrl: string | undefined) => {
  const url = normalizeUrl(rawUrl)
  if (!url) return { type: null as number | null, id: null as number | null }

  const patterns = [
    { type: 1004, regex: /(?:orpheus:\/\/mv\/|[#/]mv\?id=|\/mv\/)(\d+)/i },
    {
      type: 10,
      regex: /(?:orpheus:\/\/album\/|[#/]album\?id=|\/album\/)(\d+)/i,
    },
    {
      type: 1000,
      regex: /(?:orpheus:\/\/playlist\/|[#/]playlist\?id=|\/playlist\/)(\d+)/i,
    },
    { type: 1, regex: /(?:orpheus:\/\/song\/|[#/]song\?id=|\/song\/)(\d+)/i },
  ]

  for (const item of patterns) {
    const matched = url.match(item.regex)
    const parsedId = toValidResourceId(matched && matched[1])
    if (parsedId) return { type: item.type as number | null, id: parsedId }
  }

  return { type: null as number | null, id: null as number | null }
}

/** banner 目标解析（Hydrogen resolveBreakingNewsTarget 1:1：3000/缺失时
 *  从 url 派生） */
export const resolveBreakingNewsTarget = (banner: NcmBannerItem | null) => {
  const targetType = toValidNumber(banner?.targetType)
  const targetId = toValidResourceId(banner?.targetId)
  const parsedTarget = parseBreakingNewsTargetFromUrl(banner?.url)

  const type =
    (targetType === 3000 && parsedTarget.type) ||
    (!targetType && parsedTarget.type)
      ? parsedTarget.type
      : targetType
  const id =
    (targetType === 3000 && parsedTarget.id) ||
    (!targetId && parsedTarget.id && parsedTarget.type === type)
      ? parsedTarget.id
      : targetId

  return { type, id }
}

const buildShareUrl = (type: number | null, id: number | null): string => {
  if (!id) return ''
  if (type === 1) return `https://music.163.com/#/song?id=${id}`
  if (type === 10) return `https://music.163.com/#/album?id=${id}`
  if (type === 1000) return `https://music.163.com/#/playlist?id=${id}`
  if (type === 1004) return `https://music.163.com/mv?id=${id}`
  return ''
}

/** 模块级详情缓存 + 在途请求去重（Hydrogen detailCache/pendingDetailRequests 同名） */
const detailCache = new Map<string, BreakingNewsDetailData>()
const pendingDetailRequests = new Map<string, Promise<BreakingNewsDetailData>>()

const getCacheKey = (banner: NcmBannerItem | null): string => {
  const { type, id } = resolveBreakingNewsTarget(banner)
  return `${type ?? 'unknown'}:${id ?? 'no-id'}:${normalizeUrl(banner?.url) || 'no-url'}`
}

const formatCount = (value: number | undefined): string => {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0) return '0'
  if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`
  if (num >= 10000) return `${(num / 10000).toFixed(1)}万`
  return `${Math.round(num)}`
}

/** 网易云回车键 → （分享链接类型同外链形态解析） */
async function fetchBreakingNewsDetail(
  banner: NcmBannerItem | null
): Promise<BreakingNewsDetailData> {
  if (!banner) throw new Error('缺少 banner 信息')
  const { type, id } = resolveBreakingNewsTarget(banner)
  const fallbackCover = banner.pic || banner.imageUrl || ''

  if (type === 1) {
    const res = await apiGet<{
      songs?: Array<{
        id: number
        name: string
        ar?: Array<{ name?: string }>
        al?: { name?: string; picUrl?: string }
        dt?: number
        fee?: number
      }>
    }>(`/api/music/ncm/song/detail?ids=${id}`)
    const raw = res.data?.songs ?? []
    if (raw.length === 0) throw new Error('未获取到歌曲信息')
    const song = mapBannerSong(raw[0])
    return {
      kind: 'song',
      title: song.name || '未命名歌曲',
      subtitle: song.artist || '未知歌手',
      desc: `收录于专辑《${song.album || '未知专辑'}》`,
      stats: song.songId ? `歌曲 ID: ${song.songId}` : '不可播放',
      cover: song.cover || fallbackCover,
      shareUrl: buildShareUrl(type, song.songId),
      song,
    }
  }

  if (type === 10) {
    const res = await apiGet<{
      album?: {
        name?: string
        picUrl?: string
        description?: string
        company?: string
        size?: number
        subCount?: number
        artists?: Array<{ name?: string }>
      }
    }>(`/api/music/ncm/album?id=${id}`)
    const album = res.data?.album
    if (!album) throw new Error('未获取到专辑信息')
    const artistText =
      (album.artists ?? [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(' / ') || '未知艺术家'
    return {
      kind: 'album',
      title: album.name || '未命名专辑',
      subtitle: artistText,
      desc: album.description || album.company || '暂无专辑简介',
      stats: `${album.size ?? 0} 首歌曲 · ${formatCount(album.subCount || undefined)} 收藏`,
      cover: album.picUrl || fallbackCover,
      shareUrl: buildShareUrl(type, id),
    }
  }

  if (type === 1000) {
    const res = await apiGet<{
      playlist?: {
        name?: string
        creator?: { nickname?: string }
        description?: string
        trackCount?: number
        playCount?: number
        coverImgUrl?: string
      }
    }>(`/api/music/ncm/playlist/detail?id=${id}`)
    const playlist = res.data?.playlist
    if (!playlist) throw new Error('未获取到歌单信息')
    return {
      kind: 'playlist',
      title: playlist.name || '未命名歌单',
      subtitle: playlist.creator?.nickname
        ? `by ${playlist.creator.nickname}`
        : '官方推荐',
      desc: playlist.description || '暂无歌单简介',
      stats: `${playlist.trackCount ?? 0} 首歌曲 · ${formatCount(playlist.playCount)} 播放`,
      cover: playlist.coverImgUrl || fallbackCover,
      shareUrl: buildShareUrl(type, id),
    }
  }

  if (type === 1004) {
    const res = await apiGet<{
      data?: {
        name?: string
        artists?: Array<{ name?: string }>
        artistName?: string
        publishTime?: string
        playCount?: number
        subCount?: number
        desc?: string
        briefDesc?: string
        cover?: string
        id?: number
      }
    }>(`/api/music/ncm/mv/detail?mvid=${id}`)
    const mv = res.data?.data
    if (!mv) throw new Error('未获取到 MV 信息')
    const artistText =
      (mv.artists ?? [])
        .map((a) => a.name)
        .filter(Boolean)
        .join(' / ') ||
      mv.artistName ||
      '未知艺人'
    const publishTime =
      typeof mv.publishTime === 'string' ? mv.publishTime.trim() : ''
    return {
      kind: 'mv',
      title: mv.name || '未命名 MV',
      subtitle: publishTime ? `${artistText} · ${publishTime}` : artistText,
      desc: mv.desc || mv.briefDesc || '暂无 MV 简介',
      stats: `${formatCount(mv.playCount)} 播放 · ${formatCount(mv.subCount)} 收藏`,
      cover: mv.cover || fallbackCover,
      shareUrl: buildShareUrl(type, mv.id ?? id),
    }
  }

  const external = normalizeUrl(banner.url)
  return {
    kind: 'external',
    title: banner.typeTitle || '外部内容',
    subtitle: external ? '将通过系统浏览器打开' : '暂无外部链接',
    desc: '该内容暂不支持站内解析，点击主按钮可尝试打开原始链接。',
    stats: external ? '已检测到可用外链' : '无可用链接',
    cover: fallbackCover,
    shareUrl: external,
  }
}

/** 详情获取（缓存命中直接返回；并发窗口内共用同一在途请求） */
export async function getBreakingNewsDetail(
  banner: NcmBannerItem | null
): Promise<BreakingNewsDetailData> {
  const key = getCacheKey(banner)
  const cached = detailCache.get(key)
  if (cached) return cached
  const pending = pendingDetailRequests.get(key)
  if (pending) return pending
  const request = fetchBreakingNewsDetail(banner)
    .then((detail) => {
      detailCache.set(key, detail)
      return detail
    })
    .finally(() => {
      pendingDetailRequests.delete(key)
    })
  pendingDetailRequests.set(key, request)
  return request
}

/** 预取队列（Hydrogen prefetchBreakingNewsDetails 简化：idle 分批 2 个） */
const prefetchQueue: NcmBannerItem[] = []
let prefetchScheduled = false
const queuedKeys = new Set<string>()

const scheduleIdle = (callback: () => void) => {
  if (typeof window !== 'undefined' && window.requestIdleCallback) {
    window.requestIdleCallback(callback, { timeout: 1800 })
    return
  }
  setTimeout(callback, 700)
}

const runPrefetchQueue = async () => {
  prefetchScheduled = false
  const batch = prefetchQueue.splice(0, 2)
  batch.forEach((banner) => queuedKeys.delete(getCacheKey(banner)))
  await Promise.all(
    batch.map((banner) => getBreakingNewsDetail(banner).catch(() => null))
  )
  if (prefetchQueue.length > 0) {
    prefetchScheduled = true
    scheduleIdle(runPrefetchQueue)
  }
}

/** idle 预取可解析详情（首页 banner 列表就绪后调用） */
export function prefetchBreakingNewsDetails(banners: NcmBannerItem[] = []) {
  if (!Array.isArray(banners) || banners.length === 0) return
  banners.forEach((banner) => {
    const { type, id } = resolveBreakingNewsTarget(banner)
    if (!RESOLVABLE_TARGET_TYPES.has(type ?? 0) || !id) return
    const key = getCacheKey(banner)
    if (
      detailCache.has(key) ||
      pendingDetailRequests.has(key) ||
      queuedKeys.has(key)
    )
      return
    queuedKeys.add(key)
    prefetchQueue.push(banner)
  })
  if (prefetchScheduled || prefetchQueue.length === 0) return
  prefetchScheduled = true
  scheduleIdle(runPrefetchQueue)
}

/** 弹窗主按钮文案（Hydrogen primaryActionLabel 1:1） */
function primaryActionLabel(type: number | null): string {
  if (type === 1) return '立即播放'
  if (type === 10) return '打开专辑'
  if (type === 1000) return '打开歌单'
  if (type === 1004) return '打开链接'
  return '打开链接'
}

export interface BreakingNewsModalProps {
  /** 当前弹窗的 banner（null = 关闭态） */
  banner: NcmBannerItem | null
  socket: Socket | null
  roomId?: string
  /** 主按钮「立即播放」需队列管理权限 */
  canManage: boolean
  onClose: () => void
}

/** 四角框装饰位置（Hydrogen frame-corner ×4） */
const FRAME_CORNERS = [
  'left-[-1px] top-[-1px] border-l-2 border-t-2',
  'right-[-1px] top-[-1px] border-r-2 border-t-2',
  'right-[-1px] bottom-[-1px] border-r-2 border-b-2',
  'left-[-1px] bottom-[-1px] border-l-2 border-b-2',
] as const

export function BreakingNewsModal({
  banner,
  socket,
  roomId,
  canManage,
  onClose,
}: BreakingNewsModalProps) {
  const { add } = useQueueAdd(socket, roomId, canManage)
  const { playSong } = useMusicPlayer()
  const [loading, setLoading] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [detail, setDetail] = useState<BreakingNewsDetailData | null>(null)
  /** 弹窗请求代际（关闭/切换时作废旧请求） */
  const requestSerialRef = useRef(0)

  const resolved = useMemo(() => resolveBreakingNewsTarget(banner), [banner])
  const typeText =
    resolved.type === 1
      ? 'SONG'
      : resolved.type === 10
        ? 'ALBUM'
        : resolved.type === 1000
          ? 'PLAYLIST'
          : resolved.type === 1004
            ? 'MV'
            : resolved.type === 3000
              ? 'EXTERNAL'
              : 'UNKNOWN'
  const displayTypeTitle = banner?.typeTitle || 'BREAKING NEWS'
  const shareUrl = detail?.shareUrl || buildShareUrl(resolved.type, resolved.id)
  const coverUrl = detail?.cover || banner?.pic || banner?.imageUrl || ''
  const displayTitle = detail?.title || 'BREAKING NEWS'
  const displaySubtitle = detail?.subtitle || '暂无副标题'
  const displayDesc = detail?.desc || '暂无详细内容'
  const displayStats = detail?.stats || ''
  const primaryLabel = primaryActionLabel(resolved.type)

  // banner 打开时加载详情（缓存优先；关闭态仅推进代际，复位由打开分支统一处理）
  useEffect(() => {
    if (!banner) {
      requestSerialRef.current += 1
      return
    }
    const serial = ++requestSerialRef.current
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部目标切换驱动的详情加载，复位与请求同步发起
    setLoading(true)
    setErrorText('')
    setDetail(null)
    getBreakingNewsDetail(banner)
      .then((next) => {
        if (serial !== requestSerialRef.current) return
        setDetail(next)
      })
      .catch((err: unknown) => {
        if (serial !== requestSerialRef.current) return
        const msg = err instanceof Error ? err.message : '获取详情失败'
        setErrorText(msg)
      })
      .finally(() => {
        if (serial === requestSerialRef.current) setLoading(false)
      })
  }, [banner])

  // Escape 关闭（Hydrogen handleKeydown 同语义）
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && banner) onClose()
    }
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  }, [banner, onClose])

  if (!banner) return null

  /** 主按钮（Hydrogen handlePrimaryAction 的 ZViewer 语境映射） */
  const handlePrimary = async () => {
    const { type, id } = resolved

    if (type === 1) {
      const song = detail?.song
      if (!song) {
        message.error('歌曲信息加载失败')
        return
      }
      if (!roomId) {
        message.error('未连接房间')
        return
      }
      if (!canManage) {
        message.info('仅房主 / 房管可添加队列')
        return
      }
      add(songToUpsertItem(song))
      playSong({
        id: -1,
        roomId,
        songId: song.songId,
        name: song.name,
        artist: song.artist,
        album: song.album,
        cover: song.cover,
        durationMs: song.durationMs,
        vip: song.vip,
        order: 0,
        addedBy: '',
      })
      onClose()
      return
    }

    // 专辑 / 歌单：跳「我的音乐」详情（Hydrogen openLibraryPage 等价）
    if (type === 10 || type === 1000) {
      if (!id) {
        message.error(type === 10 ? '专辑信息缺失' : '歌单信息缺失')
        return
      }
      useMusicStore.getState().setPendingMyDetail({
        kind: type === 10 ? 'album' : 'playlist',
        id,
        name: detail?.title || displayTypeTitle,
      })
      useMusicStore.getState().setPage('mymusic')
      onClose()
      return
    }

    // MV / 外链：新标签页打开
    const url = shareUrl || undefined
    if (!url) {
      message.info('暂不支持该类型')
      return
    }
    window.open(url, '_blank')
    onClose()
  }

  /** 复制链接（Hydrogen copyLink：优先 detail.shareUrl，提示结果） */
  const handleCopy = async () => {
    if (!shareUrl) {
      message.info('暂无可复制链接')
      return
    }
    try {
      await navigator.clipboard.writeText(shareUrl)
      message.success('链接已复制')
    } catch {
      message.error('复制失败')
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1200] flex items-center justify-center p-6"
      style={{
        backgroundColor: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(7px)',
      }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Breaking News Detail"
        className={cn(
          'relative flex h-[min(520px,calc(100vh-56px))] w-[min(940px,100vw-48px)] flex-col overflow-hidden p-6 zen-dropdown-enter'
        )}
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-surface) 96%, transparent)',
          border:
            '1px solid color-mix(in srgb, var(--md-sys-color-outline) 55%, transparent)',
          boxShadow: '0 26px 54px rgba(0, 0, 0, 0.35)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 135° 半调网格叠加（Hydrogen bn-panel-overlay） */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(135deg, transparent 0%, transparent 43%, color-mix(in srgb, var(--md-sys-color-on-surface) 7%, transparent) 43%, color-mix(in srgb, var(--md-sys-color-on-surface) 7%, transparent) 44%, transparent 44%, transparent 100%)',
          }}
        />
        {/* 四角框 */}
        {FRAME_CORNERS.map((pos) => (
          <span
            key={pos}
            className={cn('absolute h-2.5 w-2.5', pos)}
            style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
            aria-hidden="true"
          />
        ))}

        {/* 头部：黑底 chip + typeTitle / 解析类型标 */}
        <div className="mb-[18px] flex shrink-0 items-center justify-between">
          <span
            className="px-3.5 py-1 text-[13px] font-bold tracking-wider"
            style={{
              backgroundColor: 'var(--md-sys-color-on-surface)',
              color: 'var(--md-sys-color-surface)',
            }}
          >
            BREAKING NEWS
          </span>
          <div className="flex items-center gap-2">
            <span
              className="border px-2 py-[3px] text-[11px] font-bold tracking-wider"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-outline) 55%, transparent)',
                color: 'var(--md-sys-color-on-surface)',
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent)',
              }}
            >
              {displayTypeTitle}
            </span>
            <span
              className="border px-[7px] py-[3px] text-[11px] font-bold tracking-wider"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-outline) 55%, transparent)',
                color: 'var(--md-sys-color-on-surface)',
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent)',
              }}
            >
              {typeText}
            </span>
          </div>
        </div>

        {/* 内容区：42% 封面 + 58% 信息列（Hydrogen 1:1 布局） */}
        <div className="flex min-h-0 flex-1 gap-[18px]">
          {/* 封面 */}
          <div
            className="w-[42%] shrink-0 overflow-hidden"
            style={{
              border:
                '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 20%, transparent)',
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
            }}
          >
            {coverUrl ? (
              <img
                src={coverUrl}
                alt={displayTypeTitle}
                className="h-full w-full object-cover"
                draggable={false}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-[13px] font-bold text-[var(--md-sys-color-on-surface-variant)]">
                NO IMAGE
              </div>
            )}
          </div>

          {/* 信息列 */}
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <h2 className="w-full break-words text-[28px] font-bold leading-[1.25] text-[var(--md-sys-color-on-surface)]">
              {displayTitle}
            </h2>
            <div className="mt-2 text-[14px] font-bold text-[var(--md-sys-color-on-surface-variant)]">
              {displaySubtitle}
            </div>
            <div
              className="zen-scroll mt-[14px] max-h-[160px] w-full overflow-y-auto whitespace-pre-wrap text-[14px] font-medium leading-[1.7] text-[var(--md-sys-color-on-surface)]"
              style={{
                color:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 80%, transparent)',
              }}
            >
              {displayDesc}
            </div>
            {displayStats && (
              <div className="mt-2.5 text-[12px] font-bold text-[var(--md-sys-color-on-surface-variant)]">
                {displayStats}
              </div>
            )}
            {loading && (
              <div className="mt-2.5 flex items-center gap-2 text-[12px] font-medium text-[var(--md-sys-color-on-surface-variant)]">
                <Loader2 className="h-3 w-3 animate-spin" />
                正在加载详情…
              </div>
            )}
            {errorText && (
              <div className="mt-2.5 text-[12px] font-medium text-[var(--md-sys-color-error)]">
                {errorText}
              </div>
            )}

            {/* 操作行：主按钮 + 复制链接 */}
            <div className="mt-auto flex w-full gap-2.5 pt-[18px]">
              <button
                type="button"
                className="h-9 min-w-32 border text-[13px] font-bold tracking-wide transition-transform duration-200 hover:-translate-y-px"
                style={{
                  backgroundColor: 'var(--md-sys-color-on-surface)',
                  color: 'var(--md-sys-color-surface)',
                  borderColor:
                    'color-mix(in srgb, var(--md-sys-color-outline) 55%, transparent)',
                }}
                onClick={() => {
                  void handlePrimary()
                }}
              >
                {primaryLabel}
              </button>
              <button
                type="button"
                className="h-9 min-w-32 border text-[13px] font-bold tracking-wide transition-all duration-200 hover:-translate-y-px hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_12%,transparent)]"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                  color: 'var(--md-sys-color-on-surface)',
                  borderColor:
                    'color-mix(in srgb, var(--md-sys-color-outline) 55%, transparent)',
                }}
                onClick={() => {
                  void handleCopy()
                }}
              >
                复制链接
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
