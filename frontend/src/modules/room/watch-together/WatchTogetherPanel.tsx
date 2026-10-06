/**
 * WatchTogetherPanel —— 一起看主播放器（ArtPlayer 版，Shell/Core 结构）。
 *
 * Shell（本组件）职责：
 * - 创建 / 销毁 ArtPlayer 实例（引擎层 attach 由 Core 的 useWatchTogether 驱动 art.video）
 * - 构建图层 / 面板插槽（弹幕层、覆盖层、设置面板锚点）
 * - 观众端只读守卫：阻断视频区域单击 / 双击，双击接管为原生全屏
 * - 网页全屏状态管理（受控 / 非受控）与 ESC 退出
 *
 * Core（WatchTogetherCore.tsx）职责：
 * - 全部业务逻辑：useWatchTogether 同步编排、弹幕、字幕、观众申请审批
 * - 通过 Portal 将按钮 / 输入框 / 面板挂载到 ArtPlayer 控制栏与图层
 *
 * 对外 props 契约与重构前完全一致（RoomPage / WatchPage 无需改动）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Artplayer from 'artplayer'
import type { MediaFormat } from '@/lib/mediaFormat'
import {
  configureArtStatics,
  createSlot,
  installViewerGuards,
} from '@/modules/art-player'
import { cn } from '@/lib/utils'
import {
  isIOSDevice,
  supportsContainerFullscreen,
  getFullscreenElement,
  exitFullscreen,
  requestFullscreen,
} from '@/lib/fullscreen-utils'
import { WatchTogetherCore } from './WatchTogetherCore'
import { ViewerCliRequiredOverlay } from './ViewerCliRequiredOverlay'
import '@/modules/art-player/art-overrides.css'

interface WatchTogetherPanelProps {
  roomId: string
  isHost: boolean
  /**
   * 受控的网页全屏状态。提供时组件将使用外部状态替代内部 state。
   */
  isWebFullscreen?: boolean
  /**
   * 受控的网页全屏切换回调。提供时组件将调用外部回调替代内部 state 切换。
   */
  onToggleWebFullscreen?: () => void
  /**
   * 房主刷新/重连恢复时由后端返回的最近一次播放状态。
   * 提供时，视频源加载完成后会将 currentTime 设置为此值并强制暂停。
   */
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

/** ArtPlayer 插槽集合：Core 通过 createPortal 向其中渲染组件 */
export interface ArtSlots {
  /** 弹幕图层根（art layer） */
  danmakuRoot: HTMLDivElement
  /** 覆盖层根（加载动画，art layer） */
  overlayRoot: HTMLDivElement
  /** 浮动面板根（设置 / 空源占位，append 到 $player） */
  panelRoot: HTMLDivElement
}

export function WatchTogetherPanel({
  roomId,
  isHost,
  isWebFullscreen: controlledWebFullscreen,
  onToggleWebFullscreen: controlledToggleWebFullscreen,
  initialPlayback,
}: WatchTogetherPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [ready, setReady] = useState<{
    art: Artplayer
    video: HTMLVideoElement
    slots: ArtSlots
  } | null>(null)

  const [internalWebFullscreen, setInternalWebFullscreen] = useState(false)
  const isWebFullscreen = controlledWebFullscreen ?? internalWebFullscreen

  const exitWebFullscreen = useCallback(() => {
    if (controlledWebFullscreen) {
      controlledToggleWebFullscreen?.()
    } else {
      setInternalWebFullscreen(false)
    }
  }, [controlledWebFullscreen, controlledToggleWebFullscreen])

  // 网页全屏模式下按 ESC 退出
  useEffect(() => {
    if (!isWebFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exitWebFullscreen()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isWebFullscreen, exitWebFullscreen])

  // 创建 ArtPlayer 实例（isHost 在房间会话期间不变，实例只创建一次）
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    configureArtStatics()

    // ── 构建插槽 ─────────────────────────────────
    const slots: ArtSlots = {
      danmakuRoot: createSlot('zart-danmaku-root'),
      overlayRoot: createSlot('zart-overlay-root'),
      panelRoot: createSlot('zart-panel-root'),
    }

    const art = new Artplayer({
      container,
      // 源加载完全由引擎层驱动（usePlayerSource → art.video），
      // 保持 url 为空可避免 ArtPlayer 内置 error-reconnect 用裸 URL 覆盖引擎管理的 src。
      url: '',
      lang: 'zh-cn',
      theme: 'var(--md-sys-color-primary, #6e9bff)',
      volume: 1,
      isLive: false,
      muted: false,
      autoplay: false,
      pip: false,
      screenshot: false,
      setting: false,
      loop: false,
      flip: false,
      // 禁用原生倍速控件；倍速由自定义控制栏统一操作并同步
      playbackRate: false,
      aspectRatio: false,
      // 禁用原生全屏按钮；全屏由自定义控制栏/快捷键接管
      fullscreen: false,
      // 网页全屏使用项目自有实现（受控于 RoomLayout）
      fullscreenWeb: false,
      subtitleOffset: false,
      // 禁用底部迷你进度条；由自定义控制栏提供完整进度条
      miniProgressBar: false,
      // 禁用 ArtPlayer 默认快捷键；由项目自定义控制栏/快捷键处理
      hotkey: false,
      airplay: false,
      mutex: true,
      backdrop: true,
      playsInline: true,
      moreVideoAttr: {
        playsInline: true,
        preload: 'metadata',
      },
      layers: [
        {
          name: 'danmaku',
          html: slots.danmakuRoot,
          style: { position: 'absolute', inset: '0', pointerEvents: 'none' },
        },
        {
          name: 'overlay',
          html: slots.overlayRoot,
          style: { position: 'absolute', inset: '0', pointerEvents: 'none' },
        },
      ],
      // 原生控制栏已完全由自定义控制栏替代
      controls: [],
    })

    // 模板同步生成，video 元素立即可用
    const video = art.video
    videoRef.current = video

    // 弹幕 / 覆盖图层常显
    art.layers.show = true

    // 面板根挂载到播放器容器（用于设置面板 / 空源占位）
    art.template.$player.appendChild(slots.panelRoot)

    // 空 url 初始化会让 ArtPlayer 一直显示 loading，延迟隐藏
    const hideLoadingTimer = setTimeout(() => {
      art.loading.show = false
    }, 100)

    // 观众端只读化处理：阻断视频区域单击/双击，由自定义控制栏负责申请交互
    let disposeGuards: (() => void) | null = null
    if (!isHost) {
      const iosDevice = isIOSDevice()
      disposeGuards = installViewerGuards(art, {
        onVideoDblClick: () => {
          // iOS 不支持容器全屏，双击时降级为网页全屏
          if (iosDevice || !supportsContainerFullscreen()) {
            if (controlledWebFullscreen) {
              controlledToggleWebFullscreen?.()
            } else {
              setInternalWebFullscreen((prev) => !prev)
            }
            return
          }
          // 对 .zart-stage 容器全屏，让控制栏/弹幕层等 UI 在全屏下可见可操作
          const stage = stageRef.current
          if (!stage) return
          if (getFullscreenElement()) {
            void exitFullscreen()
          } else {
            void requestFullscreen(stage).catch(() => {})
          }
        },
      })
    }

    setReady({ art, video, slots })

    return () => {
      clearTimeout(hideLoadingTimer)
      disposeGuards?.()
      videoRef.current = null
      setReady(null)
      try {
        art.destroy(false)
      } catch (err) {
        console.warn('[WatchTogetherPanel] art destroy error:', err)
      }
    }
    // isHost 在房间会话期间固定，实例无需重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stage = (
    <div
      ref={stageRef}
      className={cn(
        'zart-stage',
        !isHost && 'zart-viewer',
        isWebFullscreen
          ? 'zart-web-fullscreen fixed inset-0 z-[100]'
          : 'relative h-full w-full'
      )}
      style={
        isWebFullscreen ? { width: '100dvw', height: '100dvh' } : undefined
      }
    >
      <div ref={containerRef} className="zart-video-container h-full w-full" />
      {/* 观众端「仅允许CLI模式」未满足时的安装引导覆盖层（cliOnly 影片不回退服务器） */}
      {!isHost && <ViewerCliRequiredOverlay />}
      {ready && (
        <WatchTogetherCore
          roomId={roomId}
          isHost={isHost}
          art={ready.art}
          video={ready.video}
          videoRef={videoRef}
          stageRef={stageRef}
          slots={ready.slots}
          isWebFullscreen={isWebFullscreen}
          onToggleWebFullscreen={controlledToggleWebFullscreen}
          initialPlayback={initialPlayback}
        />
      )}
    </div>
  )

  return stage
}
