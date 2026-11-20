/**
 * PlayerChrome —— 共享画面播放器的通用外壳。
 *
 * 原来这套 UI（舞台、分屏评论区、玻璃拟态控制栏、加载/缓冲/错误遮罩、
 * 控制栏自动隐藏、横竖屏旋转、全屏浮层宿主）只存在于 FlvPlayer（OBS 推流
 * 观众端）。这里抽成独立组件，WebRTC 观众端直接复用同一套外壳，只把「引擎」
 * 换掉（FlvPlayer 里是 mpegts.js + video 容器，WebRTC 里是 RemoteVideoPlayer），
 * 从而保证两种共享方式的观众端界面完全一致。
 *
 * 使用方只负责：children（媒体内容）、overlay（静音提示等）、
 * 播放状态与回调、各自的遮罩状态（loading / warming / error）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Maximize,
  Maximize2,
  MessageSquare,
  Minimize,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { IconButton, RotateButton } from '@/components/VideoControls'
import { cn } from '@/lib/utils'
import {
  isIOSDevice,
  supportsContainerFullscreen,
  isElementFullscreen,
  exitFullscreen,
  requestFullscreen,
  onFullscreenChange,
} from '@/lib/fullscreen-utils'
import { usePlayerRotation } from '@/lib/player-orientation'
import {
  useControlBarAutoHide,
  type ControlBarInteraction,
  type ControlBarInteractionKind,
} from '@/hooks/useControlBarAutoHide'
import { useIsPortraitMobile } from '@/hooks/useMediaQuery'
import { useFullscreenOverlayHost } from '@/hooks/useFullscreenOverlayHost'
import {
  CommentSplit,
  useCommentSplit,
  useCommentSplitOrientation,
} from '@/components/CommentSplit'
import { t } from '@/i18n'

/** 直播连接状态（与 FlvPlayer 的 StreamStatus 保持一致） */
export type PlayerChromeStatus =
  | 'connecting'
  | 'playing'
  | 'error'
  | 'stopped'
  /** 房主暂停了共享（观众冻结在最后一帧） */
  | 'paused'

interface PlayerChromeProps {
  /** 媒体内容（video 容器 / RemoteVideoPlayer） */
  children: ReactNode
  /** 叠加在媒体之上、控制栏之下的内容（例如静音提示按钮） */
  overlay?: ReactNode
  /** 附加 className（作用于舞台元素） */
  className?: string
  /** 连接状态标签 */
  status: PlayerChromeStatus
  /** 来源标签，例如「OBS 推流」「WebRTC 共享」 */
  sourceLabel: string
  isPlaying: boolean
  isMuted: boolean
  onTogglePlayPause: () => void
  onToggleMute: () => void
  onRefresh: () => void
  loading?: boolean
  loadingTip?: string
  /** 起播缓冲遮罩 */
  warming?: boolean
  warmingTip?: string
  errorMsg?: string | null
  errorHint?: string
  /** 网页全屏（受控） */
  webFullscreen: boolean
  onToggleWebFullscreen: () => void
  /** 全屏时可分屏显示的评论区 */
  commentPanel?: ReactNode
  /** 手机竖屏非全屏时「查看全部评论」入口 */
  onOpenCommentSheet?: () => void
  /** 是否展示「查看全部评论」按钮（由调用方判断竖屏/非全屏） */
  canOpenCommentSheet?: boolean
  /** 额外的控制栏按钮（例如 WebRTC 观众端的画中画 / 批注 / 音量滑杆） */
  extraControls?: ReactNode
  /** 额外的状态标签（渲染在第二行，例如 WebRTC 连接状态与分辨率） */
  extraStatus?: ReactNode
  /**
   * 控制栏上方的浮动面板（例如观众端批注工具）。
   * 由 PlayerChrome 负责定位在控制栏正上方，并跟随控制栏一起显示/隐藏：
   * 控制栏收起时面板淡出并让位给画面，重新唤出控制栏时一起回来。
   */
  barPopover?: ReactNode
  /**
   * 浮动面板的水平对齐：默认贴控制栏右端；横屏矮窗的横排批注条改成居中，
   * 免得被右下角的悬浮球（一起听 / 语音 / 角色设置）压住按钮。
   */
  barPopoverAlign?: 'right' | 'center'
  /** 全屏浮层宿主 owner（语音/音乐悬浮球 portal 的归属） */
  overlayOwner: string
}

/**
 * 分屏评论区打开时的交互判定：
 * - 控制栏自身：normal（否则按钮点不动）
 * - 分屏评论区 / 分隔条：quiet（既不收控制栏，也不唤醒）
 * - 舞台按下：控制栏隐藏时 normal（唤醒），可见时 swallow（关闭分屏并收控制栏）
 * - 其余画面按下（未开分屏）：toggle（点画面切换控制栏显隐）
 * 悬停（move）永不触发 swallow：鼠标划过画面不该把评论区收掉。
 */
function resolveInteraction(
  target: EventTarget | null,
  kind: ControlBarInteractionKind,
  splitActive: boolean,
  controlBarVisible: boolean
): ControlBarInteraction {
  const el = target instanceof Element ? target : null
  if (el?.closest('.vc-container')) return 'normal'
  // 批注画布正在接收指针时不算「点播放器」：画一笔不该把控制栏和批注工具一起收掉
  if (el?.closest('[data-annotation-canvas]')) return 'normal'
  if (
    el?.closest(
      '[data-comment-split-pane], [data-split-ignore-click], [data-comment-split] [role="separator"]'
    )
  ) {
    return 'quiet'
  }
  if (splitActive && kind === 'down') {
    if (!controlBarVisible) return 'normal'
    return 'swallow'
  }
  if (kind === 'down' && el?.closest('video, canvas')) return 'toggle'
  return 'normal'
}

export function PlayerChrome({
  children,
  overlay,
  className,
  status,
  sourceLabel,
  isPlaying,
  isMuted,
  onTogglePlayPause,
  onToggleMute,
  onRefresh,
  loading = false,
  loadingTip,
  warming = false,
  warmingTip,
  errorMsg = null,
  errorHint,
  webFullscreen,
  onToggleWebFullscreen,
  commentPanel,
  onOpenCommentSheet,
  canOpenCommentSheet = false,
  extraControls,
  extraStatus,
  barPopover,
  barPopoverAlign = 'right',
  overlayOwner,
}: PlayerChromeProps) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const controlBarVisibleRef = useRef(false)
  // 本次按下时控制栏是否隐藏：隐藏时第一次点画面只唤醒控制栏，不关分屏
  const barHiddenAtTapRef = useRef(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // 原生全屏状态跟踪（全屏按钮图标、分屏可用性都看它）
  useEffect(
    () =>
      onFullscreenChange(() =>
        setIsFullscreen(Boolean(document.fullscreenElement))
      ),
    []
  )

  // 触屏全屏后横竖屏旋转
  const rotation = usePlayerRotation({
    stageRef,
    active: isFullscreen || webFullscreen,
    cssFallbackActive: webFullscreen,
  })

  // 全屏（原生/网页）评论区二分屏
  const commentSplit = useCommentSplit(isFullscreen || webFullscreen)
  const commentSplitOrientation = useCommentSplitOrientation()
  const splitActive = commentSplit.active && Boolean(commentPanel)
  const portraitMobile = useIsPortraitMobile()
  // 手机竖屏非全屏：评论只有播放器下方一小块，控制栏给一个入口弹大列表
  const showCommentSheetButton =
    Boolean(commentPanel) &&
    Boolean(onOpenCommentSheet) &&
    canOpenCommentSheet &&
    portraitMobile &&
    !isFullscreen &&
    !webFullscreen

  const handleBlockedStageInteraction = useCallback(() => {
    if (splitActive) commentSplit.close()
  }, [splitActive, commentSplit])

  const handleVideoClickClose = useCallback(() => {
    if (barHiddenAtTapRef.current) return
    commentSplit.close()
  }, [commentSplit])

  // 用 useCallback 固定判定函数：hook 的 effect 依赖它，若每次渲染都换新引用，
  // 播放状态/统计等高频更新会不停重启 effect，把「空闲自动收起」的计时器一起
  // 重置，控制栏（以及跟着它的浮动面板）就永远收不起来。
  const resolveInteractionCb = useCallback(
    (target: EventTarget | null, kind: ControlBarInteractionKind) =>
      resolveInteraction(
        target,
        kind,
        splitActive,
        controlBarVisibleRef.current
      ),
    [splitActive]
  )

  const controlBarVisible = useControlBarAutoHide(stageRef, {
    disabled: loading || Boolean(errorMsg),
    resolveInteraction: resolveInteractionCb,
    onBlockedInteraction: handleBlockedStageInteraction,
  })
  // 提交后同步：事件回调与捕获阶段读到的必须是最新值。布局阶段写入可保证
  // 先于任何指针事件生效，又不必在渲染期读写 ref。
  useLayoutEffect(() => {
    controlBarVisibleRef.current = controlBarVisible
  }, [controlBarVisible])

  // 捕获阶段记录按下瞬间的可见性（同一次事件里 state 还没刷新）
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return undefined
    const handleTapStart = () => {
      barHiddenAtTapRef.current = !controlBarVisibleRef.current
    }
    stage.addEventListener('pointerdown', handleTapStart, true)
    return () => stage.removeEventListener('pointerdown', handleTapStart, true)
  }, [])

  useFullscreenOverlayHost({
    owner: overlayOwner,
    stageRef,
    active: isFullscreen || webFullscreen,
    controlBarVisible,
  })

  const handleFullscreen = useCallback(() => {
    // iOS / 不支持容器全屏的设备退回网页全屏（CSS 模拟全屏，保留控制栏等 UI）
    if (isIOSDevice() || !supportsContainerFullscreen()) {
      onToggleWebFullscreen()
      return
    }
    const stage = stageRef.current
    if (!stage) return
    if (isElementFullscreen(stage)) {
      void exitFullscreen()
    } else {
      void requestFullscreen(stage).catch(() => {
        onToggleWebFullscreen()
      })
    }
  }, [onToggleWebFullscreen])

  const statusColor =
    status === 'playing' ? 'success' : status === 'error' ? 'danger' : 'primary'
  const statusLabel =
    status === 'playing'
      ? t('直播中')
      : status === 'error'
        ? t('连接失败')
        : status === 'stopped'
          ? t('已停止')
          : status === 'paused'
            ? t('已暂停')
            : t('连接中')

  return (
    <div
      ref={stageRef}
      className={cn(
        'zart-stage group',
        webFullscreen && 'zart-web-fullscreen fixed inset-0 z-[100]',
        className
      )}
      style={webFullscreen ? { width: '100dvw', height: '100dvh' } : undefined}
    >
      <CommentSplit
        active={splitActive}
        orientation={commentSplitOrientation}
        ratio={commentSplit.ratio}
        onRatioChange={commentSplit.setRatio}
        comment={commentPanel}
        commentLabel={t('评论区')}
        onVideoClickClose={handleVideoClickClose}
      >
        <div className="relative h-full w-full overflow-hidden">
          {children}
          {overlay}
        </div>

        {loading && !errorMsg && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <Spinner tip={loadingTip ?? t('正在连接直播流...')} size={32} />
          </div>
        )}
        {/* 起播等待：缓冲攒够了才真正开播，避免刚进来就卡顿 */}
        {!loading && !errorMsg && warming && (
          <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-black/85">
            <Spinner size={32} />
            <span className="text-sm text-white/80">
              {warmingTip ?? t('正在缓冲视频')}
            </span>
          </div>
        )}
        {errorMsg && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
            <div className="text-base font-medium text-[var(--md-sys-color-error)]">
              {errorMsg}
            </div>
            <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
              {errorHint ?? t('请检查网络连接或房主推流状态')}
            </div>
            <button
              type="button"
              className="mt-1 rounded-lg border border-white/20 px-4 py-1.5 text-sm text-white transition-colors hover:bg-white/10"
              onClick={onRefresh}
            >
              {t('重新连接')}
            </button>
          </div>
        )}

        {!loading && !errorMsg && !warming && (
          <div
            className={cn(
              'vc-container absolute bottom-0 left-0 right-0 z-20 p-2',
              !controlBarVisible && 'pointer-events-none'
            )}
          >
            {barPopover && (
              <div
                className={cn(
                  'absolute inset-x-0 bottom-full z-30 mb-2 flex transition-all duration-200 ease-out',
                  barPopoverAlign === 'center'
                    ? 'justify-center'
                    : 'justify-end pr-2',
                  controlBarVisible
                    ? 'translate-y-0 opacity-100'
                    : 'pointer-events-none translate-y-2 opacity-0'
                )}
              >
                <div className="pointer-events-auto">{barPopover}</div>
              </div>
            )}
            <div
              className={cn(
                'glass-strong rounded-xl px-2.5 py-2 shadow-lg',
                controlBarVisible
                  ? 'zart-controlbar-enter'
                  : 'zart-controlbar-exit'
              )}
            >
              <div className="flex flex-wrap items-center vc-gap">
                <IconButton
                  icon={isPlaying ? <Pause /> : <Play />}
                  label={isPlaying ? t('暂停') : t('播放')}
                  onClick={onTogglePlayPause}
                />
                <IconButton
                  icon={isMuted ? <VolumeX /> : <Volume2 />}
                  label={isMuted ? t('取消静音') : t('静音')}
                  onClick={onToggleMute}
                />
                <IconButton
                  icon={webFullscreen ? <Minimize /> : <Maximize />}
                  label={webFullscreen ? t('退出网页全屏') : t('网页全屏')}
                  onClick={onToggleWebFullscreen}
                />
                {commentPanel && (isFullscreen || webFullscreen) && (
                  <IconButton
                    icon={<MessageSquare />}
                    label={t('评论区')}
                    active={commentSplit.open}
                    onClick={commentSplit.toggle}
                  />
                )}
                {showCommentSheetButton && (
                  <IconButton
                    icon={<MessageSquare />}
                    label={t('查看评论')}
                    onClick={onOpenCommentSheet}
                  />
                )}
                {extraControls}
                {rotation.canRotate && (
                  <RotateButton
                    forcedLandscape={rotation.forcedLandscape}
                    onToggle={rotation.toggle}
                  />
                )}
                <IconButton
                  icon={isFullscreen ? <Minimize2 /> : <Maximize2 />}
                  label={isFullscreen ? t('退出全屏') : t('全屏')}
                  onClick={handleFullscreen}
                />
                <IconButton
                  icon={<RefreshCw />}
                  label={t('刷新连接')}
                  onClick={onRefresh}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Tag color={statusColor}>{statusLabel}</Tag>
                <Tag color="primary">{sourceLabel}</Tag>
                {isMuted ? (
                  <Tag color="default">{t('静音中')}</Tag>
                ) : (
                  <Tag color="cyan">{t('音频开启')}</Tag>
                )}
                {extraStatus}
              </div>
            </div>
          </div>
        )}
      </CommentSplit>
    </div>
  )
}
