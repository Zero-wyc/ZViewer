/**
 * 首页（Hydrogen HomePage 范式）：Banner + 每日推荐 + 最新音乐 + 4 个推荐区块。
 *
 * 页面结构（page-header 三卡横排 + page-content 四区块纵排）：
 * - Banner（35vw×13.7vw 轮播）：BREAKING NEWS 黑条小标（M3 适配 on-surface 底
 *   + surface 字）+ 右侧计时圆点动画 + 下方横条选择器（active 变宽变高）；
 *   3s 自动轮播、hover 暂停；点击轮播图无动作
 * - Recommendation（27vw×13.6vw 半透明卡）：左侧描边空心大字「每日推荐」
 *   （-webkit-text-stroke 1px on-surface，透明填充）+ 上下 L 形角标装饰 +
 *   中间棋盘格播放按钮（点击 → 打开我的音乐页的每日推荐详情）+ 右侧大号日期（M.D）+ 右上小圆点
 * - NewestSong（24.4vw 窄列表）：标题「最新音乐」+ 封面 3.45vw + 歌名/歌手 +
 *   行尾播放按钮（canManage 添加入队），行间 on-surface/10 底边线
 * - RecBlock ×4（推荐歌单/推荐歌手/最新专辑/排行榜）：区块头 = 黑底白字 EN 小标
 *   + 灰色延伸线 + CN 大标题；5 列网格卡片（歌手圆形封面），MVP 仅静态展示
 *
 * 数据：进入页面并行拉取全部接口；任一失败静默降级（该区块空态），不打断整页。
 */
import { useEffect, useRef, useState } from 'react'
import { Play } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import type {
  NcmAlbumCard,
  NcmArtistCard,
  NcmBannerItem,
  NcmNewSongCard,
  NcmPlaylistCard,
  NcmSong,
  NcmToplistCard,
} from '../types'
import { cn } from '@/lib/utils'

export interface MusicHomePageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** Banner 轮播间隔（毫秒，Hydrogen 3s） */
const BANNER_INTERVAL_MS = 3000

/** 排行榜取用的索引（Hydrogen RecListItem 同款 [0,3,8,11,15]） */
const TOPLIST_INDEXES = [0, 3, 8, 11, 15]

/** 推荐歌手随机取样的数量 */
const ARTIST_SAMPLE_COUNT = 5

/** banner 计时圆点动画（3s 内圆点闪缩消失，与轮播节奏同步） */
const BANNER_TIMER_STYLE = `
@keyframes zen-music-banner-timer {
  86% { opacity: 1; transform: scale(0.2); }
  88% { opacity: 0; transform: scale(0.8); }
  90% { opacity: 1; transform: scale(0.2); }
  92% { opacity: 0; transform: scale(0.8); }
  94% { opacity: 1; transform: scale(0.2); }
  96% { opacity: 0; transform: scale(0.8); }
  98% { opacity: 1; transform: scale(0.2); }
  100% { opacity: 0; transform: scale(1); }
}
@keyframes zen-music-rec-checker {
  0% { background-position: 0%; }
  100% { background-position: 100%; }
}
/* 标题「每日推荐 ↔ 查看详情」hover 切换的闪烁动画
   （Hydrogen Recommendation .show-more @keyframes 1:1 平移） */
@keyframes zen-music-rec-titleswap {
  10% { opacity: 0; }
  20% { opacity: 1; }
  30% { opacity: 1; }
  40% { opacity: 0; }
  50% { opacity: 0; }
  60% { opacity: 1; }
  70% { opacity: 1; }
  80% { opacity: 0; }
  90% { opacity: 0; }
  100% { opacity: 1; }
}
`
/** 每日推荐标题两态文案（Hydrogen showMoreTitle 原文，折两行：
 *  第一行「每 日」/ 第二行「推 荐」，不均匀空格是设计语言） */
const REC_TITLE = '每 日\n推 荐'
const REC_TITLE_MORE = '查 看\n详 情'

/** 网易云封面 CDN 尺寸参数（按 Hydrogen 各区块的取图尺寸） */
function withCoverParam(url: string | undefined, param: string): string {
  if (!url) return ''
  return `${url.replace('http://', 'https://')}?param=${param}`
}

/** 最新音乐条目 → NcmSong（artists 旧结构 artists / 新结构 ar 兼容；
 *  关联对象在部分 NCM 服务下会序列化为空串等异常形态，逐个 Array.isArray 校验） */
function mapNewSong(item: NcmNewSongCard): NcmSong {
  const artists =
    [item.artists, item.ar, item.song?.artists].find(Array.isArray) ?? []
  return {
    songId: item.id,
    name: item.name,
    artist: artists
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: '',
    cover: withCoverParam(item.picUrl, '90y90'),
    durationMs: item.dt ?? item.duration ?? item.song?.duration ?? 0,
    vip: false,
  }
}

/** 从数组中随机取 n 个不重复元素（Hydrogen shuffleData 简版） */
function sampleRandom<T>(arr: T[], n: number): T[] {
  const indexes: number[] = []
  const total = arr.length
  while (indexes.length < Math.min(n, total)) {
    const num = Math.floor(Math.random() * total)
    if (!indexes.includes(num)) indexes.push(num)
  }
  return arr.filter((_, i) => indexes.includes(i))
}

export function MusicHomePage({
  socket,
  roomId,
  canManage,
}: MusicHomePageProps) {
  // ===== 各区块数据（独立请求，失败静默降级为空态） =====
  const [banners, setBanners] = useState<NcmBannerItem[]>([])
  const [newSongs, setNewSongs] = useState<NcmSong[]>([])
  const [playlists, setPlaylists] = useState<NcmPlaylistCard[]>([])
  const [artists, setArtists] = useState<NcmArtistCard[]>([])
  const [albums, setAlbums] = useState<NcmAlbumCard[]>([])
  const [toplists, setToplists] = useState<NcmToplistCard[]>([])
  /** 只拉取一次（keep 首页常驻数据，与 Hydrogen onActivated 缓存一致） */
  const loadedRef = useRef(false)

  useEffect(() => {
    if (loadedRef.current) return
    loadedRef.current = true

    // Banner（ipad 端轮播图，透传 banners 数组）
    void apiGet<{ banners?: NcmBannerItem[] }>('/api/music/ncm/banner')
      .then(({ data }) => {
        if (Array.isArray(data?.banners)) setBanners(data.banners)
      })
      .catch(() => {
        // 静默降级：区块空态
      })

    // 最新音乐（/personalized/newsong 响应：{ code, result: [...] }；
    // 注意路径是 personalized/newsong，写成 personal/newsong 会被上游 502）
    void apiGet<{ result?: NcmNewSongCard[] }>(
      '/api/music/ncm/personalized/newsong?limit=10'
    )
      .then(({ data }) => {
        if (Array.isArray(data?.result)) {
          setNewSongs(data.result.map(mapNewSong).filter((s) => s.songId > 0))
        }
      })
      .catch(() => {})

    // 推荐歌单
    void apiGet<{ result?: NcmPlaylistCard[] }>(
      '/api/music/ncm/personalized?limit=10'
    )
      .then(({ data }) => {
        if (Array.isArray(data?.result)) setPlaylists(data.result)
      })
      .catch(() => {})

    // 推荐歌手（取 50 后前端随机 5）
    void apiGet<{ artists?: NcmArtistCard[] }>(
      '/api/music/ncm/top/artists?limit=50'
    )
      .then(({ data }) => {
        if (Array.isArray(data?.artists)) {
          setArtists(sampleRandom(data.artists, ARTIST_SAMPLE_COUNT))
        }
      })
      .catch(() => {})

    // 最新专辑
    void apiGet<{ albums?: NcmAlbumCard[] }>(
      '/api/music/ncm/album/new?area=all&limit=10'
    )
      .then(({ data }) => {
        if (Array.isArray(data?.albums)) setAlbums(data.albums)
      })
      .catch(() => {})

    // 排行榜（取 Hydrogen 同款索引）
    void apiGet<{ list?: NcmToplistCard[] }>('/api/music/ncm/toplist')
      .then(({ data }) => {
        if (Array.isArray(data?.list)) {
          setToplists(data.list.filter((_, i) => TOPLIST_INDEXES.includes(i)))
        }
      })
      .catch(() => {})
  }, [])

  return (
    <div className="flex min-h-full flex-col">
      <style>{BANNER_TIMER_STYLE}</style>

      {/* ===== page-header：Banner + 每日推荐 + 最新音乐（三卡横排） ===== */}
      <div className="flex flex-wrap items-start justify-between gap-6 px-6 pt-[2.8vw] md:px-8">
        <HomeBanner banners={banners} />
        <DailyRecommendation />
        <NewestSongList
          songs={newSongs}
          socket={socket}
          roomId={roomId}
          canManage={canManage}
        />
      </div>

      {/* ===== page-content：4 个推荐区块 ===== */}
      <div className="mt-10 flex flex-col gap-10 px-6 pb-32 md:px-8">
        <RecBlock
          titleEN="RECOMMENDED SONG LIST"
          titleCN="推荐歌单"
          kind="playlist"
          items={playlists.map((p) => ({
            id: p.id,
            name: p.name,
            cover: withCoverParam(p.picUrl, '450y450'),
            sub: '',
            circle: false,
          }))}
        />
        <RecBlock
          titleEN="RECOMMENDED ARTISTS"
          titleCN="推荐歌手"
          kind="artist"
          items={artists.map((a) => ({
            id: a.id,
            name: a.name,
            cover: withCoverParam(a.img1v1Url, '450y450'),
            sub: '',
            circle: true,
          }))}
        />
        <RecBlock
          titleEN="NEWEST ALBUM"
          titleCN="最新专辑"
          kind="album"
          items={albums.map((a) => ({
            id: a.id,
            name: a.name,
            cover: withCoverParam(a.picUrl, '450y450'),
            sub: a.artist?.name ?? '',
            circle: false,
          }))}
        />
        <RecBlock
          titleEN="TOP LIST"
          titleCN="排行榜"
          kind="album"
          items={toplists.map((t) => ({
            id: t.id,
            name: t.name,
            cover: withCoverParam(t.coverImgUrl, '450y450'),
            sub: t.updateFrequency ?? '',
            circle: false,
          }))}
        />
      </div>
    </div>
  )
}

// ==================== Banner（35vw 轮播） ====================

function HomeBanner({ banners }: { banners: NcmBannerItem[] }) {
  /** 横向偏移（每张 35vw；末尾补首图实现无缝回卷） */
  const [offsetIndex, setOffsetIndex] = useState(0)
  /** 回卷归零期间禁用过渡（避免从补位首图反向滚回第一张的可见回滚） */
  const [snap, setSnap] = useState(false)
  /** 计时圆点动画开关（切换图时重启动画） */
  const [timerActive, setTimerActive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [hovered, setHovered] = useState(false)

  /** 启动自动轮播 */
  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = setInterval(() => {
      setOffsetIndex((prev) => prev + 1)
    }, BANNER_INTERVAL_MS)
  }

  // 自动轮播（hover 暂停）+ 计时圆点动画随索引重启
  useEffect(() => {
    if (hovered || banners.length <= 1) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    startTimer()
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [hovered, banners.length])

  useEffect(() => {
    if (banners.length <= 1) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 轮播切图时重启动画，与外部定时系统同步
    setTimerActive(false)
    const t1 = setTimeout(() => setTimerActive(true), 50)
    return () => clearTimeout(t1)
  }, [offsetIndex, banners.length])

  // 无缝回卷：滚到补位首图（length）后瞬时归零（先禁用过渡再重置）
  useEffect(() => {
    if (offsetIndex === banners.length && banners.length > 0) {
      const t = setTimeout(() => {
        setSnap(true)
        setOffsetIndex(0)
      }, 820)
      return () => clearTimeout(t)
    }
    return undefined
  }, [offsetIndex, banners.length])

  // 归零后下一帧恢复过渡
  useEffect(() => {
    if (snap && offsetIndex === 0) {
      const raf = requestAnimationFrame(() => setSnap(false))
      return () => cancelAnimationFrame(raf)
    }
    return undefined
  }, [snap, offsetIndex])

  if (banners.length === 0) {
    // 空态占位（保持 35vw 版面避免布局跳动）
    return (
      <div
        className="h-[13.7vw] w-[35vw] min-w-[280px] shrink-0 rounded-sm"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent)',
        }}
      />
    )
  }

  const track = [...banners, banners[0]]

  return (
    <div className="relative w-[35vw] min-w-[280px] shrink-0">
      {/* 头部：BREAKING NEWS 黑条 + 计时圆点 */}
      <div className="absolute -top-[1.6vw] left-0 right-0 flex items-center justify-between">
        <span
          className="py-[2px] pl-[3px] pr-10 text-[10px] font-bold uppercase tracking-widest"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            color: 'var(--md-sys-color-surface)',
          }}
        >
          Breaking News
        </span>
        <div className="flex items-center">
          <span
            className="h-px w-[9vw] min-w-[60px]"
            style={{ backgroundColor: 'var(--md-sys-color-on-surface)' }}
          />
          <span
            className="-mr-1.5 ml-2 flex h-[11px] w-[11px] items-center justify-center rounded-full border"
            style={{
              borderColor: 'var(--md-sys-color-on-surface)',
              transform: timerActive ? 'rotate(180deg)' : undefined,
              transition: 'transform 0.8s',
            }}
          >
            <span
              className="block h-[5px] w-[5px] rounded-[1px]"
              style={{
                backgroundColor: 'var(--md-sys-color-on-surface)',
                animation: timerActive
                  ? 'zen-music-banner-timer 3s linear'
                  : undefined,
              }}
            />
          </span>
        </div>
      </div>

      {/* 轮播图（hover 暂停；点击无动作） */}
      <div
        className="relative h-[13.7vw] min-h-[110px] overflow-hidden"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          className="absolute left-0 top-0 flex h-full w-full flex-row"
          style={{
            transform: `translateX(-${offsetIndex * 35}vw)`,
            // 回卷归零期间禁用过渡（瞬时归零），其余切换均 0.8s 平移
            transition: snap ? 'none' : 'transform 0.8s ease',
          }}
        >
          {track.map((item, i) => (
            <img
              key={`${item.pic ?? item.imageUrl ?? 'banner'}-${i}`}
              src={withCoverParam(item.pic ?? item.imageUrl, '720y280')}
              alt=""
              className="h-full w-full shrink-0 object-cover"
              draggable={false}
            />
          ))}
        </div>
        {/* 右下角 L 形角标（Hydrogen banner-next 装饰，点击下一张） */}
        <button
          type="button"
          className="absolute -bottom-2 -right-2 h-8 w-8 border-b border-r transition-all duration-300 hover:-bottom-3 hover:-right-3"
          style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
          onClick={() => setOffsetIndex((prev) => prev + 1)}
          aria-label="下一张"
        />
      </div>

      {/* 下方横条选择器 */}
      <div className="absolute -bottom-[1.2vw] left-0 flex items-center">
        {banners.map((_, index) => {
          const active = offsetIndex % Math.max(banners.length, 1) === index
          return (
            <button
              key={index}
              type="button"
              className="px-1 pb-[0.8vw] pt-[0.8vw]"
              onClick={() => setOffsetIndex(index)}
              aria-label={`切换到第 ${index + 1} 张`}
            >
              <span
                className={cn(
                  'block transition-all duration-300',
                  active ? 'h-[3px] w-14' : 'h-px w-7 opacity-50'
                )}
                style={{
                  backgroundColor: 'var(--md-sys-color-on-surface)',
                }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ==================== 每日推荐（27vw 半透明卡） ====================

function DailyRecommendation() {
  const setPage = useMusicStore((s) => s.setPage)
  const setPendingMyDetail = useMusicStore((s) => s.setPendingMyDetail)
  /** 日期「MM\nDD」两行（Hydrogen recTime：月份与天数各 padStart(2)） */
  const [dateText, setDateText] = useState('')
  /** hover 态：大字「每 日/推 荐」↔「查 看/详 情」切换（Hydrogen showMore） */
  const [showMore, setShowMore] = useState(false)

  // 日期排程刷新至下一个零点（+100ms 兜底），睡眠唤醒经 focus/visibility 补刷
  useEffect(() => {
    const refresh = () => {
      const now = new Date()
      const month = `${now.getMonth() + 1}`.padStart(2, '0')
      const day = `${now.getDate()}`.padStart(2, '0')

      setDateText(`${month}\n${day}`)
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1
      )
      return Math.max(nextMidnight.getTime() - now.getTime() + 100, 1000)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      timer = setTimeout(() => {
        refresh()
        schedule()
      }, refresh())
    }

    refresh()
    schedule()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        if (timer) clearTimeout(timer)
        timer = undefined
        refresh()
        schedule()
      }
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  /** 点击跳转「我的音乐」并打开每日推荐详情（Hydrogen /mymusic/playlist/rec） */
  const openDaily = () => {
    setPendingMyDetail({ kind: 'rec', id: 0, name: '每日推荐歌曲' })
    setPage('mymusic')
  }

  return (
    <div
      className="relative flex h-[13.6vw] min-h-[110px] w-[27vw] min-w-[240px] shrink-0 cursor-pointer items-center"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent)',
      }}
      onMouseEnter={() => setShowMore(true)}
      onMouseLeave={() => setShowMore(false)}
      onClick={openDaily}
      title="查看每日推荐"
    >
      {/*
        左区几何（复刻 Hydrogen Recommendation.vue，不重叠版）：
        卡高 13.6vw，两行大字 3.2vw×1.22×2 ≈ 7.8vw 垂直居中 → 上下各余 ≈2.9vw；
        角标 1.8vw 从 top/bottom 0.9vw 到 2.7vw，与文字区不侵入；
        文字容器 px-[1.7vw] 让行端避让角标水平延伸。
        注意：左区必须 self-stretch 占满整卡高度，角标 top/bottom 才是相对
        卡片边缘定位（外层 items-center 会把容器收缩为文字高度导致重叠）。
      */}
      <div className="relative ml-[2vw] flex w-[50%] min-w-0 items-center self-stretch justify-center px-[1.7vw]">
        {/* 上 L 形角标（rec-title-border1） */}
        <span
          className="absolute left-0 top-[0.9vw] h-[1.8vw] w-[1.8vw] border-l-2 border-t-2"
          style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        {/* 下 L 形角标（rec-title-border2） */}
        <span
          className="absolute bottom-[0.9vw] right-0 h-[1.8vw] w-[1.8vw] border-b-2 border-r-2"
          style={{ borderColor: 'var(--md-sys-color-on-surface)' }}
          aria-hidden="true"
        />
        {/* 描边空心大字（3.2vw，两行折行；key 随两态切换重挂重启动画） */}
        <span
          key={showMore ? 'more' : 'rec'}
          className={cn(
            'flex-1 select-none whitespace-pre-line text-center text-[3.2vw] font-bold leading-[1.22]',
            showMore && '[animation:zen-music-rec-titleswap_0.1s]'
          )}
          style={{
            color: 'transparent',
            WebkitTextStrokeWidth: '1px',
            WebkitTextStrokeColor: 'var(--md-sys-color-on-surface)',
          }}
        >
          {showMore ? REC_TITLE_MORE : REC_TITLE}
        </span>
        {/* 英文小字（居中于两行之间，Hydrogen rec-title-en 0.7vw→0.55vw 收紧） */}
        <span className="absolute left-0 right-0 top-1/2 flex -translate-y-1/2 justify-center whitespace-nowrap font-bold text-[max(0.55vw,7px)] text-[var(--md-sys-color-on-surface-variant)]">
          DAILY RECOMMENDATION
        </span>
      </div>

      {/* 中区：棋盘格播放按钮（黑棋盘 5px 平铺 + 白三角，8s 平移动画） */}
      <div className="ml-[1vw] flex w-[15%] items-center">
        <span
          className="relative flex h-[3.5vw] min-h-8 w-[3.5vw] min-w-8 items-center justify-center"
          style={{
            backgroundImage:
              'linear-gradient(135deg, transparent 25%, color-mix(in srgb, var(--md-sys-color-on-surface) 70%, transparent) 0, color-mix(in srgb, var(--md-sys-color-on-surface) 70%, transparent) 50%, transparent 0, transparent 75%, color-mix(in srgb, var(--md-sys-color-on-surface) 70%, transparent) 0)',
            backgroundSize: '5px 5px',
            opacity: 0.85,
            animation: 'zen-music-rec-checker 8s linear infinite',
          }}
        >
          {/* 四角小方块装饰 */}
          <span className="absolute -left-[3px] -top-[3px] h-1 w-1 bg-[var(--md-sys-color-on-surface)]" />
          <span className="absolute -right-[3px] -top-[3px] h-1 w-1 bg-[var(--md-sys-color-on-surface)]" />
          <span className="absolute -bottom-[3px] -right-[3px] h-1 w-1 bg-[var(--md-sys-color-on-surface)]" />
          <span className="absolute -bottom-[3px] -left-[3px] h-1 w-1 bg-[var(--md-sys-color-on-surface)]" />
          <Play
            className="h-[1.6vw] min-h-4 w-[1.6vw] min-w-4 fill-current transition-transform duration-200 hover:scale-110"
            style={{ color: 'var(--md-sys-color-surface)' }}
          />
        </span>
      </div>

      {/* 右区：大号日期两行 + 右上小圆点 */}
      <div className="mr-[1.5vw] flex w-[35%] items-center">
        <span className="select-none whitespace-pre-line text-[3.9vw] font-bold leading-[1.05] tabular-nums text-[var(--md-sys-color-on-surface)]">
          {dateText}
        </span>
      </div>
      <span
        className="absolute right-[1vw] top-[1vw] h-[0.6vw] min-h-2 w-[0.6vw] min-w-2 rounded-full opacity-70"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface-variant) 70%, transparent)',
        }}
        aria-hidden="true"
      />
    </div>
  )
}

// ==================== 最新音乐（24.4vw 窄列表） ====================

function NewestSongList({
  songs,
  socket,
  roomId,
  canManage,
}: {
  songs: NcmSong[]
  socket: Socket | null
  roomId?: string
  canManage: boolean
}) {
  const { addedKeys, add } = useQueueAdd(socket, roomId, canManage)
  const currentKey = useMusicStore((s) => s.currentKey)
  const { playSong, togglePlay, canControl } = useMusicPlayer()

  /** 点击播放：当前曲目切换播放/暂停；否则入队后立即播放 */
  const handlePlay = (song: NcmSong) => {
    if (`ncm:${song.songId}` === currentKey) {
      if (canControl) togglePlay()
      else message.info('由房主控制播放')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }
    if (!addedKeys.has(`ncm:${song.songId}`)) {
      add(songToUpsertItem(song))
    }
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
  }

  return (
    <div className="relative w-[24.4vw] min-w-[260px] shrink-0">
      {/* 标题（与 Banner 头部同高对齐） */}
      <span className="absolute -top-[2.2vw] left-0 text-2xl font-bold text-[var(--md-sys-color-on-surface)]">
        最新音乐
      </span>
      <div className="flex max-h-[13.7vw] min-h-[220px] flex-col overflow-y-auto [scrollbar-width:none]">
        {songs.length === 0 && (
          <div className="flex h-full min-h-[160px] items-center justify-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
            暂无最新音乐
          </div>
        )}
        {songs.map((song, i) => {
          const isCurrent = `ncm:${song.songId}` === currentKey
          return (
            <div
              key={song.songId}
              className={cn(
                'group flex items-center justify-between py-[0.55vw]',
                i < songs.length - 1 && 'border-b',
                'hover:opacity-90'
              )}
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent)',
              }}
            >
              <div className="flex min-w-0 items-center">
                <img
                  src={song.cover}
                  alt=""
                  className="h-[3.45vw] min-h-9 w-[3.45vw] min-w-9 shrink-0 object-cover"
                  draggable={false}
                />
                <div className="ml-[1vw] min-w-0 flex-1 text-left">
                  <div
                    className="truncate text-base font-medium text-[var(--md-sys-color-on-surface)]"
                    title={song.name}
                  >
                    {song.name}
                  </div>
                  {song.artist && (
                    <div className="truncate text-sm text-[var(--md-sys-color-on-surface-variant)]">
                      {song.artist}
                    </div>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="ml-2 flex h-[2vw] min-h-6 w-[2vw] min-w-6 shrink-0 items-center justify-center text-[var(--md-sys-color-on-surface)] transition-transform duration-200 hover:opacity-70 active:scale-75"
                onClick={() => handlePlay(song)}
                title={isCurrent ? '播放/暂停' : '播放'}
                aria-label={isCurrent ? '播放或暂停' : '播放'}
              >
                <Play className="h-[1.3vw] min-h-4 w-[1.3vw] min-w-4 fill-current" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ==================== 推荐区块（4 个 RecListItem） ====================

export interface RecCardItem {
  id: number
  name: string
  cover: string
  sub: string
  /** 歌手卡片用圆形封面 */
  circle: boolean
}

function RecBlock({
  titleEN,
  titleCN,
  kind,
  items,
}: {
  titleEN: string
  titleCN: string
  /** 卡片点击打开的详情类型（我的音乐页详情区） */
  kind: 'playlist' | 'album' | 'artist'
  items: RecCardItem[]
}) {
  const setPage = useMusicStore((s) => s.setPage)
  const setPendingMyDetail = useMusicStore((s) => s.setPendingMyDetail)

  /** 点击卡片跳转「我的音乐」并打开对应详情（Hydrogen 路由跳转等价） */
  const openDetail = (item: RecCardItem) => {
    setPendingMyDetail({
      kind,
      id: item.id,
      name: item.name,
    })
    setPage('mymusic')
  }

  // 数据未到/接口失败：静默降级，不渲染区块（与 Hydrogen 空数据处理一致）
  if (items.length === 0) return null

  return (
    <section>
      {/* 区块头：黑底白字 EN 小标 + 灰色延伸线 */}
      <div className="flex items-center">
        <span
          className="mr-1.5 w-[20vw] min-w-[140px] shrink-0 py-px pl-1 text-[10px] font-bold uppercase tracking-widest"
          style={{
            backgroundColor: 'var(--md-sys-color-on-surface)',
            color: 'var(--md-sys-color-surface)',
            whiteSpace: 'nowrap',
          }}
        >
          {titleEN}
        </span>
        <span
          className="h-px flex-1"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-on-surface) 30%, transparent)',
          }}
        />
      </div>
      {/* CN 大标题 */}
      <h3 className="mt-1 text-2xl font-bold leading-relaxed text-[var(--md-sys-color-on-surface)]">
        {titleCN}
      </h3>

      {/* 5 列网格（小屏 3 列） */}
      <div className="mt-3 grid grid-cols-3 gap-x-12 gap-y-8 xl:grid-cols-5">
        {items.map((item) => (
          <div
            key={item.id}
            className="min-w-0 cursor-pointer"
            onClick={() => openDetail(item)}
            title={`查看${titleCN}：${item.name}`}
          >
            {/* 封面（歌手圆形；hover 上浮阴影；MVP 静态展示） */}
            <div
              className={cn(
                'overflow-hidden transition-all duration-200',
                item.circle && 'rounded-full'
              )}
              title={item.name}
            >
              <img
                src={item.cover}
                alt={item.name}
                className={cn(
                  'block aspect-square w-full object-cover',
                  item.circle && 'rounded-full',
                  'hover:shadow-[0_0_10px_1px_color-mix(in_srgb,black_10%,transparent)]'
                )}
                style={{
                  border:
                    '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 4%, transparent)',
                }}
                draggable={false}
                loading="lazy"
              />
            </div>
            {/* 名称（两行截断） */}
            <div
              className={cn(
                'mt-1.5 line-clamp-2 break-all text-base font-bold leading-snug text-[var(--md-sys-color-on-surface)]',
                item.circle && 'text-center'
              )}
              title={item.name}
            >
              {item.name}
            </div>
            {/* 副标题（歌手 / 更新频率） */}
            {item.sub && (
              <div
                className={cn(
                  'mt-0.5 truncate text-sm text-[var(--md-sys-color-on-surface-variant)]',
                  item.circle && 'text-center'
                )}
              >
                {item.sub}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
