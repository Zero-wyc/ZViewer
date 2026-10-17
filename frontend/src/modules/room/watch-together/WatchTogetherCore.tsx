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
import type { ReactNode } from 'react'
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
import { useWakeLock } from '@/hooks/useWakeLock'
import { useRoomStore } from '@/store/roomStore'
import { usePlayerPrefsStore } from '@/store/playerPrefsStore'
import { useCliAgentStore } from '@/store/cliAgentStore'
import { getBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import { DanmakuLayer } from '@/modules/danmaku/components/DanmakuLayer'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import { useWatchTogether } from './useWatchTogether'
import { useRequestChannel, type PendingApproval } from './useRequestChannel'
import { useDanmakuBridge } from './useDanmakuBridge'
import { useControlBarVisibility } from './useControlBarVisibility'
import { ATTACH_STAGE_LABELS } from '@/modules/sync-playback/hooks/useVideoSource'
import { FullscreenCommentDock } from './FullscreenCommentDock'
import {
  RequestNotification,
  type RequestNotificationItem,
} from '@/components/ui/RequestNotification'
import type { MediaFormat } from '@/lib/mediaFormat'
import { useVideoPlayingState } from '@/modules/art-player/useVideoPlayingState'
import { SettingsPanel } from '@/components/VideoPlayer/SettingsPanel'
import { SubtitleOverlay } from '@/components/VideoPlayer/SubtitleOverlay'
import { isCliProxyUrl } from '@/modules/player/services/url-proxy'
import { normalizeAudioCodec, needsBrowserTranscode } from '@/lib/audioCodecs'
import { isPlaysVideoSupported } from '@/modules/player'
import type { ArtSlots } from './types'
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
  // CLI 在服务器全局注册（不绑定房间），配置页只需填服务器地址。
  useCliAgent()
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
  // 当前影片的「浏览器转码引擎」开关（缺省视为开启，与 shouldUsePlaysVideo
  // 的 `!== false` 宽松语义一致），用于音频编码提示的分支判断
  const currentMoviePlaysvideoEnabled = useRoomStore((state) => {
    const m = state.movies.find((mv) => mv.id === state.currentMovieId)
    return m ? m.playsvideoEnabled !== false : true
  })
  const {
    watchTogether,
    setWatchTogether,
    forceSync,
    isResolving,
    attachProgress,
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
    return () => {
      clearTimeout(embeddedTimer)
      // 影片切换/源变化时取消进行中的内嵌提取流：提取是独立于播放引擎的
      // Range 拉流（中转源大文件可持续数分钟），若只在「下一次加载前取消」，
      // 切到非挂载源影片（无新加载调用）或观众端早退路径（已有广播字幕）
      // 时旧流无人取消，服务器中转流量会持续到提取自然完成。新影片为
      // 挂载源时 3 秒后会重新发起提取，不受影响。
      subtitles.cancelEmbeddedExtraction()
    }
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

  // ── 房主离线状态 ──────────────────────────────────────
  // 房主离开后观众进入自主控制模式，可直接 play/pause/seek，无需向房主申请。
  // 房主重连后恢复申请模式。
  // 状态放 roomStore 单一数据源：除本处事件监听外，useServerHeartbeat
  // （服务器心跳 hostOnline 持续校正）与 usePlaybackStateRequest（加入时
  // ack hostOnline 兜底）也会写入——覆盖观众在房主离线后才加入/刷新/
  // socket 重连而错过 host-disconnected 事件的场景（无法暂停 bug）。
  const hostOffline = useRoomStore((state) => state.hostOffline)
  const setHostOffline = useRoomStore((state) => state.setHostOffline)

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
  }, [socket, isHost, setHostOffline])

  // ── 弹幕桥接（官方弹幕加载/轨道同步/实时收发，见 useDanmakuBridge）──
  const {
    danmakuLayerRef,
    danmakuEnabled,
    blockKeywords,
    style,
    setStyle,
    setFilters,
    setAdvancedStyle,
    resetStyle,
    handleToggleDanmaku,
    handleDanmakuClick,
    handleSendDanmaku,
  } = useDanmakuBridge({
    socket,
    roomId,
    videoRef,
    cid: watchTogether.cid,
    sourceType: watchTogether.sourceType,
  })

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

  // ── 音频编码兼容性提示 ──────────────────────────────
  // 浏览器 <video> 仅支持 AAC/MP3/Opus/Vorbis/FLAC 等少数音频编码
  // （白名单口径统一引用 lib/audioCodecs，与引擎选择 needsBrowserTranscode
  // 同源）。DTS/AC3/EAC3 等编码的处理方式：
  // - emby/jellyfin 源：resolve 阶段自动切换为远端媒体服务器转码 HLS
  // - 浏览器端转码引擎（playsvideo）：在浏览器内重封装容器并将不兼容
  //   音轨实时转码为 AAC（中转与直链均支持，无需服务端 FFmpeg）
  // - 引擎不会接管（影片级开关关闭 / 浏览器不支持运行）：直推原始流，
  //   视频将无声——提示用户到影片解析设置开启开关。
  // 只有真正不被浏览器支持的编码才提示：此前对任何非空编码都弹提示，
  // AAC 等原生可播的轨道会被误报「不受浏览器支持」。
  // 编码名经 normalizeAudioCodec 归一化（B站 DASH 的 mp4a.40.x 实为 AAC，
  // 不归一化会误弹「不受浏览器支持」提示）。
  const lastAudioNoticeRef = useRef('')
  useEffect(() => {
    if (!watchTogether.sourceUrl) return
    const codec = normalizeAudioCodec(watchTogether.audioCodec)
    if (!codec) return
    // 白名单内的编码浏览器原生可播，无需任何提示
    if (!needsBrowserTranscode(codec)) return

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
    } else if (currentMoviePlaysvideoEnabled && isPlaysVideoSupported()) {
      // playsvideo 将接管本源（影片级开关未关 + 浏览器具备 MSE/Worker
      // 运行条件）：引擎起播时探测编码并自动转码为 AAC，无需干预。
      addPlayerNotice(
        `音轨编码 ${codec.toUpperCase()} 不受浏览器支持，浏览器转码引擎正在实时转码为 AAC`,
        'info'
      )
    } else {
      // 引擎不会接管：直推原始流必然无声，给出可操作的修复指引
      addPlayerNotice(
        `音轨编码 ${codec.toUpperCase()} 不受浏览器支持且浏览器转码引擎未启用，播放将无声；可在影片解析设置中开启「浏览器转码引擎」后重试`,
        'error'
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    watchTogether.sourceUrl,
    watchTogether.audioCodec,
    currentMovieId,
    currentMovieSourceType,
    currentMoviePlaysvideoEnabled,
  ])

  // ── 观众申请通道（seek / pause / play）─────────────────
  // 三类申请协议同构（emit {kind}-request → 房主审批 → {kind}-response），
  // 差异仅「同意后本地生效动作」「请求附加字段」「合并键」，统一由 hook 承载。
  const seekChannel = useRequestChannel({
    kind: 'seek',
    socket,
    roomId,
    isHost,
    videoRef,
    autoApproveRef,
    addPlayerNotice,
    // 房主同意后本地跳转；观众端由房主广播的 seek 驱动，不重复设置 currentTime
    applyOnHostGrant: (video, detail) => {
      if (typeof detail.time === 'number' && Number.isFinite(detail.time)) {
        video.currentTime = detail.time
      }
    },
    // 只有目标时间相同的申请才在 5s 窗口内合并，避免不同跳转点混为一条
    mergeKeyOf: (detail) => String(detail.time),
  })
  const pauseChannel = useRequestChannel({
    kind: 'pause',
    socket,
    roomId,
    isHost,
    videoRef,
    autoApproveRef,
    addPlayerNotice,
    applyOnHostGrant: (video) => video.pause(),
    // 观众收到同意后主动暂停：房主端 video 可能已暂停（重复申请），
    // 此时不会广播 pause，观众端 isPlaying 不更新会让按钮一直显示「申请暂停」。
    applyOnViewerConfirm: (video) => {
      if (!video.paused) video.pause()
    },
  })
  const playChannel = useRequestChannel({
    kind: 'play',
    socket,
    roomId,
    isHost,
    videoRef,
    autoApproveRef,
    addPlayerNotice,
    applyOnHostGrant: (video) => {
      void video.play().catch(() => {
        /* 浏览器自动播放策略可能拒绝，忽略 */
      })
    },
    // 同上：房主端 play() 被自动播放策略拒绝时不广播 play，观众需自行起播
    applyOnViewerConfirm: (video) => {
      if (video.paused) {
        void video.play().catch(() => {
          /* 浏览器自动播放策略可能拒绝，忽略 */
        })
      }
    },
  })

  // ── 移动端检测：粗指针（触屏）或支持多点触控即视为移动端 ──
  const isMobile = useMemo(
    () =>
      typeof window !== 'undefined' &&
      (navigator.maxTouchPoints > 0 ||
        window.matchMedia('(pointer: coarse)').matches),
    []
  )

  // ── 控制栏显隐状态机（pointer/touch 事件与冷却逻辑，见
  // useControlBarVisibility）──
  const { controlBarVisible, controlBarHideMode, handleToggleHideMode } =
    useControlBarVisibility({
      stageRef,
      isMobile,
    })

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

  // ── 观众申请审批 / 发起（统一走 useRequestChannel）─────────
  // 房主端：request 为待审批申请（5s 合并），approve/reject 逐一回应申请者；
  // 观众端：pending 为等待房主回应的状态，sendRequest 发起申请。
  const {
    request: seekRequest,
    approve: handleAcceptSeek,
    reject: handleRejectSeek,
    clear: clearSeekRequest,
    sendRequest: sendSeekRequest,
  } = seekChannel
  const {
    request: pauseRequest,
    approve: handleAcceptPause,
    reject: handleRejectPause,
    clear: clearPauseRequest,
    pending: pausePending,
    sendRequest: handleRequestPause,
  } = pauseChannel
  const {
    request: playRequest,
    approve: handleAcceptPlay,
    reject: handleRejectPlay,
    clear: clearPlayRequest,
    pending: playPending,
    sendRequest: handleRequestPlay,
  } = playChannel

  // 跳转申请需携带目标时间，非法时间直接丢弃（不发申请）
  const handleRequestSeek = useCallback(
    (time: number) => {
      if (!Number.isFinite(time)) return
      sendSeekRequest({ time })
    },
    [sendSeekRequest]
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
      if (target instanceof Element && target.closest?.('[data-portal-menu]')) {
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

  // ── 双击控制键开关全屏评论区侧边栏 ────────────────────
  // 设置项在「高级设置 → 双击打开评论区」(playerPrefsStore 持久化);
  // 仅全屏下生效(侧边栏只在全屏挂载),避免非全屏双击 Alt 触发浏览器菜单栏。
  const commentDockHotkey = usePlayerPrefsStore((s) => s.commentDockHotkey)
  const setCommentDockHotkey = usePlayerPrefsStore(
    (s) => s.setCommentDockHotkey
  )
  const commentDockEdgeHover = usePlayerPrefsStore(
    (s) => s.commentDockEdgeHover
  )
  const setCommentDockEdgeHover = usePlayerPrefsStore(
    (s) => s.setCommentDockEdgeHover
  )
  const [commentDockPinned, setCommentDockPinned] = useState(false)

  // 退全屏时解除钉住,避免下次进全屏时侧边栏莫名常开。
  // 全屏状态由 Fullscreen API / 网页全屏外部驱动,无法在渲染期推导,
  // 此处的同步属于「响应外部系统状态变化」的合法用法。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 全屏退出事件驱动
    if (!isFullscreen) setCommentDockPinned(false)
  }, [isFullscreen])

  // 双击检测:400ms 内两次按下同一控制键且期间未按其他键(e.repeat 忽略长按)。
  // 单击不 preventDefault,组合键(Ctrl+C / Alt+Tab 等)不受影响。
  useEffect(() => {
    if (!isFullscreen || commentDockHotkey === 'off') return
    const DOUBLE_PRESS_MS = 400
    let lastPressAt = 0
    let lastKey = ''
    const isTargetKey = (key: string): boolean =>
      (commentDockHotkey === 'ctrl' && key === 'Control') ||
      (commentDockHotkey === 'alt' && key === 'Alt') ||
      (commentDockHotkey === 'shift' && key === 'Shift')

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return
      if (isTargetKey(e.key)) {
        const now = Date.now()
        if (lastKey === e.key && now - lastPressAt <= DOUBLE_PRESS_MS) {
          e.preventDefault()
          lastPressAt = 0
          lastKey = ''
          setCommentDockPinned((v) => !v)
          return
        }
        lastPressAt = now
        lastKey = e.key
        return
      }
      // 按了其他键,打断连击窗口
      lastPressAt = 0
      lastKey = ''
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFullscreen, commentDockHotkey])

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

  // 防息屏：移动/平板设备正在播放时保持屏幕常亮
  // （移植自 mirotalk wakeLock；暂停/桌面设备/页面不可见时内部自动失效）
  useWakeLock(isPlaying)

  // ── 房主端申请审批通知列表（与重构前一致）─────────────────
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
    // 三类播放申请共用同一审批卡片骨架，仅标题与动作文案不同
    const pushViewerRequest = (
      req: PendingApproval | null,
      opts: {
        id: string
        title: string
        onOk: () => void
        onCancel: () => void
        action: (req: PendingApproval) => ReactNode
      }
    ) => {
      if (!req) return
      list.push({
        id: opts.id,
        title: opts.title,
        okText: '同意',
        cancelText: '拒绝',
        onOk: opts.onOk,
        onCancel: opts.onCancel,
        autoCloseMs: 12000,
        content: (
          <>
            观众{' '}
            <span style={{ color: 'var(--md-sys-color-primary)' }}>
              {req.viewerUsernames[0] || req.viewerSocketIds[0].slice(0, 8)}
              {req.viewerSocketIds.length > 1
                ? ` 等 ${req.viewerSocketIds.length} 位观众`
                : ''}
            </span>{' '}
            {opts.action(req)}
          </>
        ),
      })
    }

    pushViewerRequest(seekRequest, {
      id: 'seek',
      title: '跳转申请',
      onOk: handleAcceptSeek,
      onCancel: handleRejectSeek,
      action: (req) => (
        <>
          申请跳转到{' '}
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {formatDuration(req.detail.time ?? 0)}
          </span>
        </>
      ),
    })
    pushViewerRequest(pauseRequest, {
      id: 'pause',
      title: '暂停申请',
      onOk: handleAcceptPause,
      onCancel: handleRejectPause,
      action: () => '申请暂停播放',
    })
    pushViewerRequest(playRequest, {
      id: 'play',
      title: '播放申请',
      onOk: handleAcceptPlay,
      onCancel: handleRejectPlay,
      action: () => '申请继续播放',
    })
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

  const handleCloseNotification = useCallback(
    (id: string) => {
      if (id === 'join') setConfirmJoin(null)
      else if (id === 'seek') clearSeekRequest()
      else if (id === 'pause') clearPauseRequest()
      else if (id === 'play') clearPlayRequest()
    },
    [clearSeekRequest, clearPauseRequest, clearPlayRequest]
  )

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
            {/* attach 进度文案（playsvideo 引擎阶段）；无进度时仅 spinner */}
            {attachProgress ? (
              <div className="flex flex-col items-center gap-3">
                <Spinner size={36} />
                <div className="text-xs text-white/70">
                  {ATTACH_STAGE_LABELS[attachProgress.stage] ??
                    attachProgress.stage}
                  {attachProgress.detail ? ` ${attachProgress.detail}` : ''}
                </div>
              </div>
            ) : (
              <Spinner size={36} />
            )}
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
              commentDockHotkey={commentDockHotkey}
              onCommentDockHotkeyChange={setCommentDockHotkey}
              commentDockEdgeHover={commentDockEdgeHover}
              onCommentDockEdgeHoverChange={setCommentDockEdgeHover}
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

      {/* 全屏评论区侧边栏:鼠标移到屏幕右缘滑出(仅全屏状态挂载,
          原生全屏与网页全屏均覆盖;渲染为 stage 直接子节点保证 top layer 可见) */}
      {(isFullscreen || Boolean(isWebFullscreen)) && (
        <FullscreenCommentDock
          socket={socket}
          roomId={roomId}
          stageRef={stageRef}
          pinned={commentDockPinned}
          edgeHover={commentDockEdgeHover}
        />
      )}

      <RequestNotification
        items={requestNotifications}
        onClose={handleCloseNotification}
      />
    </>
  )
}
