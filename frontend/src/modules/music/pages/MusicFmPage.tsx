/**
 * 私人漫游页（Hydrogen PersonalFM.vue 1:1 复刻）。
 *
 * 结构（Hydrogen .personal-fm / .fm-panel）：
 * - fm-panel 面板：半透明底 + 1px 透明边框 + min-height 650px +
 *   padding 24px 34px；**四角 10px 方块**（2px 边框、仅显两边）
 * - 开场动画（panel intro，仅挂载时一次）：
 *   outline-draw 四条 1px 边线 scaleX/scaleY 展开（0.64s
 *   cubic-bezier(0.25,0.9,0.3,1)）→ 四角方块 reveal（0.48s、延迟 0.44s、
 *   scale 0.78→1）→ 内容 reveal（0.9s、延迟 0.6s、translateY 8px→0）；
 *   1.54s 后进入 outline-ready 常驻态
 * - fm-header（居中）：PERSONAL FM 黑底白字块（12px Geometos、字距 1px）+
 *   「私人漫游」30px Heavy 字距 1px + 副标题 14px bold muted
 * - MODE 切换面板（右上角 absolute，切角按钮 clip-path）：
 *   trigger（MODE code + 当前模式名 + 箭头）→ 下拉（MODE SELECT 标题 +
 *   3 列网格 5 模式按钮，切角 7px，active 黑底白字；SCENE_RCMD 追加
 *   虚线分隔的子场景行）；切模式即时按新数据源重拉候选池
 * - 封面轮播（fm-cover-carousel）：三槽（left/right 168px、半透明 0.52 +
 *   center 246px），槽为相框样式（6/8px padding + 1px 边框）+ 图 1px 边框；
 *   center 播放遮罩（64px 黑 72% + blur、hover scale 1.04）；side 上下渐变
 *   遮罩；空槽虚线 placeholder（NO PREV / NEXT LOADING / NO NEXT）。
 *   **切歌 FLIP 位移动画**：切换前捕获各槽 offsetLeft，渲染后反向位移再
 *   过渡回位（1.5s cubic-bezier(0.16,1,0.3,1)）；新进入槽按方向
 *   translateX(±20px) scale(0.97) 淡入
 * - fm-actions：prev/next 主按钮（黑底白 icon，原版 SVG path）+
 *   trash/like ghost 按钮（hover/激活红）；喜欢走真实 /like（乐观更新）
 * - 数据：DEFAULT 模式走 /personal_fm；其余模式走 /personal/fm/mode
 *   （mode/submode/limit=6，通用转发）；候选池低水位（<2）自动补拉
 * - 权限：canControl（房主/房管）可操作；观众保留「由房主控制漫游」提示
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Socket } from 'socket.io-client'
import { apiGet, apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { songToUpsertItem, useQueueAdd } from '../hooks/useQueueAdd'
import type { NcmSong } from '../types'
import { cn } from '@/lib/utils'
import { MusicLoginGate, PageBlockHeader } from './MusicLoginGate'

export interface MusicFmPageProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）——FM 播放需经 queue-upsert */
  canManage: boolean
}

/** /personal_fm、/personal/fm/mode 响应条目（网易云结构） */
interface FmSongItem {
  id: number
  name: string
  artists?: Array<{ name?: string }>
  album?: { name?: string; picUrl?: string }
  duration?: number
}

/** FmSongItem → NcmSong */
function mapFmSong(item: FmSongItem): NcmSong {
  return {
    songId: item.id,
    name: item.name,
    artist: (item.artists ?? [])
      .map((a) => a.name)
      .filter(Boolean)
      .join(' / '),
    album: item.album?.name ?? '',
    cover: item.album?.picUrl
      ? `${item.album.picUrl.replace('http://', 'https://')}?param=300y300`
      : '',
    durationMs: item.duration ?? 0,
    vip: false,
  }
}

/** 漫游模式（Hydrogen FM_MODE_OPTIONS） */
const FM_MODE_OPTIONS = [
  { value: 'DEFAULT', label: '默认推荐' },
  { value: 'FAMILIAR', label: '熟悉偏好' },
  { value: 'EXPLORE', label: '探索发现' },
  { value: 'SCENE_RCMD', label: '场景推荐' },
  { value: 'aidj', label: 'AI DJ' },
] as const

/** 场景推荐子模式（Hydrogen FM_SCENE_SUBMODE_OPTIONS） */
const FM_SCENE_SUBMODE_OPTIONS = [
  { value: 'EXERCISE', label: '运动' },
  { value: 'FOCUS', label: '专注' },
  { value: 'NIGHT_EMO', label: '夜晚情绪' },
] as const

/** 每次补拉的候选数量（Hydrogen FM_MODE_REQUEST_LIMIT） */
const FM_MODE_REQUEST_LIMIT = 6
/** 候选池低水位阈值（低于该值触发补拉） */
const FM_POOL_LOW_WATER = 2
/** 封面轮播 FLIP 动画时长（Hydrogen --fm-cover-transition-duration） */
const COVER_SHIFT_DURATION_MS = 1500
/** 封面轮播 FLIP 缓动（Hydrogen --fm-cover-transition-ease） */
const COVER_SHIFT_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
/** 开场动画总时长（Hydrogen PANEL_INTRO_DURATION_MS + BUFFER） */
const PANEL_INTRO_TOTAL_MS = 1540

/** 开场动画 keyframes（Hydrogen fm-outline-grow / corner-reveal / content-reveal） */
const FM_INTRO_STYLE = `
@keyframes zen-fm-outline-grow-x {
  0% { transform: scaleX(0); }
  99% { transform: scaleX(1); }
  100% { transform: none; }
}
@keyframes zen-fm-outline-grow-y {
  0% { transform: scaleY(0); }
  99% { transform: scaleY(1); }
  100% { transform: none; }
}
@keyframes zen-fm-corner-reveal {
  from { opacity: 0; transform: scale(0.78); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes zen-fm-content-reveal {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
`

/** 切角按钮 clip-path（Hydrogen .fm-mode-trigger：右上/左下 8px 切角） */
const TRIGGER_CLIP =
  'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))'
/** 模式按钮切角（7px） */
const MODE_BTN_CLIP =
  'polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))'

/** 上一首实心 SVG（Hydrogen .action-btn.prev path 原样） */
function PrevIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </svg>
  )
}

/** 下一首实心 SVG（Hydrogen .action-btn.next path 原样） */
function NextIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  )
}

/** 不喜欢实心 SVG（Hydrogen .action-btn.trash path 原样） */
function TrashIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
    </svg>
  )
}

/** 喜欢实心 SVG（Hydrogen .action-btn.like path 原样） */
function LikeIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
    </svg>
  )
}

/** 播放遮罩图标（Hydrogen fm-play-overlay path 原样） */
function OverlayPlayIcon() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function OverlayPauseIcon() {
  return (
    <svg
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  )
}

/** 轮播槽位描述（left / center / right） */
interface CoverSlot {
  key: string
  role: 'left' | 'center' | 'right'
  song: NcmSong | null
  placeholderText: string
  clickable: boolean
}

export function MusicFmPage({ socket, roomId, canManage }: MusicFmPageProps) {
  const loginStatus = useMusicStore((s) => s.loginStatus)
  const currentKey = useMusicStore((s) => s.currentKey)
  const isPlaying = useMusicStore((s) => s.isPlaying)
  const { playSong, togglePlay, canControl } = useMusicPlayer()
  const { add } = useQueueAdd(socket, roomId, canManage)

  /** 候选池（待播放的 FM 歌曲队列） */
  const [pool, setPool] = useState<NcmSong[]>([])
  /** 已播放历史（上一首回退用） */
  const [history, setHistory] = useState<NcmSong[]>([])
  /** 页面视图中的当前 FM 歌曲（与播放器 currentKey 对齐） */
  const [current, setCurrent] = useState<NcmSong | null>(null)
  /** 首屏拉取中（fm-loading） */
  const [loading, setLoading] = useState(false)
  /** 右侧候选补拉中（placeholder 文案 NEXT LOADING） */
  const [isPrefetching, setIsPrefetching] = useState(false)
  /** 首屏获取彻底失败（fm-empty + 重试） */
  const [loadFailed, setLoadFailed] = useState(false)

  // ===== 漫游模式（Hydrogen selectedFmMode / selectedFmSubmode） =====
  const [fmMode, setFmMode] = useState<string>('DEFAULT')
  const [fmSubmode, setFmSubmode] = useState<string>('FOCUS')
  const [modePanelOpen, setModePanelOpen] = useState(false)
  const [modeSwitching, setModeSwitching] = useState(false)

  // ===== 开场动画（panel intro；仅挂载时一次） =====
  const [introActive, setIntroActive] = useState(true)
  const [outlineReady, setOutlineReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => {
      setOutlineReady(true)
      setIntroActive(false)
    }, PANEL_INTRO_TOTAL_MS)
    return () => clearTimeout(timer)
  }, [])

  // ===== 喜欢（真实 /like，乐观更新；切歌时重置为未查询态） =====
  const songId = current?.songId ?? null
  const canLike = loginStatus.loggedIn && songId != null && songId > 0
  const [liked, setLiked] = useState(false)
  const [likeBusy, setLikeBusy] = useState(false)

  useEffect(() => {
    if (!canLike || songId == null) return
    let cancelled = false
    const query = async () => {
      try {
        const acc = await apiGet<{
          account?: { id?: number }
          profile?: { userId?: number }
        }>(`/api/music/ncm/account?timestamp=${Date.now()}`)
        if (cancelled) return
        const uid = acc?.data?.account?.id ?? acc?.data?.profile?.userId
        if (!uid) return
        const list = await apiGet<{ ids?: number[] }>(
          `/api/music/ncm/likelist?uid=${uid}&timestamp=${Date.now()}`
        )
        if (cancelled) return
        const ids = list?.data?.ids ?? []
        if (Array.isArray(ids)) setLiked(ids.includes(songId))
      } catch {
        // 静默失败：按钮仍可点（乐观更新），仅初始状态未知
      }
    }
    void query()
    return () => {
      cancelled = true
    }
  }, [canLike, songId])

  /** 切歌重置喜欢乐观态（render 期调整，替代 effect 内同步 setState） */
  const [prevLikedSongId, setPrevLikedSongId] = useState<number | null>(songId)
  if (prevLikedSongId !== songId) {
    setPrevLikedSongId(songId)
    setLiked(false)
    setLikeBusy(false)
  }

  /** 喜欢 / 取消喜欢（乐观更新 + 失败回滚） */
  const handleLike = useCallback(async () => {
    if (!canLike || songId == null || likeBusy) return
    const nextLiked = !liked
    setLiked(nextLiked)
    setLikeBusy(true)
    try {
      await apiGet(
        `/api/music/ncm/like?id=${songId}&like=${nextLiked}&timestamp=${Date.now()}`
      )
    } catch {
      setLiked(!nextLiked)
    } finally {
      setLikeBusy(false)
    }
  }, [canLike, songId, liked, likeBusy])

  // ===== FLIP 轮播动画（切歌前三槽位置捕获 → 渲染后反向位移回位） =====
  /** 槽位 DOM 引用（key → element；offsetLeft 捕获用） */
  const slotElsRef = useRef<Map<string, HTMLDivElement>>(new Map())
  /** 切换前捕获的旧位置（key → offsetLeft） */
  const flipPositionsRef = useRef<Map<string, number> | null>(null)
  /** 本次切换方向（新进入槽的入场方向） */
  const [shiftDirection, setShiftDirection] = useState<
    'next' | 'prev' | 'neutral'
  >('neutral')

  /** 捕获当前三槽布局位置 */
  const captureSlotPositions = useCallback((): Map<string, number> => {
    const map = new Map<string, number>()
    slotElsRef.current.forEach((el, key) => {
      map.set(key, el.offsetLeft)
    })
    return map
  }, [])

  // 渲染后执行 FLIP：有旧位置的槽从旧位置动画回新位置；新进入的槽按方向淡入
  useLayoutEffect(() => {
    const prevPositions = flipPositionsRef.current
    if (!prevPositions) return
    flipPositionsRef.current = null
    const enteringOffset = shiftDirection === 'prev' ? -20 : 20
    slotElsRef.current.forEach((el, key) => {
      const prevLeft = prevPositions.get(key)
      if (prevLeft != null) {
        const dx = prevLeft - el.offsetLeft
        if (Math.abs(dx) < 0.5) return
        el.animate(
          [{ transform: `translate3d(${dx}px, 0, 0)` }, { transform: 'none' }],
          { duration: COVER_SHIFT_DURATION_MS, easing: COVER_SHIFT_EASING }
        )
      } else if (el.dataset.role === 'center' || el.dataset.role === 'right') {
        // 新进入的槽（无旧位置）：按方向从侧翼滑入
        el.animate(
          [
            {
              opacity: 0,
              transform: `translateX(${enteringOffset}px) scale(0.97)`,
            },
            { opacity: 1, transform: 'none' },
          ],
          { duration: COVER_SHIFT_DURATION_MS, easing: COVER_SHIFT_EASING }
        )
      }
    })
  }, [current?.songId, shiftDirection])

  // ===== 数据获取 =====

  /** 拉取一批 FM 候选（DEFAULT → /personal_fm；其余 → /personal/fm/mode） */
  const poolFetchingRef = useRef(false)
  const fetchPool = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (poolFetchingRef.current) return
      poolFetchingRef.current = true
      setLoading(true)
      try {
        let list: FmSongItem[] = []
        if (fmMode === 'DEFAULT') {
          const { data } = await apiGet<{ data?: FmSongItem[] }>(
            '/api/music/ncm/personal_fm'
          )
          list = Array.isArray(data?.data) ? data.data : []
        } else {
          const params = new URLSearchParams({
            mode: fmMode,
            limit: String(FM_MODE_REQUEST_LIMIT),
          })
          if (fmMode === 'SCENE_RCMD') params.set('submode', fmSubmode)
          const { data } = await apiGet<{ data?: FmSongItem[] }>(
            `/api/music/ncm/personal/fm/mode?${params.toString()}`
          )
          list = Array.isArray(data?.data) ? data.data : []
        }
        // 模式接口无数据时回退默认漫游源
        if (list.length === 0 && fmMode !== 'DEFAULT') {
          const { data } = await apiGet<{ data?: FmSongItem[] }>(
            '/api/music/ncm/personal_fm'
          )
          list = Array.isArray(data?.data) ? data.data : []
        }
        if (list.length > 0) {
          setLoadFailed(false)
          const mapped = list.map(mapFmSong).filter((s) => s.songId > 0)
          setPool((prev) => {
            const seen = new Set(prev.map((s) => s.songId))
            const fresh = mapped.filter((s) => !seen.has(s.songId))
            return [...prev, ...fresh]
          })
          // 首屏引导：候选池就绪后展示第一首（不自动播放，交由用户点击）
          setCurrent((prev) => {
            if (prev != null) return prev
            return mapped[0] ?? null
          })
        } else if (!opts?.silent) {
          setLoadFailed(true)
        }
      } catch (err) {
        console.error('[MusicFmPage] 私人漫游获取失败:', err)
        if (!opts?.silent) setLoadFailed(true)
      } finally {
        poolFetchingRef.current = false
        setLoading(false)
      }
    },
    [fmMode, fmSubmode]
  )

  // 登录后拉取首批候选
  useEffect(() => {
    if (!loginStatus.loggedIn) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录态驱动的外部数据请求（setState 均在异步回调中）
    void fetchPool()
  }, [loginStatus.loggedIn, fetchPool])

  /** 候选池低水位补拉（<2 时静默补一批；无下一首时占位显示 NEXT LOADING） */
  const refillPoolIfNeeded = useCallback(
    (opts?: { showPending?: boolean }) => {
      if (opts?.showPending) setIsPrefetching(true)
      void fetchPool({ silent: true }).finally(() => {
        if (opts?.showPending) setIsPrefetching(false)
      })
    },
    [fetchPool]
  )

  /** 把 FM 歌曲加入房间队列并立即播放（canControl 语义） */
  const playFmSong = useCallback(
    (song: NcmSong) => {
      if (!socket || !roomId) {
        message.error('未连接房间')
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
        vip: false,
        order: 0,
        addedBy: '',
      })
      setCurrent(song)
    },
    [socket, roomId, add, playSong]
  )

  /** 封面切换统一入口：捕获旧位置 → 变更状态（FLIP 在 useLayoutEffect 播放） */
  const shiftCover = useCallback(
    (direction: 'next' | 'prev', mutate: () => void) => {
      flipPositionsRef.current = captureSlotPositions()
      setShiftDirection(direction)
      mutate()
    },
    [captureSlotPositions]
  )

  /** 播放下一首：候选池出队 → upsert + playSong（带 FLIP 位移） */
  const handleNext = useCallback(() => {
    if (!canControl) return
    const [next, ...rest] = pool
    if (!next) {
      refillPoolIfNeeded({ showPending: true })
      message.info('漫游候选获取中，请稍后再试')
      return
    }
    shiftCover('next', () => {
      setPool(rest)
      if (rest.length < FM_POOL_LOW_WATER) refillPoolIfNeeded()
    })
    if (current) setHistory((prev) => [...prev, current])
    playFmSong(next)
  }, [canControl, pool, current, shiftCover, playFmSong, refillPoolIfNeeded])

  /** 上一首：沿已播放历史回退（带 FLIP 位移） */
  const handlePrev = useCallback(() => {
    if (!canControl) return
    if (history.length === 0) {
      message.info('没有上一首了')
      return
    }
    const prev = history[history.length - 1]
    shiftCover('prev', () => {
      setHistory((list) => list.slice(0, -1))
      if (current) setPool((p) => [current, ...p])
    })
    playFmSong(prev)
  }, [canControl, history, current, shiftCover, playFmSong])

  /** 大封面播放：已在播当前曲则切播放/暂停，否则播放当前曲（首屏引导） */
  const handleCoverPlay = useCallback(() => {
    if (!canControl) return
    if (current && currentKey === `ncm:${current.songId}`) {
      togglePlay()
      return
    }
    if (current) {
      playFmSong(current)
      return
    }
    handleNext()
  }, [canControl, current, currentKey, togglePlay, playFmSong, handleNext])

  /** 不喜欢：fm_trash 下发 + 自动切下一首 */
  const handleTrash = useCallback(async () => {
    if (!canControl || !current) return
    try {
      await apiPost(`/api/music/ncm/fm_trash?songId=${current.songId}`)
      message.success('已减少类似歌曲推荐')
    } catch (err) {
      console.error('[MusicFmPage] fm_trash 失败:', err)
    }
    if (current) setHistory((prev) => [...prev, current])
    handleNext()
  }, [canControl, current, handleNext])

  // ===== 模式切换（Hydrogen changeFmMode / changeFmSubmode） =====
  const activeModeLabel =
    FM_MODE_OPTIONS.find((m) => m.value === fmMode)?.label ?? '默认推荐'
  const activeSubmodeLabel =
    FM_SCENE_SUBMODE_OPTIONS.find((s) => s.value === fmSubmode)?.label ?? '专注'
  const modeSummary =
    fmMode === 'SCENE_RCMD'
      ? `${activeModeLabel} · ${activeSubmodeLabel}`
      : activeModeLabel

  /** 切模式：清空候选池与历史（保留当前曲）→ 静默按新模式重拉 */
  const changeFmMode = (mode: string) => {
    if (modeSwitching || loading) return
    if (fmMode === mode) return
    setFmMode(mode)
    if (mode === 'SCENE_RCMD') {
      // 场景模式需二次选择子场景：保持面板展开等待选择
      setModePanelOpen(true)
      return
    }
    setFmSubmode('FOCUS')
    setModePanelOpen(false)
    setModeSwitching(true)
    setPool([])
    void fetchPool({ silent: true }).finally(() => setModeSwitching(false))
  }

  const changeFmSubmode = (submode: string) => {
    if (modeSwitching || loading) return
    setFmSubmode(submode)
    setModePanelOpen(false)
    setModeSwitching(true)
    setPool([])
    void fetchPool({ silent: true }).finally(() => setModeSwitching(false))
  }

  // MODE 面板点击外部关闭
  useEffect(() => {
    if (!modePanelOpen) return
    const close = () => setModePanelOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [modePanelOpen])

  if (!loginStatus.loggedIn) {
    return (
      <div className="flex min-h-full flex-col px-6 pb-32 pt-6 md:px-8">
        <PageBlockHeader titleEN="PERSONAL FM" titleCN="私人漫游" />
        <MusicLoginGate hint="登录后开启专属音乐漫游" />
      </div>
    )
  }

  // ===== 三槽槽位推导（Hydrogen coverTrackItems） =====
  const prevCandidate = history.length > 0 ? history[history.length - 1] : null
  const nextCandidate = pool.length > 0 ? pool[0] : null
  const currentIdKey = current?.songId ?? 'none'
  const slots: CoverSlot[] = [
    prevCandidate
      ? {
          key: `song-${prevCandidate.songId}`,
          role: 'left',
          song: prevCandidate,
          placeholderText: '',
          clickable: true,
        }
      : {
          key: `ph-left-${currentIdKey}`,
          role: 'left',
          song: null,
          placeholderText: 'NO PREV',
          clickable: false,
        },
    current
      ? {
          key: `song-${current.songId}`,
          role: 'center',
          song: current,
          placeholderText: '',
          clickable: true,
        }
      : {
          key: 'ph-center',
          role: 'center',
          song: null,
          placeholderText: loading ? 'PREPARING' : 'PLAY',
          clickable: canControl,
        },
    nextCandidate
      ? {
          key: `song-${nextCandidate.songId}`,
          role: 'right',
          song: nextCandidate,
          placeholderText: '',
          clickable: true,
        }
      : {
          key: `ph-right-${currentIdKey}`,
          role: 'right',
          song: null,
          placeholderText: isPrefetching ? 'NEXT LOADING' : 'NO NEXT',
          clickable: false,
        },
  ]

  /** 槽位点击（left → 上一首；center → 播放/暂停；right → 下一首） */
  const handleSlotClick = (slot: CoverSlot) => {
    if (!slot.clickable) return
    if (slot.role === 'left') {
      handlePrev()
      return
    }
    if (slot.role === 'center') {
      handleCoverPlay()
      return
    }
    handleNext()
  }

  const showContent = current != null && !loadFailed
  const showLoading =
    !showContent && (loading || (!loadFailed && current == null))

  return (
    <div className="flex min-h-full justify-center px-6 pb-[118px] pt-3 md:px-8">
      <style>{FM_INTRO_STYLE}</style>
      {/* ===== fm-panel 面板（半透明底 + 四角方块 + 开场动画） ===== */}
      <div
        className={cn(
          'relative w-full max-w-[900px] overflow-hidden px-[34px] pb-6 pt-6',
          'min-h-[max(650px,calc(100vh-64px-140px))]'
        )}
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent)',
          border:
            '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
        }}
      >
        {/* 四角 10px 方块（2px 边框、仅显两边；intro 时 scale 0.78→1 reveal） */}
        {(
          [
            ['tl', 'left-[-1px] top-[-1px] border-r-0 border-b-0'],
            ['tr', 'right-[-1px] top-[-1px] border-l-0 border-b-0'],
            ['bl', 'bottom-[-1px] left-[-1px] border-r-0 border-t-0'],
            ['br', 'bottom-[-1px] right-[-1px] border-l-0 border-t-0'],
          ] as const
        ).map(([pos, cls]) => (
          <span
            key={pos}
            className={cn('absolute h-[10px] w-[10px]', cls)}
            style={{
              borderStyle: 'solid',
              borderWidth: 2,
              borderColor: 'var(--md-sys-color-on-surface)',
              opacity: introActive ? undefined : 1,
              animation: introActive
                ? 'zen-fm-corner-reveal 0.48s cubic-bezier(0.2,0.9,0.2,1) 0.44s both'
                : undefined,
            }}
            aria-hidden="true"
          />
        ))}

        {/* outline-draw：四条 1px 边线从两角展开（0.64s） */}
        <div
          className="pointer-events-none absolute inset-0 z-[3]"
          aria-hidden="true"
        >
          <span
            className="absolute left-0 right-0 top-0 h-px origin-left"
            style={{
              backgroundColor: 'var(--md-sys-color-on-surface)',
              transform: outlineReady ? 'none' : 'scaleX(0)',
              animation: introActive
                ? 'zen-fm-outline-grow-x 0.64s cubic-bezier(0.25,0.9,0.3,1) both'
                : undefined,
            }}
          />
          <span
            className="absolute bottom-0 left-0 right-0 h-px origin-right"
            style={{
              backgroundColor: 'var(--md-sys-color-on-surface)',
              transform: outlineReady ? 'none' : 'scaleX(0)',
              animation: introActive
                ? 'zen-fm-outline-grow-x 0.64s cubic-bezier(0.25,0.9,0.3,1) both'
                : undefined,
            }}
          />
          <span
            className="absolute bottom-0 left-0 top-0 w-px origin-bottom"
            style={{
              backgroundColor: 'var(--md-sys-color-on-surface)',
              transform: outlineReady ? 'none' : 'scaleY(0)',
              animation: introActive
                ? 'zen-fm-outline-grow-y 0.64s cubic-bezier(0.25,0.9,0.3,1) both'
                : undefined,
            }}
          />
          <span
            className="absolute bottom-0 right-0 top-0 w-px origin-top"
            style={{
              backgroundColor: 'var(--md-sys-color-on-surface)',
              transform: outlineReady ? 'none' : 'scaleY(0)',
              animation: introActive
                ? 'zen-fm-outline-grow-y 0.64s cubic-bezier(0.25,0.9,0.3,1) both'
                : undefined,
            }}
          />
        </div>

        {/* ===== MODE 切换面板（右上角，切角按钮 + 下拉） ===== */}
        <div className="absolute right-[22px] top-[18px] z-[8] flex w-[360px] max-w-[calc(100vw-72px)] flex-col items-end">
          <button
            type="button"
            disabled={loading || modeSwitching}
            onClick={(e) => {
              e.stopPropagation()
              setModePanelOpen((v) => !v)
            }}
            className="inline-flex min-h-[30px] min-w-[170px] max-w-[230px] items-center justify-between gap-2 px-2.5 transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
            style={{
              clipPath: TRIGGER_CLIP,
              border:
                '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
              color: 'var(--md-sys-color-on-surface)',
            }}
            title="切换漫游模式"
          >
            <span className="shrink-0 text-[10px] tracking-[0.8px] opacity-80">
              MODE
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-xs font-bold">
              {modeSummary}
            </span>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              className={cn(
                'shrink-0 transition-transform duration-200',
                modePanelOpen && 'rotate-180'
              )}
            >
              <path d="M7 10l5 5 5-5z" />
            </svg>
          </button>

          {modePanelOpen && (
            <div
              className="zen-dropdown-enter mt-2 w-[min(360px,100%)] p-2.5"
              style={{
                border:
                  '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                backgroundColor:
                  'color-mix(in srgb, var(--md-sys-color-surface-container) 97%, transparent)',
                boxShadow: '0 8px 28px rgba(0, 0, 0, 0.2)',
              }}
              role="group"
              aria-label="私人漫游模式"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between gap-1.5">
                <span className="text-[10px] tracking-[0.8px] text-[var(--md-sys-color-on-surface-variant)]">
                  MODE SELECT
                </span>
                <span className="text-xs font-bold text-[var(--md-sys-color-on-surface-variant)]">
                  {modeSummary}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {FM_MODE_OPTIONS.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    disabled={loading || modeSwitching}
                    onClick={() => changeFmMode(mode.value)}
                    className={cn(
                      'inline-flex min-h-[34px] flex-col items-center justify-center gap-0.5 px-1.5 py-[5px] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60'
                    )}
                    style={{
                      clipPath: MODE_BTN_CLIP,
                      border:
                        '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                      backgroundColor:
                        fmMode === mode.value
                          ? 'var(--md-sys-color-on-surface)'
                          : 'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                      color:
                        fmMode === mode.value
                          ? 'var(--md-sys-color-surface)'
                          : 'var(--md-sys-color-on-surface)',
                    }}
                    title={mode.label}
                  >
                    <span className="text-[9px] leading-[1.1] tracking-[0.6px] opacity-80">
                      {mode.value}
                    </span>
                    <span className="whitespace-nowrap text-[11px] font-bold leading-[1.15]">
                      {mode.label}
                    </span>
                  </button>
                ))}
              </div>
              {fmMode === 'SCENE_RCMD' && (
                <div
                  className="mt-2 grid grid-cols-3 gap-1.5 border-t border-dashed pt-2"
                  style={{
                    borderColor:
                      'color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                  }}
                >
                  {FM_SCENE_SUBMODE_OPTIONS.map((scene) => (
                    <button
                      key={scene.value}
                      type="button"
                      disabled={loading || modeSwitching}
                      onClick={() => changeFmSubmode(scene.value)}
                      className="inline-flex min-h-[34px] flex-col items-center justify-center gap-0.5 px-1.5 py-[5px] transition-transform hover:-translate-y-px disabled:cursor-not-allowed disabled:opacity-60"
                      style={{
                        clipPath: MODE_BTN_CLIP,
                        border:
                          '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                        backgroundColor:
                          fmSubmode === scene.value
                            ? 'var(--md-sys-color-on-surface)'
                            : 'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                        color:
                          fmSubmode === scene.value
                            ? 'var(--md-sys-color-surface)'
                            : 'var(--md-sys-color-on-surface)',
                      }}
                      title={scene.label}
                    >
                      <span className="text-[9px] leading-[1.1] tracking-[0.6px] opacity-80">
                        {scene.value}
                      </span>
                      <span className="whitespace-nowrap text-[11px] font-bold leading-[1.15]">
                        {scene.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 内容层（开场 reveal：0.9s 延迟 0.6s，translateY 8px→0） */}
        <div
          className="relative z-[1]"
          style={{
            animation: introActive
              ? 'zen-fm-content-reveal 0.9s cubic-bezier(0.18,0.92,0.28,1) 0.6s both'
              : undefined,
          }}
        >
          {/* ===== fm-header（居中） ===== */}
          <div className="mb-7 text-center">
            <span
              className="inline-block px-3 py-1 text-xs tracking-[1px]"
              style={{
                backgroundColor: 'var(--md-sys-color-on-surface)',
                color: 'var(--md-sys-color-surface)',
              }}
            >
              PERSONAL FM
            </span>
            <h1 className="m-0 mt-3 text-[30px] font-bold leading-tight tracking-[1px] text-[var(--md-sys-color-on-surface)]">
              私人漫游
            </h1>
            <span className="mt-1.5 block text-sm font-bold text-[var(--md-sys-color-on-surface-variant)]">
              根据你的音乐喜好为你推荐
            </span>
          </div>

          {/* ===== 加载中（fm-loading） ===== */}
          {showLoading && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-[var(--md-sys-color-on-surface-variant)]">
              <span
                className="mb-4 block h-10 w-10 animate-spin rounded-full"
                style={{
                  border:
                    '3px solid color-mix(in srgb, var(--md-sys-color-on-surface) 14%, transparent)',
                  borderTopColor: 'var(--md-sys-color-on-surface)',
                }}
                aria-hidden="true"
              />
              <p>正在为你准备音乐...</p>
            </div>
          )}

          {/* ===== 获取失败（fm-empty + 重试） ===== */}
          {loadFailed && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-[var(--md-sys-color-on-surface-variant)]">
              <svg
                width="60"
                height="60"
                viewBox="0 0 24 24"
                fill="currentColor"
                className="mb-4 opacity-60"
                aria-hidden="true"
              >
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
              </svg>
              <p>无法加载漫游歌曲</p>
              <p className="mt-1 text-xs text-[var(--md-sys-color-error)]">
                请检查网络连接或稍后重试
              </p>
              <button
                type="button"
                onClick={() => {
                  setLoadFailed(false)
                  void fetchPool()
                }}
                className="mt-4 flex h-[34px] min-w-[112px] items-center justify-center px-3.5 text-sm font-bold transition-transform hover:-translate-y-px"
                style={{
                  border:
                    '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                  color: 'var(--md-sys-color-on-surface)',
                }}
              >
                重试
              </button>
            </div>
          )}

          {/* ===== fm-content：轮播 + 信息 + 操作 ===== */}
          {showContent && (
            <div className="flex flex-col items-center gap-[26px]">
              <div className="flex flex-col items-center gap-[18px]">
                {/* fm-cover-carousel：三槽轮播（FLIP 位移动画） */}
                <div className="w-[min(760px,100%)] overflow-hidden">
                  <div className="relative flex min-h-[262px] items-center justify-center gap-[50px]">
                    {slots.map((slot) => {
                      const isCenter = slot.role === 'center'
                      const playingThis =
                        slot.song != null &&
                        currentKey === `ncm:${slot.song.songId}` &&
                        isPlaying
                      return (
                        <div
                          key={slot.key}
                          data-role={slot.role}
                          ref={(el) => {
                            if (el) slotElsRef.current.set(slot.key, el)
                            else slotElsRef.current.delete(slot.key)
                          }}
                          role={slot.clickable ? 'button' : undefined}
                          tabIndex={slot.clickable ? 0 : undefined}
                          onClick={() => handleSlotClick(slot)}
                          onKeyDown={(e) => {
                            if (!slot.clickable) return
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              handleSlotClick(slot)
                            }
                          }}
                          className={cn(
                            'relative shrink-0 transition-colors duration-200',
                            isCenter ? 'z-[4]' : 'z-[2]',
                            slot.clickable && 'cursor-pointer'
                          )}
                          style={{
                            width: isCenter ? 246 : 168,
                            height: isCenter ? 246 : 168,
                            padding: isCenter ? 8 : 6,
                            border: `1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)`,
                            backgroundColor:
                              'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
                            opacity: isCenter ? 1 : 0.52,
                            borderStyle: slot.song == null ? 'dashed' : 'solid',
                            willChange: 'transform, opacity',
                            backfaceVisibility: 'hidden',
                          }}
                          title={
                            slot.song == null
                              ? undefined
                              : isCenter
                                ? playingThis
                                  ? '暂停'
                                  : '播放'
                                : slot.role === 'left'
                                  ? '上一首'
                                  : '下一首'
                          }
                        >
                          {slot.song ? (
                            <>
                              <img
                                src={slot.song.cover}
                                alt={slot.song.name}
                                className="block h-full w-full object-cover"
                                style={{
                                  border:
                                    '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                                }}
                                draggable={false}
                              />
                              {isCenter ? (
                                // center 播放遮罩（黑 72% + blur、hover 放大）
                                <span
                                  className={cn(
                                    'absolute left-1/2 top-1/2 z-10 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center transition-all duration-200',
                                    canControl && 'opacity-90'
                                  )}
                                  style={{
                                    backgroundColor:
                                      'color-mix(in srgb, black 72%, transparent)',
                                    border:
                                      '1px solid color-mix(in srgb, black 24%, transparent)',
                                    backdropFilter: 'blur(6px)',
                                    WebkitBackdropFilter: 'blur(6px)',
                                    color: '#ffffff',
                                    pointerEvents: 'none',
                                  }}
                                >
                                  {playingThis ? (
                                    <OverlayPauseIcon />
                                  ) : (
                                    <OverlayPlayIcon />
                                  )}
                                </span>
                              ) : (
                                // side 上下渐变遮罩
                                <span
                                  className="pointer-events-none absolute inset-0"
                                  style={{
                                    background:
                                      'linear-gradient(180deg, rgba(0,0,0,0.12) 0%, rgba(0,0,0,0.22) 100%)',
                                  }}
                                  aria-hidden="true"
                                />
                              )}
                            </>
                          ) : (
                            <span className="flex h-full w-full items-center justify-center text-[11px] font-bold tracking-[0.8px] text-[var(--md-sys-color-on-surface-variant)]">
                              {slot.placeholderText}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* fm-info：歌名 / 歌手 / 专辑 */}
                {current && (
                  <div className="text-center">
                    <h2
                      className="m-0 mb-2 break-all text-[21px] font-bold leading-tight text-[var(--md-sys-color-on-surface)]"
                      title={current.name}
                    >
                      {current.name}
                    </h2>
                    <p className="m-0 mb-1 text-sm font-bold text-[var(--md-sys-color-on-surface-variant)]">
                      {current.artist}
                    </p>
                    {current.album && (
                      <p className="m-0 text-xs font-bold text-[var(--md-sys-color-on-surface-variant)] opacity-70">
                        {current.album}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 观众无权限提示（ZViewer 场景） */}
              {!canControl && (
                <div
                  className="rounded-full px-3 py-1 text-xs"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--md-sys-color-tertiary) 12%, transparent)',
                    color: 'var(--md-sys-color-tertiary)',
                  }}
                >
                  由房主控制漫游
                </div>
              )}

              {/* fm-actions：prev / trash / like / next（原版 SVG） */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  disabled={!canControl}
                  onClick={handlePrev}
                  className="flex h-9 min-w-[64px] items-center justify-center transition-transform hover:-translate-y-px active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    border:
                      '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 30%, transparent)',
                    backgroundColor: 'var(--md-sys-color-on-surface)',
                    color: 'var(--md-sys-color-surface)',
                  }}
                  title="上一首"
                  aria-label="上一首"
                >
                  <PrevIcon />
                </button>
                <button
                  type="button"
                  disabled={!canControl || !current}
                  onClick={() => void handleTrash()}
                  className="group flex h-9 min-w-[64px] items-center justify-center border transition-transform hover:-translate-y-px active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor:
                      'color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                    backgroundColor:
                      'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                    color: 'var(--md-sys-color-on-surface)',
                  }}
                  title="不喜欢"
                  aria-label="不喜欢"
                >
                  <TrashIcon />
                </button>
                <button
                  type="button"
                  disabled={!canLike}
                  onClick={() => void handleLike()}
                  className="flex h-9 min-w-[64px] items-center justify-center border transition-transform hover:-translate-y-px active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor: liked
                      ? 'var(--md-sys-color-error)'
                      : 'color-mix(in srgb, var(--md-sys-color-on-surface) 22%, transparent)',
                    backgroundColor: liked
                      ? 'color-mix(in srgb, var(--md-sys-color-error) 12%, transparent)'
                      : 'color-mix(in srgb, var(--md-sys-color-on-surface) 6%, transparent)',
                    color: liked
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-on-surface)',
                  }}
                  title={liked ? '取消喜欢' : '喜欢'}
                  aria-label={liked ? '取消喜欢' : '喜欢'}
                >
                  <LikeIcon />
                </button>
                <button
                  type="button"
                  disabled={!canControl}
                  onClick={handleNext}
                  className="flex h-9 min-w-[64px] items-center justify-center transition-transform hover:-translate-y-px active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    border:
                      '1px solid color-mix(in srgb, var(--md-sys-color-on-surface) 30%, transparent)',
                    backgroundColor: 'var(--md-sys-color-on-surface)',
                    color: 'var(--md-sys-color-surface)',
                  }}
                  title="下一首"
                  aria-label="下一首"
                >
                  <NextIcon />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
