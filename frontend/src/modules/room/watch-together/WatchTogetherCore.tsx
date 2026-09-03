/**
 * WatchTogetherCore —— 一起看播放器业务核心（ArtPlayer 版）。
 *
 * 由 WatchTogetherPanel（Shell）在 ArtPlayer 实例就绪后渲染。
 * 承担重构前 WatchTogetherPanel 的全部业务逻辑：
 * - useWatchTogether 同步编排（房主广播 / 观众跟随 / 心跳 / 状态恢复）
 * - 观众申请审批（加入 / 跳转 / 暂停 / 继续播放）
 * - B站 官方弹幕加载、多轨道弹幕同步、实时弹幕收发
 * - 字幕轨道管理（自定义 SubtitleOverlay 渲染，保留各格式位置/样式）
 * - B站 清晰度切换（ArtPlayer 原生 selector 控件）
 *
 * UI 通过 createPortal 挂载到 Shell 提供的 ArtPlayer 插槽（弹幕图层 / 覆盖层 / 设置面板），
 * 底部控制栏由 PlayerControlBar 直接渲染为覆盖层。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type Artplayer from 'artplayer'
import { cn, formatDuration } from '@/lib/utils'
import { PlayerControlBar } from './PlayerControlBar'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Spinner } from '@/components/ui/Spinner'
import { Button } from '@/components/ui/Button'
import { useSocket } from '@/hooks/useSocket'
import { useSubtitles, type EmbeddedSource } from '@/hooks/useSubtitles'
import { useCliAgent } from '@/hooks/useCliAgent'
import { useRoomStore } from '@/store/roomStore'
import { useDanmakuStore } from '@/store/danmakuStore'
import { useCliAgentStore } from '@/store/cliAgentStore'
import { getBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import {
  DanmakuLayer,
  type DanmakuLayerHandle,
} from '@/components/DanmakuLayer'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import { useWatchTogether } from './useWatchTogether'
import { fetchBilibiliDanmakuByCid } from '@/modules/danmaku/api'
import type { DanmakuItem } from '@/modules/danmaku/types'
import {
  RequestNotification,
  type RequestNotificationItem,
} from '@/components/ui/RequestNotification'
import type { MediaFormat } from '@/lib/mediaFormat'
import { useVideoPlayingState } from '@/modules/art-player/useVideoPlayingState'
import { SettingsPanel } from '@/components/VideoPlayer/SettingsPanel'
import { SubtitleOverlay } from '@/components/VideoPlayer/SubtitleOverlay'
import { isCliProxyUrl } from '@/modules/player/services/url-proxy'
import type { ArtSlots } from './WatchTogetherPanel'
import {
  isIOSDevice,
  supportsContainerFullscreen,
  getFullscreenElement,
  exitFullscreen,
  requestFullscreen,
  onFullscreenChange,
} from '@/lib/fullscreen-utils'

interface WatchTogetherCoreProps {
  roomId: string
  isHost: boolean
  art: Artplayer
  video: HTMLVideoElement
  videoRef: React.RefObject<HTMLVideoElement | null>
  stageRef: React.RefObject<HTMLDivElement | null>
  slots: ArtSlots
  isWebFullscreen?: boolean
  onToggleWebFullscreen?: () => void
  initialPlayback?: {
    currentTime: number
    isPlaying: boolean
    playbackRate: number
    duration?: number
    sourceUrl?: string
    sourceType?: string
    audioUrl?: string
    format?: MediaFormat
    videoCodec?: string
    audioCodec?: string
    cid?: number
    currentQn?: number
    acceptQuality?: { id: number; label: string; resolution?: string }[]
    currentMovieId?: number
    headers?: Record<string, string>
    updatedAt: number
  } | null
}

export function WatchTogetherCore({
  roomId,
  isHost,
  art,
  video,
  videoRef,
  stageRef,
  slots,
  isWebFullscreen,
  onToggleWebFullscreen,
  initialPlayback,
}: WatchTogetherCoreProps) {
  const { socket } = useSocket()
  // CLI 代理健康检查与 socket 事件监听提升到全局级别，
  // 确保 localOnline/agents 始终更新，不依赖 BilibiliParseSettings 是否渲染。
  useCliAgent(roomId)
  const cliAgentsCount = useCliAgentStore((s) => s.agents.length)
  const triggerReloadBilibili = useRoomStore((s) => s.triggerReloadBilibili)
  const triggerViewerSourceReload = useRoomStore(
    (s) => s.triggerViewerSourceReload
  )
  const setMode = useRoomStore((state) => state.setMode)
  const isReloading = useRoomStore((state) => state.isReloading)
  // 缓冲模式下载进度（房主/观众共享，由 useWatchTogether/useViewerStateSync 写入）
  const bufferProgress = useRoomStore((state) => state.bufferProgress)
  // 观众端本地 CLI 代理覆盖的源（用于统计信息展示）
  const viewerCliResolvedSource = useRoomStore(
    (state) => state.viewerCliResolvedSource
  )
  const currentMovieId = useRoomStore((state) => state.currentMovieId)
  // 当前影片的 directLink 标记，用于统计信息中显示"直链/服务器中转"
  // mp4 直链视频（sourceType='mp4'）实际走浏览器直连源服务器（resolveProxyUrl 返回原 URL），
  // 应显示为"直链"；挂载源（webdav/openlist 等）根据 directLink 字段判断。
  const currentMovieDirectLink = useRoomStore((state) => {
    const m = state.movies.find((mv) => mv.id === state.currentMovieId)
    if (!m) return false
    if (m.sourceType === 'mp4') return true
    return m.directLink ?? false
  })
  // 当前影片的源类型，用于判断是否支持自动搜索字幕
  const currentMovieSourceType = useRoomStore(
    (state) =>
      state.movies.find((m) => m.id === state.currentMovieId)?.sourceType ?? ''
  )
  // 当前影片的服务器文件路径（仅 server-files 源有值），用于加载内嵌字幕
  const currentMoviePath = useRoomStore(
    (state) =>
      state.movies.find((m) => m.id === state.currentMovieId)?.path ?? null
  )
  const {
    watchTogether,
    setWatchTogether,
    forceSync,
    isResolving,
    currentQuality,
    availableQualities,
    reloadVideo,
    reloadBilibili,
    loadMovieError,
    retryLoadMovie,
  } = useWatchTogether({
    roomId,
    isHost,
    videoRef,
    initialPlayback,
  })

  // 字幕状态：房主操作广播同步，观众监听应用
  const subtitles = useSubtitles({ roomId, isHost })

  // 内嵌字幕：源可访问即可（提取已全部前端化，中转/直链均可用）。
  // - server-files：后端本地文件（中转），前端 MKV demux 提取
  // - webdav / openlist 中转或直链：前端 MKV demux 提取（直链时这是
  //   唯一路径，失败静默）
  // - emby / jellyfin：其自带字幕接口，不受直链/中转限制
  const embeddedSource: EmbeddedSource | null = (() => {
    if (currentMovieSourceType === 'server-files' && currentMoviePath) {
      return { kind: 'server-files', path: currentMoviePath }
    }
    // emby / jellyfin：直接调其自带字幕接口，后端始终能访问，不受直链/中转限制
    if (
      (currentMovieSourceType === 'emby' ||
        currentMovieSourceType === 'jellyfin') &&
      currentMovieId != null
    ) {
      return {
        kind: currentMovieSourceType as 'emby' | 'jellyfin',
        movieId: currentMovieId,
      }
    }
    if (
      (currentMovieSourceType === 'webdav' ||
        currentMovieSourceType === 'openlist') &&
      currentMovieId != null &&
      watchTogether.sourceUrl
    ) {
      return {
        kind: currentMovieSourceType as 'webdav' | 'openlist',
        movieId: currentMovieId,
        // 播放 URL（中转或直链）：前端 MKV demux 探测/提取内嵌字幕直接复用
        url: watchTogether.sourceUrl,
        // 直链标记：前端失败时不再回退后端 ffmpeg（后端访问不到直链）
        directLink: currentMovieDirectLink,
      }
    }
    return null
  })()
  const canEnableEmbedded = isHost && embeddedSource !== null

  // ── 音频编码兼容性提示 ──────────────────────────────
  // 浏览器 <video> 仅支持 AAC/MP3/Opus/FLAC 等少数音频编码。
  // DTS/AC3/EAC3 等编码的处理方式：
  // - emby/jellyfin 源：resolve 阶段自动切换为远端媒体服务器转码 HLS
  // - 浏览器端转码引擎（playsvideo）：在浏览器内重封装容器并将不兼容
  //   音轨实时转码为 AAC（中转与直链均支持，无需服务端 FFmpeg）
  // - 开关关闭：直推原始流，视频可能无声——提示用户到管理后台开启开关。
  const BROWSER_SUPPORTED_AUDIO = new Set([
    'aac',
    'mp3',
    'opus',
    'vorbis',
    'flac',
  ])
  const lastAudioNoticeRef = useRef('')
  useEffect(() => {
    if (!watchTogether.sourceUrl) return
    const codec = watchTogether.audioCodec?.toLowerCase()
    if (!codec || BROWSER_SUPPORTED_AUDIO.has(codec)) return

    // 同一影片+编码只提示一次，避免每次 state 更新都弹
    const key = `${currentMovieId ?? ''}:${codec}`
    if (lastAudioNoticeRef.current === key) return
    lastAudioNoticeRef.current = key

    if (
      currentMovieSourceType === 'emby' ||
      currentMovieSourceType === 'jellyfin'
    ) {
      addPlayerNotice(
        `音轨编码 ${codec.toUpperCase()} 不受浏览器支持，已由媒体服务器转码为 AAC`,
        'info'
      )
    } else {
      // 本地文件 / WebDAV / OpenList / FTP / 直链源：playsvideo 引擎会
      // 在起播时探测并自行决定直通或转码，无需任何开关许可。
      addPlayerNotice(
        `音轨编码 ${codec.toUpperCase()} 不受浏览器支持，playsvideo 引擎正在浏览器内实时转码为 AAC`,
        'info'
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    watchTogether.sourceUrl,
    watchTogether.audioCodec,
    currentMovieId,
    currentMovieSourceType,
  ])

  // ── 切换影片时自动搜索同目录字幕 + 内嵌字幕 ──────────────
  // 当房主切换到新影片时，清空旧字幕并：
  // - WebDAV/FTP/OpenList/服务器文件：在影片所在目录中搜索同名字幕文件
  // - 服务器文件/挂载源：额外探测并提取视频内嵌字幕轨道（自研前端
  //   MKV demux 提取器，与播放引擎解耦——只要文件 URL 就能跑）
  // 其他源类型（如 bilibili）仅清空旧字幕。
  // 观众端不搜索外挂字幕（跟随房主广播），但同样本地提取内嵌字幕
  // （seek 感知：观众跟随房主跳转后字幕秒级可用，不依赖房主广播快照）。
  const supportedSubtitleSources = ['webdav', 'ftp', 'openlist', 'server-files']
  useEffect(() => {
    if (currentMovieId == null) return
    if (isHost) {
      // 先清空旧字幕（切换影片时旧字幕不再适用）
      subtitles.clearTracks()
      // 支持的源类型才触发自动搜索
      if (supportedSubtitleSources.includes(currentMovieSourceType)) {
        void subtitles.searchAutoSubtitles(currentMovieId)
      }
    }
    // 内嵌字幕探测需预取数 MB 文件头并占用同源连接（HTTP/1.1 同源仅
    // 6 并发），延迟到视频首帧拉流之后发起，避免拖慢初次加载
    let embeddedTimer: ReturnType<typeof setTimeout> | undefined
    if (currentMovieSourceType === 'server-files' && currentMoviePath) {
      embeddedTimer = setTimeout(() => {
        void subtitles.loadEmbeddedSubtitles(
          currentMoviePath,
          undefined,
          // seek 感知：稀疏提取优先处理播放位置附近（跳转后字幕秒级可用）
          () => videoRef.current?.currentTime ?? null
        )
      }, 3000)
    }
    // 挂载源（webdav/openlist，中转或直链）：前端 MKV demux 提取内嵌
    // 字幕轨道（直链时这是唯一可用路径）
    if (
      (currentMovieSourceType === 'webdav' ||
        currentMovieSourceType === 'openlist') &&
      watchTogether.sourceUrl
    ) {
      embeddedTimer = setTimeout(() => {
        void subtitles.loadEmbeddedSubtitles(
          currentMoviePath ?? '',
          watchTogether.sourceUrl,
          () => videoRef.current?.currentTime ?? null
        )
      }, 3000)
    }
    return () => clearTimeout(embeddedTimer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    currentMovieId,
    isHost,
    currentMovieSourceType,
    currentMoviePath,
    watchTogether.sourceUrl,
  ])

  // ── CLI 代理上线后自动重新加载 ──────────────────────────
  // 页面刷新时 loadMovie 在 cliAgentStore.agents 填充之前就执行了，
  // 导致 CLI 代理 URL 未被包装到视频源上（getActiveCliProxyUrl 返回 null）。
  // 当 agents 从空变为非空时，若当前影片已启用 CLI 但视频源尚未走 CLI 代理，
  // 自动触发重新加载以应用 CLI 代理。
  const prevCliAgentsCountRef = useRef(0)
  // CLI 上线自动重载的冷却时间戳：CLI 掉线重连（1→0→1）等场景 60s 内不重复触发
  const lastCliAutoReloadAtRef = useRef(0)
  useEffect(() => {
    const prev = prevCliAgentsCountRef.current
    prevCliAgentsCountRef.current = cliAgentsCount
    // 仅在 agents 从 0 变为 >0 时触发（CLI 代理刚上线）
    if (prev !== 0 || cliAgentsCount === 0) return
    if (currentMovieId == null) return
    const { cliEnabled } = getBilibiliParseOptions(currentMovieId)
    if (!cliEnabled) return
    const state = useRoomStore.getState().watchTogether
    if (state.sourceType !== 'bilibili' || !state.sourceUrl) return
    // 当前源已经在走 CLI 代理：无需重载（避免 CLI 掉线重连时重复全量重解析）
    if (isCliProxyUrl(state.sourceUrl) || isCliProxyUrl(state.audioUrl ?? '')) {
      return
    }
    // 冷却：60s 内只自动重载一次
    const now = Date.now()
    if (now - lastCliAutoReloadAtRef.current < 60_000) return
    lastCliAutoReloadAtRef.current = now
    if (isHost) {
      triggerReloadBilibili()
    } else {
      triggerViewerSourceReload()
    }
  }, [
    cliAgentsCount,
    currentMovieId,
    isHost,
    triggerReloadBilibili,
    triggerViewerSourceReload,
  ])

  // ── 观众申请状态（与重构前一致）─────────────────────────
  const [confirmJoin, setConfirmJoin] = useState<{
    viewerSocketId: string
  } | null>(null)
  // 合并后的申请状态（P2-Opt#11）：支持多观众合并
  const [seekRequest, setSeekRequest] = useState<{
    /** 申请者 socket ID 列表 */
    viewerSocketIds: string[]
    /** 申请者用户名列表（用于展示） */
    viewerUsernames: string[]
    /** 目标时间 */
    time: number
    /** 合并窗口开始时间戳，用于判断是否在 5s 合并窗口内 */
    windowStart: number
  } | null>(null)
  const [pauseRequest, setPauseRequest] = useState<{
    viewerSocketIds: string[]
    viewerUsernames: string[]
    windowStart: number
  } | null>(null)
  const [playRequest, setPlayRequest] = useState<{
    viewerSocketIds: string[]
    viewerUsernames: string[]
    windowStart: number
  } | null>(null)
  const [seekPending, setSeekPending] = useState(false)
  const [pausePending, setPausePending] = useState(false)
  const [playPending, setPlayPending] = useState(false)
  // 申请超时 ref：房主不回应时自动清除 pending，避免永久阻塞
  const seekPendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const pausePendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const playPendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  // 镜像 pending 状态到 ref（response 事件闭包读取最新值，避免 stale closure）
  const seekPendingRef = useRef(false)
  const pausePendingRef = useRef(false)
  const playPendingRef = useRef(false)
  useEffect(() => {
    seekPendingRef.current = seekPending
  }, [seekPending])
  useEffect(() => {
    pausePendingRef.current = pausePending
  }, [pausePending])
  useEffect(() => {
    playPendingRef.current = playPending
  }, [playPending])

  // ── 房主离线状态 ──────────────────────────────────────
  // 房主离开后观众进入自主控制模式，可直接 play/pause/seek，无需向房主申请。
  // 房主重连后恢复申请模式。
  const [hostOffline, setHostOffline] = useState(false)

  const autoApproveRequests = useRoomStore((state) => state.autoApproveRequests)
  const autoApproveRef = useRef(autoApproveRequests)
  useEffect(() => {
    autoApproveRef.current = autoApproveRequests
  }, [autoApproveRequests])

  // 监听房主离线/重连（仅观众）
  useEffect(() => {
    if (!socket || isHost) return
    const handleHostDisconnected = () => setHostOffline(true)
    const handleHostReconnect = () => setHostOffline(false)
    socket.on('host-disconnected', handleHostDisconnected)
    socket.on('sharer-ready', handleHostReconnect)
    return () => {
      socket.off('host-disconnected', handleHostDisconnected)
      socket.off('sharer-ready', handleHostReconnect)
    }
  }, [socket, isHost])

  // ── 弹幕状态 ─────────────────────────────────────────
  const danmakuLayerRef = useRef<DanmakuLayerHandle | null>(null)
  const danmakuItemsRef = useRef<DanmakuItem[]>([])
  const loadedTracksRef = useRef<Set<string>>(new Set())
  const [danmakuEnabled, setDanmakuEnabled] = useState(true)

  const tracks = useDanmakuStore((state) => state.tracks)
  const tracksRef = useRef(tracks)
  useEffect(() => {
    tracksRef.current = tracks
  }, [tracks])
  const style = useDanmakuStore((state) => state.style)
  const blockKeywords = useDanmakuStore((state) => state.blockKeywords)
  const setDefaultTrack = useDanmakuStore((state) => state.setDefaultTrack)
  const setStyle = useDanmakuStore((state) => state.setStyle)
  const setFilters = useDanmakuStore((state) => state.setFilters)
  const setAdvancedStyle = useDanmakuStore((state) => state.setAdvancedStyle)
  const resetStyle = useDanmakuStore((state) => state.resetStyle)
  const addRealtime = useDanmakuStore((state) => state.addRealtime)

  // ── 面板开关 ─────────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false)

  // ── 播放器内通知（左上角文字提示）────────────────────────
  const [playerNotices, setPlayerNotices] = useState<
    { id: number; text: string; type: 'info' | 'success' | 'error' }[]
  >([])
  const noticeIdRef = useRef(0)
  const addPlayerNotice = useCallback(
    (text: string, type: 'info' | 'success' | 'error' = 'info') => {
      const id = ++noticeIdRef.current
      setPlayerNotices((prev) => [...prev, { id, text, type }])
      setTimeout(() => {
        setPlayerNotices((prev) => prev.filter((n) => n.id !== id))
      }, 3500)
    },
    []
  )

  // ── 控制栏显隐状态 ────────────────────────────────────
  // ── 移动端检测：粗指针（触屏）或支持多点触控即视为移动端 ──
  const isMobile = useMemo(
    () =>
      typeof window !== 'undefined' &&
      (navigator.maxTouchPoints > 0 ||
        window.matchMedia('(pointer: coarse)').matches),
    []
  )

  // 控制栏可见性：移动端默认隐藏（触摸显示），桌面端默认显示
  const [controlBarVisible, setControlBarVisible] = useState(!isMobile)
  const [controlBarHideMode, setControlBarHideMode] = useState(false)
  const controlBarCooldownRef = useRef<number>(0)
  const controlBarIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  // ── 原生全屏状态跟踪 ────────────────────────────────
  // iOS 不支持容器全屏，全屏状态由 isWebFullscreen 提供；
  // 非 iOS 使用跨平台 Fullscreen API 监听原生全屏状态变化。
  const iosDevice = useMemo(() => isIOSDevice(), [])
  const [isNativeFs, setIsNativeFs] = useState(false)

  useEffect(() => {
    if (iosDevice) return
    const onFsChange = () => {
      const active = Boolean(getFullscreenElement())
      setIsNativeFs(active)
      // 容器全屏切换后触发全局 resize，帮助 ArtPlayer / 浏览器
      // 重新计算 video 容器尺寸，避免某些浏览器下 MSE video 黑屏。
      window.dispatchEvent(new Event('resize'))
    }
    const dispose = onFullscreenChange(onFsChange)
    return dispose
  }, [iosDevice])

  // iOS 降级：原生全屏状态等同于网页全屏状态
  const isFullscreen = iosDevice ? Boolean(isWebFullscreen) : isNativeFs

  const handleToggleFullscreen = useCallback(() => {
    // iOS 不支持对 div 容器的原生全屏，降级为网页全屏（CSS 模拟全屏）。
    // 网页全屏保留自定义控制栏、弹幕层等所有 UI。
    if (iosDevice || !supportsContainerFullscreen()) {
      onToggleWebFullscreen?.()
      return
    }
    // 对 .zart-stage 容器全屏，而非 video 元素本身。
    // 原因：对 video 全屏后，ArtPlayer 的控制栏、弹幕层、设置面板等 UI
    // 都在 video 的祖先容器上，全屏后被 video 遮挡导致用户无法操作（卡死）。
    // 对 .zart-stage 全屏后，容器内所有 UI 可见可操作。
    // 全屏元素进入 top layer 后脱离祖先合成层，不受 Card 的
    // backdrop-filter / will-change: transform 影响。
    const stage = stageRef.current
    if (!stage) return
    if (getFullscreenElement()) {
      void exitFullscreen()
    } else {
      void requestFullscreen(stage).catch(() => {
        // 原生全屏失败时降级为网页全屏
        onToggleWebFullscreen?.()
      })
    }
  }, [stageRef, iosDevice, onToggleWebFullscreen])

  // ── 控制栏显隐逻辑 ────────────────────────────────────
  // 桌面端：鼠标 2s 内无移动即自动隐藏，暂停时不强制显示。
  // 移动端：默认隐藏，手指触摸屏幕时显示，3s 后自动隐藏。
  // 开启“隐藏模式”后，点击按钮立即隐藏并进入 2s 冷却，冷却期间任何方式都无法显示，
  // 冷却结束后仅当指针位于播放器底部时才显示（桌面端）/ 触摸即显示（移动端）。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    const BOTTOM_HEIGHT = 80
    // 移动端触摸显示后 3s 自动隐藏；桌面端鼠标空闲 2s 自动隐藏
    const HIDE_DELAY = isMobile ? 3000 : 2000

    const clearIdleTimer = () => {
      if (controlBarIdleTimerRef.current) {
        clearTimeout(controlBarIdleTimerRef.current)
        controlBarIdleTimerRef.current = null
      }
    }

    const scheduleIdleHide = () => {
      clearIdleTimer()
      controlBarIdleTimerRef.current = setTimeout(() => {
        setControlBarVisible(false)
      }, HIDE_DELAY)
    }

    const handlePointerMove = (e: PointerEvent) => {
      if (controlBarHideMode) {
        const now = Date.now()
        if (now < controlBarCooldownRef.current) {
          // 冷却期间无视任何显示请求
          scheduleIdleHide()
          return
        }
        const rect = stage.getBoundingClientRect()
        const inBottom = e.clientY >= rect.bottom - BOTTOM_HEIGHT
        setControlBarVisible(inBottom)
        scheduleIdleHide()
        return
      }
      setControlBarVisible(true)
      // 触摸滑动：手指按住期间一直显示，不启动隐藏计时，松开后再计时
      if (e.pointerType === 'touch') {
        clearIdleTimer()
        return
      }
      scheduleIdleHide()
    }

    const handlePointerLeave = (e: PointerEvent) => {
      // 触摸场景不因 pointerleave 隐藏：触摸的显隐由 pointerup / touch 事件控制
      // （部分浏览器触摸时会派发 pointerleave，若在此隐藏会导致控制栏刚显示就消失）
      if (e.pointerType === 'touch') return
      setControlBarVisible(false)
      clearIdleTimer()
    }

    const handlePointerDown = (e: PointerEvent) => {
      setControlBarVisible(true)
      // 移动端触摸：按住期间一直显示，松开（pointerup）后再计时隐藏
      if (e.pointerType === 'touch' && !controlBarHideMode) {
        clearIdleTimer()
        return
      }
      handlePointerMove(e)
    }

    const handlePointerUp = (e: PointerEvent) => {
      // 触摸松开：开始 3s 隐藏倒计时
      if (e.pointerType === 'touch' && !controlBarHideMode) {
        scheduleIdleHide()
      }
    }

    // ── touch 事件兜底（旧设备 / 不支持 PointerEvent 的浏览器）────
    const handleTouchStart = () => {
      setControlBarVisible(true)
      if (!controlBarHideMode) {
        clearIdleTimer()
      }
    }
    const handleTouchMove = () => {
      // 触摸滑动：手指按住期间一直显示，不启动隐藏计时
      setControlBarVisible(true)
      if (!controlBarHideMode) {
        clearIdleTimer()
      }
    }
    const handleTouchEnd = () => {
      // 触摸松开：开始 3s 隐藏倒计时
      if (!controlBarHideMode) {
        scheduleIdleHide()
      }
    }

    stage.addEventListener('pointermove', handlePointerMove)
    stage.addEventListener('pointerleave', handlePointerLeave)
    stage.addEventListener('pointerdown', handlePointerDown)
    // pointerup 绑到 window：确保手指在任意位置松开都能触发隐藏计时
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    // touch 兜底
    stage.addEventListener('touchstart', handleTouchStart, { passive: true })
    stage.addEventListener('touchmove', handleTouchMove, { passive: true })
    stage.addEventListener('touchend', handleTouchEnd, { passive: true })
    stage.addEventListener('touchcancel', handleTouchEnd, { passive: true })

    if (!isMobile) {
      // 桌面端：初始默认显示，随后按空闲逻辑自动隐藏
      scheduleIdleHide()
    }
    // 移动端：初始已隐藏（见 useState 初始值），触摸屏幕时显示并 3s 后自动隐藏

    return () => {
      stage.removeEventListener('pointermove', handlePointerMove)
      stage.removeEventListener('pointerleave', handlePointerLeave)
      stage.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      stage.removeEventListener('touchstart', handleTouchStart)
      stage.removeEventListener('touchmove', handleTouchMove)
      stage.removeEventListener('touchend', handleTouchEnd)
      stage.removeEventListener('touchcancel', handleTouchEnd)
      clearIdleTimer()
    }
  }, [stageRef, controlBarHideMode, isMobile])

  const handleToggleHideMode = useCallback(() => {
    setControlBarHideMode((prev) => {
      const next = !prev
      if (next) {
        setControlBarVisible(false)
        controlBarCooldownRef.current = Date.now() + 2000
      } else {
        setControlBarVisible(true)
        controlBarCooldownRef.current = 0
      }
      return next
    })
  }, [])

  // 加载 B站 官方弹幕：缓存后通过 DanmakuLayer 时间轴弹幕接口加载
  useEffect(() => {
    const cid = watchTogether.cid
    if (!cid || watchTogether.sourceType !== 'bilibili') {
      danmakuItemsRef.current = []
      setDefaultTrack([])
      danmakuLayerRef.current?.loadDanmakuTrack('default', [])
      danmakuLayerRef.current?.clear()
      return
    }
    // 切换B站视频时立即清空旧弹幕，避免异步加载新弹幕期间
    // 旧弹幕仍保留在 danmaku.js comments 数组中被重新发射
    danmakuLayerRef.current?.loadDanmakuTrack('default', [])
    danmakuLayerRef.current?.clear()
    fetchBilibiliDanmakuByCid(cid)
      .then((items) => {
        danmakuItemsRef.current = items
        setDefaultTrack(items)
        danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
        danmakuLayerRef.current?.seek(videoRef.current?.currentTime ?? 0)
      })
      .catch((err) => {
        console.error('[WatchTogether] load danmaku error:', err)
      })
  }, [watchTogether.cid, watchTogether.sourceType, setDefaultTrack, videoRef])

  // 弹幕开关重新开启时，重新加载当前时间轴弹幕并 seek 到当前时间
  useEffect(() => {
    if (!danmakuEnabled) return
    const items = danmakuItemsRef.current
    if (items.length > 0) {
      danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
      danmakuLayerRef.current?.seek(videoRef.current?.currentTime ?? 0)
    }
  }, [danmakuEnabled, videoRef])

  // 同步 store 中的轨道变化到弹幕引擎
  useEffect(() => {
    const layer = danmakuLayerRef.current
    if (!layer) return
    const current = new Set<string>()
    tracks.forEach((track) => {
      if (track.hidden) {
        return
      }
      layer.loadDanmakuTrack(track.trackId, track.items, track.offset)
      current.add(track.trackId)
    })
    loadedTracksRef.current.forEach((id) => {
      if (!current.has(id)) {
        layer.removeDanmakuTrack(id)
      }
    })
    loadedTracksRef.current = current
  }, [tracks])

  // 侧栏屏蔽 / 删除弹幕后刷新弹幕层：先以最新轨道数据重新加载引擎，
  // 再清屏并按当前时间重载，避免 tracks 与 refreshSignal 效果时序不一致
  // 导致被删除/恢复的弹幕仍被渲染。
  const refreshSignal = useDanmakuStore((state) => state.refreshSignal)
  useEffect(() => {
    const layer = danmakuLayerRef.current
    if (!layer) return
    // 使用 ref 读取最新 tracks，确保清屏前引擎已应用删除/恢复后的数据
    tracksRef.current.forEach((track) => {
      if (track.hidden) return
      layer.loadDanmakuTrack(track.trackId, track.items, track.offset)
    })
    const current = videoRef.current?.currentTime ?? 0
    layer.clear()
    layer.seek(current)
    // 立即按当前时间补发当前窗口内的弹幕，避免等待下一次 timeupdate，
    // 让删除/恢复后的画面立刻呈现剩余弹幕。
    layer.syncTime(current)
  }, [refreshSignal, videoRef, tracksRef])

  // 实时弹幕接收（'danmaku' 事件）：上屏 + 记录到实时弹幕列表
  useEffect(() => {
    if (!socket) return
    const handleDanmaku = (payload: {
      id?: string
      text: string
      sender?: string
    }) => {
      if (!payload?.text) return
      danmakuLayerRef.current?.sendDanmaku(payload.text, {
        sender: payload.sender,
      })
      addRealtime({
        id:
          payload.id ??
          `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: payload.text,
        sender: payload.sender,
        time: videoRef.current?.currentTime ?? 0,
      })
    }
    socket.on('danmaku', handleDanmaku)
    return () => {
      socket.off('danmaku', handleDanmaku)
    }
  }, [socket, addRealtime, videoRef])

  // 视频加载后，仅在 store 中尚未获得权威 duration 时，用 video.duration 兜底填充。
  useEffect(() => {
    const storeDuration = useRoomStore.getState().watchTogether.duration
    if (Number.isFinite(storeDuration) && storeDuration > 0) return

    const detectDuration = () => {
      // 1. video.dataset.serverDuration（转码流场景，由 direct-engine HEAD 请求获取）
      const sd = video.dataset.serverDuration
      if (sd) {
        const d = parseFloat(sd)
        if (Number.isFinite(d) && d > 0) {
          setWatchTogether({ duration: d })
          return true
        }
      }
      // 2. video.duration（原生支持的格式）
      if (video.duration && isFinite(video.duration) && video.duration > 0) {
        setWatchTogether({ duration: video.duration })
        return true
      }
      // 3. video.seekable 末尾（fragmented MP4 转码流场景，duration=Infinity）
      if (video.seekable && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1)
        if (isFinite(end) && end > 0) {
          setWatchTogether({ duration: end })
          return true
        }
      }
      return false
    }

    const handleLoadedMetadata = () => {
      detectDuration()
    }
    const handleProgress = () => {
      detectDuration()
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('progress', handleProgress)
    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('progress', handleProgress)
    }
  }, [video, setWatchTogether])

  // ── 字幕渲染 ────────────────────────────────────────────
  // 使用自定义 SubtitleOverlay 组件渲染字幕，不再依赖 <track> + ::cue。
  // SubtitleOverlay 监听 video 时间更新，根据 ParsedCue[] 的位置/对齐信息
  // 用 HTML/CSS 直接渲染，保留各字幕格式的完整样式。
  const activeSubtitleCues =
    subtitles.subtitleEnabled && subtitles.activeTrackIndex >= 0
      ? (subtitles.subtitleTracks[subtitles.activeTrackIndex]?.cues ?? [])
      : []

  // ── 观众申请处理（socket 逻辑与重构前一致）─────────────────
  useEffect(() => {
    if (!socket || !isHost) return

    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      setConfirmJoin({ viewerSocketId: data.viewerSocketId })
    }

    socket.on('join-request', handleJoinRequest)
    return () => {
      socket.off('join-request', handleJoinRequest)
    }
  }, [socket, isHost])

  useEffect(() => {
    if (!socket || !isHost) return

    const handleSeekRequest = (data: {
      viewerSocketId: string
      viewerUsername?: string
      time: number
    }) => {
      if (!data?.viewerSocketId) return
      if (autoApproveRef.current) {
        if (Number.isFinite(data.time) && videoRef.current) {
          videoRef.current.currentTime = data.time
        }
        socket.emit(
          'seek-response',
          {
            roomId,
            viewerSocketId: data.viewerSocketId,
            accept: true,
            time: data.time,
          },
          () => {
            /* ack */
          }
        )
        return
      }
      // P2-Opt#11：多观众申请合并——5s 内同目标时间的 seek 合并为一条
      setSeekRequest((prev) => {
        if (
          prev &&
          prev.time === data.time &&
          Date.now() - prev.windowStart < 5000
        ) {
          return {
            ...prev,
            viewerSocketIds: [...prev.viewerSocketIds, data.viewerSocketId],
            viewerUsernames: data.viewerUsername
              ? [...prev.viewerUsernames, data.viewerUsername]
              : prev.viewerUsernames,
          }
        }
        return {
          viewerSocketIds: [data.viewerSocketId],
          viewerUsernames: data.viewerUsername ? [data.viewerUsername] : [],
          time: data.time,
          windowStart: Date.now(),
        }
      })
    }

    socket.on('seek-request', handleSeekRequest)
    return () => {
      socket.off('seek-request', handleSeekRequest)
    }
  }, [socket, isHost, roomId, videoRef])

  useEffect(() => {
    if (!socket || !isHost) return

    const handlePauseRequest = (data: {
      viewerSocketId: string
      viewerUsername?: string
    }) => {
      if (!data?.viewerSocketId) return
      if (autoApproveRef.current) {
        videoRef.current?.pause()
        socket.emit(
          'pause-response',
          { roomId, viewerSocketId: data.viewerSocketId, accept: true },
          () => {
            /* ack */
          }
        )
        return
      }
      // P2-Opt#11：5s 内合并 pause 申请
      setPauseRequest((prev) => {
        if (prev && Date.now() - prev.windowStart < 5000) {
          return {
            ...prev,
            viewerSocketIds: [...prev.viewerSocketIds, data.viewerSocketId],
            viewerUsernames: data.viewerUsername
              ? [...prev.viewerUsernames, data.viewerUsername]
              : prev.viewerUsernames,
          }
        }
        return {
          viewerSocketIds: [data.viewerSocketId],
          viewerUsernames: data.viewerUsername ? [data.viewerUsername] : [],
          windowStart: Date.now(),
        }
      })
    }

    socket.on('pause-request', handlePauseRequest)
    return () => {
      socket.off('pause-request', handlePauseRequest)
    }
  }, [socket, isHost, roomId, videoRef])

  useEffect(() => {
    if (!socket || !isHost) return

    const handlePlayRequest = (data: {
      viewerSocketId: string
      viewerUsername?: string
    }) => {
      if (!data?.viewerSocketId) return
      if (autoApproveRef.current) {
        if (videoRef.current) {
          void videoRef.current.play().catch(() => {
            /* 浏览器自动播放策略可能拒绝，忽略 */
          })
        }
        socket.emit(
          'play-response',
          { roomId, viewerSocketId: data.viewerSocketId, accept: true },
          () => {
            /* ack */
          }
        )
        return
      }
      setPlayRequest((prev) => {
        if (prev && Date.now() - prev.windowStart < 5000) {
          return {
            ...prev,
            viewerSocketIds: [...prev.viewerSocketIds, data.viewerSocketId],
            viewerUsernames: data.viewerUsername
              ? [...prev.viewerUsernames, data.viewerUsername]
              : prev.viewerUsernames,
          }
        }
        return {
          viewerSocketIds: [data.viewerSocketId],
          viewerUsernames: data.viewerUsername ? [data.viewerUsername] : [],
          windowStart: Date.now(),
        }
      })
    }

    socket.on('play-request', handlePlayRequest)
    return () => {
      socket.off('play-request', handlePlayRequest)
    }
  }, [socket, isHost, roomId, videoRef])

  // 观众：监听房主对申请的回应
  useEffect(() => {
    if (!socket || isHost) return

    const handleSeekResponse = (data: { accept: boolean; time?: number }) => {
      if (!seekPendingRef.current) return
      setSeekPending(false)
      if (seekPendingTimeoutRef.current) {
        clearTimeout(seekPendingTimeoutRef.current)
        seekPendingTimeoutRef.current = null
      }
      if (data?.accept) {
        // 自动通过模式下申请时已提示“已跳转”，此处不再重复提示
        if (!autoApproveRef.current) {
          addPlayerNotice(
            `房主已同意跳转到 ${formatDuration(data.time ?? 0)}`,
            'success'
          )
        }
      } else {
        addPlayerNotice('房主拒绝了您的跳转申请', 'info')
      }
    }
    const handlePauseResponse = (data: { accept: boolean }) => {
      if (!pausePendingRef.current) return
      setPausePending(false)
      if (pausePendingTimeoutRef.current) {
        clearTimeout(pausePendingTimeoutRef.current)
        pausePendingTimeoutRef.current = null
      }
      if (data?.accept) {
        // 房主同意暂停：主动暂停 video，确保 isPlaying 状态正确。
        // 房主端 video 可能已经处于暂停状态（如重复申请暂停），
        // 此时 video.pause() 不触发 'pause' 事件，handlePause 不执行，
        // sendControl('pause') 不发送，观众端 isPlaying 不会更新，
        // 导致按钮始终显示"申请暂停"而非"申请继续播放"。
        const video = videoRef.current
        if (video && !video.paused) {
          video.pause()
        }
        // 自动通过模式下申请时已提示“已暂停”，此处不再重复提示
        if (!autoApproveRef.current) {
          addPlayerNotice('房主已同意暂停', 'success')
        }
      } else {
        addPlayerNotice('房主拒绝了您的暂停申请', 'info')
      }
    }
    const handlePlayResponse = (data: { accept: boolean }) => {
      if (!playPendingRef.current) return
      setPlayPending(false)
      if (playPendingTimeoutRef.current) {
        clearTimeout(playPendingTimeoutRef.current)
        playPendingTimeoutRef.current = null
      }
      if (data?.accept) {
        // 房主同意播放：主动播放 video，确保 isPlaying 状态正确。
        // 房主端 video.play() 可能被浏览器自动播放策略拒绝，
        // 'play' 事件不触发，sendControl('play') 不发送，
        // 观众端 isPlaying 不会更新，导致按钮始终显示"申请继续播放"。
        const video = videoRef.current
        if (video && video.paused) {
          void video.play().catch(() => {
            /* 浏览器自动播放策略可能拒绝，忽略 */
          })
        }
        // 自动通过模式下申请时已提示“继续播放”，此处不再重复提示
        if (!autoApproveRef.current) {
          addPlayerNotice('房主已同意继续播放', 'success')
        }
      } else {
        addPlayerNotice('房主拒绝了您的继续播放申请', 'info')
      }
    }

    socket.on('seek-response', handleSeekResponse)
    socket.on('pause-response', handlePauseResponse)
    socket.on('play-response', handlePlayResponse)
    return () => {
      socket.off('seek-response', handleSeekResponse)
      socket.off('pause-response', handlePauseResponse)
      socket.off('play-response', handlePlayResponse)
      // 组件卸载时清理 pending timeout，避免定时器残留
      if (seekPendingTimeoutRef.current)
        clearTimeout(seekPendingTimeoutRef.current)
      if (pausePendingTimeoutRef.current)
        clearTimeout(pausePendingTimeoutRef.current)
      if (playPendingTimeoutRef.current)
        clearTimeout(playPendingTimeoutRef.current)
      seekPendingTimeoutRef.current = null
      pausePendingTimeoutRef.current = null
      playPendingTimeoutRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, isHost])

  // 所有用户：监听房间模式切换
  useEffect(() => {
    if (!socket) return

    const handleRoomModeChanged = (data: {
      mode: 'screen-share' | 'watch-together'
    }) => {
      setMode(data.mode)
    }

    socket.on('room-mode-changed', handleRoomModeChanged)
    return () => {
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [socket, setMode])

  // ── 申请审批操作（与重构前一致）─────────────────────────
  const handleApproveJoin = useCallback(() => {
    if (!confirmJoin) return
    const viewerSocketId = confirmJoin.viewerSocketId
    if (!socket || !viewerSocketId) return
    socket.emit(
      'approve-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.success('已允许加入')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
    setConfirmJoin(null)
  }, [confirmJoin, socket])

  const handleRejectJoin = useCallback(() => {
    if (!confirmJoin) return
    const viewerSocketId = confirmJoin.viewerSocketId
    if (!socket || !viewerSocketId) return
    socket.emit(
      'reject-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.info('已拒绝加入')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
    setConfirmJoin(null)
  }, [confirmJoin, socket])

  const handleAcceptSeek = useCallback(() => {
    if (!seekRequest) return
    const { viewerSocketIds, time } = seekRequest
    if (!socket || viewerSocketIds.length === 0) return
    if (videoRef.current && Number.isFinite(time)) {
      videoRef.current.currentTime = time
    }
    for (const sid of viewerSocketIds) {
      socket.emit(
        'seek-response',
        { roomId, viewerSocketId: sid, accept: true, time },
        () => {}
      )
    }
    setSeekRequest(null)
  }, [seekRequest, socket, videoRef, roomId])

  const handleRejectSeek = useCallback(() => {
    if (!seekRequest) return
    const { viewerSocketIds } = seekRequest
    if (!socket || viewerSocketIds.length === 0) return
    for (const sid of viewerSocketIds) {
      socket.emit(
        'seek-response',
        { roomId, viewerSocketId: sid, accept: false },
        () => {}
      )
    }
    setSeekRequest(null)
  }, [seekRequest, socket, roomId])

  const handleAcceptPause = useCallback(() => {
    if (!pauseRequest) return
    const { viewerSocketIds } = pauseRequest
    if (!socket || viewerSocketIds.length === 0) return
    videoRef.current?.pause()
    for (const sid of viewerSocketIds) {
      socket.emit(
        'pause-response',
        { roomId, viewerSocketId: sid, accept: true },
        () => {}
      )
    }
    setPauseRequest(null)
  }, [pauseRequest, socket, videoRef, roomId])

  const handleRejectPause = useCallback(() => {
    if (!pauseRequest) return
    const { viewerSocketIds } = pauseRequest
    if (!socket || viewerSocketIds.length === 0) return
    for (const sid of viewerSocketIds) {
      socket.emit(
        'pause-response',
        { roomId, viewerSocketId: sid, accept: false },
        () => {}
      )
    }
    setPauseRequest(null)
  }, [pauseRequest, socket, roomId])

  const handleAcceptPlay = useCallback(() => {
    if (!playRequest) return
    const { viewerSocketIds } = playRequest
    if (!socket || viewerSocketIds.length === 0) return
    if (videoRef.current) {
      void videoRef.current.play().catch(() => {})
    }
    for (const sid of viewerSocketIds) {
      socket.emit(
        'play-response',
        { roomId, viewerSocketId: sid, accept: true },
        () => {}
      )
    }
    setPlayRequest(null)
  }, [playRequest, socket, videoRef, roomId])

  const handleRejectPlay = useCallback(() => {
    if (!playRequest) return
    const { viewerSocketIds } = playRequest
    if (!socket || viewerSocketIds.length === 0) return
    for (const sid of viewerSocketIds) {
      socket.emit(
        'play-response',
        { roomId, viewerSocketId: sid, accept: false },
        () => {}
      )
    }
    setPlayRequest(null)
  }, [playRequest, socket, roomId])

  // ── 观众申请发起（与重构前一致）─────────────────────────
  const handleRequestSeek = useCallback(
    (time: number) => {
      if (!socket || isHost || seekPending) return
      if (!Number.isFinite(time)) return
      setSeekPending(true)
      // 超时机制：房主 15s 内不回应则清除 pending，允许再次申请
      if (seekPendingTimeoutRef.current)
        clearTimeout(seekPendingTimeoutRef.current)
      seekPendingTimeoutRef.current = setTimeout(() => {
        setSeekPending(false)
        seekPendingTimeoutRef.current = null
        addPlayerNotice('跳转申请已超时，房主未回应', 'info')
      }, 15000)
      socket.emit(
        'seek-request',
        { roomId, time },
        (response: { success: boolean; message?: string }) => {
          if (!response.success) {
            // 服务器拒绝（如房间非直播模式）：清除 pending 和 timeout
            if (seekPendingTimeoutRef.current) {
              clearTimeout(seekPendingTimeoutRef.current)
              seekPendingTimeoutRef.current = null
            }
            setSeekPending(false)
            addPlayerNotice(response.message || '申请跳转失败', 'error')
          } else {
            // 服务器已转发给房主，timeout 保留（由 seek-response 事件或超时回退清除）
            addPlayerNotice(
              autoApproveRef.current
                ? '已跳转'
                : '已发送跳转申请，等待房主确认',
              'info'
            )
          }
        }
      )
    },
    [socket, isHost, roomId, seekPending, addPlayerNotice]
  )

  const handleRequestPause = useCallback(() => {
    if (!socket || isHost || pausePending) return
    setPausePending(true)
    if (pausePendingTimeoutRef.current)
      clearTimeout(pausePendingTimeoutRef.current)
    pausePendingTimeoutRef.current = setTimeout(() => {
      setPausePending(false)
      pausePendingTimeoutRef.current = null
      addPlayerNotice('暂停申请已超时，房主未回应', 'info')
    }, 15000)
    socket.emit(
      'pause-request',
      { roomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          if (pausePendingTimeoutRef.current) {
            clearTimeout(pausePendingTimeoutRef.current)
            pausePendingTimeoutRef.current = null
          }
          setPausePending(false)
          addPlayerNotice(response.message || '申请暂停失败', 'error')
        } else {
          addPlayerNotice(
            autoApproveRef.current ? '已暂停' : '已发送暂停申请，等待房主确认',
            'info'
          )
        }
      }
    )
  }, [socket, isHost, roomId, pausePending, addPlayerNotice])

  const handleRequestPlay = useCallback(() => {
    if (!socket || isHost || playPending) return
    setPlayPending(true)
    if (playPendingTimeoutRef.current)
      clearTimeout(playPendingTimeoutRef.current)
    playPendingTimeoutRef.current = setTimeout(() => {
      setPlayPending(false)
      playPendingTimeoutRef.current = null
      addPlayerNotice('继续播放申请已超时，房主未回应', 'info')
    }, 15000)
    socket.emit(
      'play-request',
      { roomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success) {
          if (playPendingTimeoutRef.current) {
            clearTimeout(playPendingTimeoutRef.current)
            playPendingTimeoutRef.current = null
          }
          setPlayPending(false)
          addPlayerNotice(response.message || '申请继续播放失败', 'error')
        } else {
          addPlayerNotice(
            autoApproveRef.current
              ? '继续播放'
              : '已发送继续播放申请，等待房主确认',
            'info'
          )
        }
      }
    )
  }, [socket, isHost, roomId, playPending, addPlayerNotice])

  // ── 控制栏操作 ─────────────────────────────────────────
  const handleToggleDanmaku = useCallback(() => {
    setDanmakuEnabled((prev) => !prev)
  }, [])

  // 弹幕点击：复制文本到剪贴板
  // 弹幕渲染时可能拼接了 "发送者: 内容" 前缀，复制时去掉前缀只保留内容部分
  const handleDanmakuClick = useCallback((text: string) => {
    // 提取内容：若文本以 "xxx: " 开头（发送者前缀），则取冒号后内容；否则用原文
    const colonIdx = text.indexOf(': ')
    const content =
      colonIdx >= 0 && colonIdx < 30 ? text.slice(colonIdx + 2) : text
    const textToCopy = content.trim() || text.trim()
    if (!textToCopy) return

    const fallbackCopy = () => {
      const textarea = document.createElement('textarea')
      textarea.value = textToCopy
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      try {
        document.execCommand('copy')
        message.success('已复制弹幕内容')
      } catch {
        message.error('复制失败')
      }
      document.body.removeChild(textarea)
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(textToCopy)
        .then(() => message.success('已复制弹幕内容'))
        .catch(() => fallbackCopy())
    } else {
      fallbackCopy()
    }
  }, [])

  const handleSendDanmaku = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return

      const item: DanmakuItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        content: trimmed,
        time: videoRef.current?.currentTime ?? 0,
        mode: 1,
        color: 16777215,
        size: 25,
      }

      // 本地立即上屏（发送者自己看到）
      danmakuLayerRef.current?.sendDanmaku(trimmed, { sender: '我' })
      addRealtime({ ...item, self: true, sender: '我' })

      if (!socket) return
      // 发送评论（持久化 + 广播 new-comment）
      socket.emit(
        'send-comment',
        { roomId, content: trimmed, isDanmaku: true },
        (response: { success: boolean; message?: string }) => {
          if (!response.success) {
            message.error(response.message ?? '弹幕发送失败')
          }
        }
      )
      // 广播弹幕事件（其他客户端通过 'danmaku' 事件上屏）
      socket.emit('send-danmaku', {
        roomId,
        content: trimmed,
        videoTime: videoRef.current?.currentTime ?? 0,
      })
    },
    [socket, roomId, videoRef, addRealtime]
  )

  const handleSync = useCallback(() => {
    if (!isHost) return
    forceSync()
  }, [isHost, forceSync])

  const handleReload = useCallback(() => {
    if (isHost && watchTogether.sourceType === 'bilibili') {
      void reloadBilibili()
      return
    }
    if (!videoRef.current) return
    void reloadVideo(videoRef.current)
  }, [isHost, watchTogether.sourceType, reloadBilibili, reloadVideo, videoRef])

  // ── 面板外点击 / ESC 关闭 ──────────────────────────────
  const settingsAnchorRef = useRef<HTMLDivElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!settingsOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node
      // portal 到 body 的浮动菜单（如 FontPicker 下拉）虽在 anchor 外，
      // 但点击它们不应关闭设置面板（否则菜单瞬间卸载无法选中）
      if (
        target instanceof Element &&
        target.closest?.('[data-portal-menu]')
      ) {
        return
      }
      if (
        settingsOpen &&
        settingsAnchorRef.current &&
        !settingsAnchorRef.current.contains(target) &&
        settingsButtonRef.current &&
        !settingsButtonRef.current.contains(target)
      ) {
        setSettingsOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSettingsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [settingsOpen, slots])

  // ── 补充快捷键（F 全屏 / M 静音 / 方向键 跳转+音量）──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      if (e.key === 'f' || e.key === 'F') {
        handleToggleFullscreen()
        return
      }
      if (e.key === 'm' || e.key === 'M') {
        video.muted = !video.muted
        return
      }
      // 方向键：左右 5s 跳转，上下 5% 音量
      const canControl = isHost || hostOffline
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        const cur = video.currentTime
        if (!Number.isFinite(cur)) return
        const target = Math.max(0, cur - 5)
        if (canControl) {
          video.currentTime = target
        } else {
          handleRequestSeek(target)
        }
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        const cur = video.currentTime
        if (!Number.isFinite(cur)) return
        const dur = video.duration
        const target = dur > 0 ? Math.min(dur, cur + 5) : cur + 5
        if (canControl) {
          video.currentTime = target
        } else {
          handleRequestSeek(target)
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const next = Math.min(1, (video.muted ? 0 : video.volume) + 0.05)
        video.muted = false
        video.volume = next
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.max(0, (video.muted ? 0 : video.volume) - 0.05)
        video.volume = next
      }
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
    }
  }, [
    isHost,
    hostOffline,
    art,
    video,
    handleToggleFullscreen,
    handleRequestSeek,
  ])

  // ── 观众申请按钮（渲染用）──────────────────────────────
  const isPlaying = useVideoPlayingState(video)

  // ── 房主端申请审批通知列表（与重构前一致）─────────────────
  // React Compiler 误报：以下 push 操作构建的是纯渲染数据（通知列表），
  // 回调在后续事件处理中执行，不存在 render 期间读取 ref 的问题。
  /* eslint-disable react-hooks/refs */
  const requestNotifications: RequestNotificationItem[] = useMemo(() => {
    const list: RequestNotificationItem[] = []
    if (confirmJoin) {
      list.push({
        id: 'join',
        title: '观看请求',
        okText: '允许',
        cancelText: '拒绝',
        onOk: handleApproveJoin,
        onCancel: handleRejectJoin,
        autoCloseMs: 12000,
        content: (
          <>
            有观看者请求加入房间（
            <span style={{ color: 'var(--md-sys-color-primary)' }}>
              {confirmJoin.viewerSocketId.slice(0, 8)}
            </span>
            ），是否允许？
          </>
        ),
      })
    }
    if (seekRequest) {
      list.push({
        id: 'seek',
        title: '跳转申请',
        okText: '同意',
        cancelText: '拒绝',
        onOk: handleAcceptSeek,
        onCancel: handleRejectSeek,
        autoCloseMs: 12000,
        content: (
          <>
            观众{' '}
            <span style={{ color: 'var(--md-sys-color-primary)' }}>
              {seekRequest.viewerUsernames[0] ||
                seekRequest.viewerSocketIds[0].slice(0, 8)}
              {seekRequest.viewerSocketIds.length > 1
                ? ` 等 ${seekRequest.viewerSocketIds.length} 位观众`
                : ''}
            </span>{' '}
            申请跳转到{' '}
            <span style={{ color: 'var(--md-sys-color-primary)' }}>
              {formatDuration(seekRequest.time)}
            </span>
          </>
        ),
      })
    }
    if (pauseRequest) {
      list.push({
        id: 'pause',
        title: '暂停申请',
        okText: '同意',
        cancelText: '拒绝',
        onOk: handleAcceptPause,
        onCancel: handleRejectPause,
        autoCloseMs: 12000,
        content: (
          <>
            观众{' '}
            <span style={{ color: 'var(--md-sys-color-primary)' }}>
              {pauseRequest.viewerUsernames[0] ||
                pauseRequest.viewerSocketIds[0].slice(0, 8)}
              {pauseRequest.viewerSocketIds.length > 1
                ? ` 等 ${pauseRequest.viewerSocketIds.length} 位观众`
                : ''}
            </span>{' '}
            申请暂停播放
          </>
        ),
      })
    }
    if (playRequest) {
      list.push({
        id: 'play',
        title: '播放申请',
        okText: '同意',
        cancelText: '拒绝',
        onOk: handleAcceptPlay,
        onCancel: handleRejectPlay,
        autoCloseMs: 12000,
        content: (
          <>
            观众{' '}
            <span style={{ color: 'var(--md-sys-color-primary)' }}>
              {playRequest.viewerUsernames[0] ||
                playRequest.viewerSocketIds[0].slice(0, 8)}
              {playRequest.viewerSocketIds.length > 1
                ? ` 等 ${playRequest.viewerSocketIds.length} 位观众`
                : ''}
            </span>{' '}
            申请继续播放
          </>
        ),
      })
    }
    return list
  }, [
    confirmJoin,
    seekRequest,
    pauseRequest,
    playRequest,
    handleApproveJoin,
    handleRejectJoin,
    handleAcceptSeek,
    handleRejectSeek,
    handleAcceptPause,
    handleRejectPause,
    handleAcceptPlay,
    handleRejectPlay,
  ])
  /* eslint-enable react-hooks/refs */

  const handleCloseNotification = useCallback((id: string) => {
    if (id === 'join') setConfirmJoin(null)
    else if (id === 'seek') setSeekRequest(null)
    else if (id === 'pause') setPauseRequest(null)
    else if (id === 'play') setPlayRequest(null)
  }, [])

  return (
    <>
      {/* 字幕样式：使用 Monet 主题变量，字号可调、透明底色 */}
      <style>{`
        .zart-stage video::cue {
          font-size: ${subtitles.subtitleFontSize}px;
          background-color: transparent;
          color: #ffffff;
          text-shadow: 0 0 4px rgba(0, 0, 0, 0.9), 0 1px 3px rgba(0, 0, 0, 0.9);
          ${subtitles.subtitleFontFamily ? `font-family: ${subtitles.subtitleFontFamily};` : ''}
        }
      `}</style>

      {/* 弹幕图层（Portal → ArtPlayer layer） */}
      {watchTogether.sourceUrl &&
        createPortal(
          <DanmakuLayer
            ref={danmakuLayerRef}
            videoElement={video}
            enabled={danmakuEnabled}
            opacity={style.opacity}
            displayArea={style.displayArea}
            density={style.advanced.density}
            speed={style.speed}
            scaleWithScreen={style.scaleWithScreen}
            filters={style.filters}
            advancedStyle={style.advanced}
            fontSize={style.fontSize}
            blockKeywords={blockKeywords}
            onDanmakuClick={handleDanmakuClick}
          />,
          slots.danmakuRoot
        )}

      {/* 字幕渲染层（Portal → ArtPlayer overlay layer）
          使用自定义 SubtitleOverlay 组件替代浏览器原生 <track> + ::cue，
          根据 ParsedCue[] 的位置/对齐信息用 HTML/CSS 直接渲染，
          完整保留 SRT/ASS/VTT/SMI/SUB 各格式的样式。 */}
      {watchTogether.sourceUrl &&
        createPortal(
          <SubtitleOverlay
            video={video}
            cues={activeSubtitleCues}
            enabled={subtitles.subtitleEnabled}
            fontSize={subtitles.subtitleFontSize}
            offset={subtitles.subtitleOffset}
            shiftX={subtitles.subtitleShiftX}
            shiftY={subtitles.subtitleShiftY}
            strokeWidth={subtitles.subtitleStrokeWidth}
            shadowBlur={subtitles.subtitleShadowBlur}
            fontFamily={subtitles.subtitleFontFamily}
          />,
          slots.overlayRoot
        )}

      {/* 影片加载失败重试层（房主端 loadMovie 失败时显示）：
          之前失败只有 toast，用户没有重试入口，只能切别的影片再切回 */}
      {loadMovieError &&
        isHost &&
        createPortal(
          <div className="absolute inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/70">
            <div className="text-center">
              <div className="mb-1 text-base font-medium text-white">
                视频加载失败
              </div>
              <div className="max-w-md px-6 text-xs text-white/60">
                {loadMovieError}
              </div>
            </div>
            <Button variant="primary" onClick={retryLoadMovie}>
              重试
            </Button>
          </div>,
          slots.overlayRoot
        )}

      {/* 播放器内通知（左上角），使用 overlayRoot 让通知始终可见 */}
      {createPortal(
        <div className="pointer-events-none absolute left-4 top-4 z-50 flex flex-col gap-2">
          {playerNotices.map((notice) => (
            <div
              key={notice.id}
              className={cn(
                'pointer-events-auto animate-in slide-in-from-left-2 fade-in font-medium transition-all duration-300',
                'text-white/50'
              )}
              style={{
                fontSize: 'clamp(9px, 1.1vw, 12px)',
                textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
              }}
            >
              {notice.text}
            </div>
          ))}
        </div>,
        slots.overlayRoot
      )}

      {/* 覆盖层：解析中 / 重载中加载动画。
          挂载到 panelRoot（z-index: 70，直接 append 到 $player），
          避免使用 ArtPlayer layer 系统导致 loading 状态下 layer 被隐藏 */}
      {(isResolving || isReloading) &&
        createPortal(
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner size={36} />
          </div>,
          slots.panelRoot
        )}

      {/* 缓冲模式：下载进度覆盖层。
          显示已下载/总字节数 + 进度条，告知用户正在缓存 B站 m4s 流到本地。
          房主与观众共用同一 UI（数据来自 roomStore.bufferProgress）。 */}
      {bufferProgress &&
        createPortal(
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/60 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2">
              <Spinner size={28} />
              <Text className="text-sm font-medium text-white">
                正在缓冲视频
              </Text>
              <Text className="text-xs text-white/60">
                {bufferProgress.title}
              </Text>
            </div>
            <div className="w-64 max-w-[80%]">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-300"
                  style={{
                    width: `${
                      bufferProgress.total > 0
                        ? Math.min(
                            100,
                            (bufferProgress.downloaded / bufferProgress.total) *
                              100
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <div className="mt-2 flex justify-between text-[10px] text-white/50">
                <span>
                  {(bufferProgress.downloaded / 1024 / 1024).toFixed(1)} MB
                </span>
                <span>
                  {bufferProgress.total > 0
                    ? `${(bufferProgress.total / 1024 / 1024).toFixed(1)} MB`
                    : '未知大小'}
                </span>
              </div>
            </div>
          </div>,
          slots.panelRoot
        )}

      {/* 空源占位（覆盖整个播放器区域，与重构前行为一致：隐藏控制栏） */}
      {!watchTogether.sourceUrl &&
        createPortal(
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black">
            <img
              src="/player-empty.jpg"
              alt="等待播放"
              className="h-32 w-32 rounded-[var(--md-sys-shape-corner)] object-cover"
            />
            <Text className="text-sm text-white">
              {isHost ? '请在下方添加并播放影片' : '等待房主播放影片'}
            </Text>
          </div>,
          slots.panelRoot
        )}

      {/* 设置面板锚点（右下角，控制栏上方）
          bottom = 控制栏总高（外层 p-3 + 内层 p-2 + 进度条 + 按钮行 ≈ 88px），
          使面板底边与控制栏顶边对齐，不再被控制栏遮挡 */}
      {createPortal(
        <div
          ref={settingsAnchorRef}
          className="absolute"
          style={{ right: 8, bottom: 92 }}
        >
          {settingsOpen && (
            <SettingsPanel
              isHost={isHost}
              danmakuStyle={style}
              subtitleEnabled={subtitles.subtitleEnabled}
              subtitleTracks={subtitles.subtitleTracks}
              activeTrackIndex={subtitles.activeTrackIndex}
              subtitleFontSize={subtitles.subtitleFontSize}
              subtitleOffset={subtitles.subtitleOffset}
              subtitleShiftX={subtitles.subtitleShiftX}
              subtitleShiftY={subtitles.subtitleShiftY}
              subtitleStrokeWidth={subtitles.subtitleStrokeWidth}
              subtitleShadowBlur={subtitles.subtitleShadowBlur}
              subtitleFontFamily={subtitles.subtitleFontFamily}
              browseMovieId={
                isHost &&
                currentMovieId != null &&
                supportedSubtitleSources.includes(currentMovieSourceType)
                  ? currentMovieId
                  : undefined
              }
              onToggleSubtitles={subtitles.setEnabled}
              onSelectSubtitleTrack={subtitles.setActiveTrack}
              onAddSubtitleUrl={subtitles.addTrackFromUrl}
              onAddSubtitleFile={subtitles.addTrackFromFile}
              onAddSubtitleContent={subtitles.addTrackFromContent}
              onChangeSubtitleFontSize={subtitles.setFontSize}
              onChangeSubtitleOffset={subtitles.setOffset}
              onChangeSubtitleShiftX={subtitles.setShiftX}
              onChangeSubtitleShiftY={subtitles.setShiftY}
              onChangeSubtitleStrokeWidth={subtitles.setStrokeWidth}
              onChangeSubtitleShadowBlur={subtitles.setShadowBlur}
              onChangeSubtitleFontFamily={subtitles.setFontFamily}
              onAutoSearchSubtitles={
                currentMovieId != null && isHost
                  ? () => subtitles.searchAutoSubtitles(currentMovieId)
                  : undefined
              }
              canAutoSearchSubtitles={
                isHost &&
                currentMovieId != null &&
                supportedSubtitleSources.includes(currentMovieSourceType)
              }
              onListEmbeddedTracks={
                canEnableEmbedded && embeddedSource
                  ? () => subtitles.listEmbeddedTracks(embeddedSource)
                  : undefined
              }
              onExtractEmbeddedTrack={
                canEnableEmbedded && embeddedSource
                  ? (track) =>
                      subtitles.extractEmbeddedTrack(embeddedSource, track)
                  : undefined
              }
              canLoadEmbeddedSubtitles={canEnableEmbedded}
              onDanmakuStyleChange={setStyle}
              onDanmakuFilterChange={setFilters}
              onDanmakuAdvancedChange={setAdvancedStyle}
              onResetDanmakuStyle={resetStyle}
            />
          )}
        </div>,
        slots.panelRoot
      )}

      {/* 自定义底部玻璃拟态控制栏 */}
      {watchTogether.sourceUrl && (
        <PlayerControlBar
          isHost={isHost}
          hostOffline={hostOffline}
          videoRef={videoRef}
          watchTogether={watchTogether}
          isPlaying={isPlaying}
          isFullscreen={isFullscreen}
          onToggleFullscreen={handleToggleFullscreen}
          isWebFullscreen={isWebFullscreen}
          onToggleWebFullscreen={onToggleWebFullscreen}
          danmakuEnabled={danmakuEnabled}
          onToggleDanmaku={handleToggleDanmaku}
          onSendDanmaku={handleSendDanmaku}
          onSync={handleSync}
          onReload={handleReload}
          settingsOpen={settingsOpen}
          onToggleSettings={() => setSettingsOpen((v) => !v)}
          settingsButtonRef={settingsButtonRef}
          onRequestSeek={handleRequestSeek}
          onRequestPause={handleRequestPause}
          onRequestPlay={handleRequestPlay}
          pausePending={pausePending}
          playPending={playPending}
          controlBarVisible={controlBarVisible}
          controlBarHideMode={controlBarHideMode}
          onToggleHideMode={handleToggleHideMode}
        />
      )}

      {/* 视频统计信息（右键菜单，绑定 art.video） */}
      {/* 观众端启用本地 CLI 代理时，统计信息应反映本地代理覆盖后的真实源。 */}
      {(() => {
        const isCliOverrideActive =
          !isHost &&
          watchTogether.sourceType === 'bilibili' &&
          viewerCliResolvedSource?.movieId === currentMovieId
        const override = isCliOverrideActive
          ? viewerCliResolvedSource.resolved
          : null
        const statsFormat =
          override?.format === 'dash' || override?.format === 'mp4'
            ? override.format
            : watchTogether.format === 'dash' || watchTogether.format === 'mp4'
              ? watchTogether.format
              : undefined
        return (
          <VideoStatsMenu
            videoElement={video}
            sourceType={
              watchTogether.sourceType === 'bilibili' ? 'bilibili' : 'custom'
            }
            videoCodec={override?.videoCodec ?? watchTogether.videoCodec}
            sourceUrl={override?.videoUrl ?? watchTogether.sourceUrl}
            currentQuality={override?.currentQn ?? currentQuality}
            availableQualities={override?.acceptQuality ?? availableQualities}
            format={statsFormat}
            directLink={currentMovieDirectLink}
          />
        )
      })()}

      <RequestNotification
        items={requestNotifications}
        onClose={handleCloseNotification}
      />
    </>
  )
}
