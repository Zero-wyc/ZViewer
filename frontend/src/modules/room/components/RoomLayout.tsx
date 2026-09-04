import {
  type ReactNode,
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { ArrowLeft, PanelRight, PanelRightClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { useRoomStore, type RoomMode } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import { SharingStatusPanel } from '@/modules/room/components/SharingStatusPanel'
import {
  getFullscreenElement,
  onFullscreenChange,
} from '@/lib/fullscreen-utils'
import type { SharingMode } from '@/modules/screen-sharing/hooks/useConnectionStats'
import type { P2PStatus } from '@/modules/p2p/types'

interface RoomLayoutProps {
  /** 房间 ID，用于模式切换 socket 事件 */
  roomId: string
  /** 是否房主：房主可切换模式，观众只显示当前模式标签 */
  isHost: boolean
  title?: string
  onBack?: () => void
  headerActions?: ReactNode
  /** 当前模式对应的主区域内容（watch-together / screen-share） */
  mainContent: ReactNode
  controls?: ReactNode
  /** 非共享状态下右侧面板内容（影片列表、观看影片控件等） */
  rightPanel: ReactNode
  /** 控制卡片在移动端横向滚动时的标签，按 controls 子节点顺序提供 */
  controlLabels?: string[]
  /**
   * 共享状态下的 RTCPeerConnection 实例。
   * 当前由调用方按需传入（未来通过 ref/context 从 SharePage/WatchPage 提升后接入）。
   */
  peerConnection?: RTCPeerConnection | null
  /** 共享角色：发送端 / 接收端 */
  sharingRole?: 'sender' | 'receiver'
  /** 共享模式标签，默认服务器中转 */
  sharingMode?: SharingMode
  /** P2P 直连是否已启用（来自页面层 useP2PTunnel） */
  p2pEnabled?: boolean
  /** P2P 隧道 PC（P2P 启用时用于统计展示） */
  p2pPC?: RTCPeerConnection | null
  /** P2P 协商状态 */
  p2pStatus?: P2PStatus
  /** 是否已触发回退到服务器中转 */
  p2pFallbackNotice?: boolean
  /** P2P 直连开关回调 */
  onToggleP2P?: (enabled: boolean) => void
  /**
   * 显式覆盖共享状态判断。
   * 未提供时，自动判断为 `mode === 'screen-share' && store.isSharing`。
   */
  sharingActive?: boolean
  /**
   * CSS 模拟的网页全屏状态（由播放器组件如 WatchTogetherPanel 提升）。
   * 用于在网页全屏时隐藏底部卡片等页面元素。
   */
  webFullscreen?: boolean
}

const MODE_LABELS: Record<RoomMode, string> = {
  'watch-together': '一起看',
  'screen-share': '投屏',
}

const MODE_ORDER: RoomMode[] = ['watch-together', 'screen-share']

export function RoomLayout({
  roomId,
  isHost,
  title,
  onBack,
  headerActions,
  mainContent,
  controls,
  rightPanel,
  controlLabels,
  peerConnection = null,
  sharingRole = 'sender',
  sharingMode = 'server-relay',
  p2pEnabled = false,
  p2pPC = null,
  p2pStatus = 'idle',
  p2pFallbackNotice = false,
  onToggleP2P,
  sharingActive,
  webFullscreen = false,
}: RoomLayoutProps) {
  const { guardNavigate, confirmModal: exitGuardModal } = useRoomExitGuard()
  const { socket } = useSocket()
  // defaultBack 由 guardNavigate 统一处理：
  // 在房间内时弹出确认对话框，确认后仅导航离开——房间保持运行，
  // activeRoomId 保留，右上角显示「回到房间」入口；
  // 进入/创建新房间时才真正释放旧房间（见 RoomPage 挂载逻辑）。
  const defaultBack = () => guardNavigate('/')
  const handleBack = onBack ?? defaultBack
  // 移动端默认收起侧栏，给视频留出更多空间；桌面端默认展开
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.innerWidth >= 768
  })
  const toggleRightPanel = () => setIsRightPanelOpen((open) => !open)

  // 检测浏览器原生全屏状态：原生全屏时右侧面板采用悬浮覆盖，非全屏时为固定侧边栏
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsNativeFullscreen(Boolean(getFullscreenElement()))
    }
    const dispose = onFullscreenChange(handleFullscreenChange)
    handleFullscreenChange()
    return dispose
  }, [])

  const roomMode = useRoomStore((state) => state.mode)
  const setMode = useRoomStore((state) => state.setMode)
  const storeIsSharing = useRoomStore((state) => state.isSharing)

  // 模式切换加载占位：房主点击切换后等待后端确认期间显示 Spinner
  const [isModeSwitching, setIsModeSwitching] = useState(false)

  // 用于保护模式切换过程中的竞态：记录当前请求的 id 与超时定时器
  const switchingRef = useRef<{
    id: number
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const isSharing =
    sharingActive ?? (roomMode === 'screen-share' && storeIsSharing)

  // 播放器容器使用固定高度（calc(100vh - 220px)），不使用 aspect-video，
  // 避免右侧面板内容撑开导致播放器高度变化。

  // 监听 room-mode-changed：观众端跟随房主切换无需刷新；
  // 同时清除本地加载占位（房主切换完成后）。
  useEffect(() => {
    if (!socket) return

    const handleRoomModeChanged = (data: { mode: RoomMode }) => {
      setMode(data.mode)
      setIsModeSwitching(false)
    }

    const handleDisconnect = () => {
      if (switchingRef.current) {
        if (switchingRef.current.timer) {
          clearTimeout(switchingRef.current.timer)
        }
        switchingRef.current = null
        setIsModeSwitching(false)
        message.error('连接已断开，请刷新页面后重试')
      }
    }

    socket.on('room-mode-changed', handleRoomModeChanged)
    socket.on('disconnect', handleDisconnect)

    return () => {
      if (switchingRef.current?.timer) {
        clearTimeout(switchingRef.current.timer)
      }
      switchingRef.current = null
      setIsModeSwitching(false)
      socket.off('room-mode-changed', handleRoomModeChanged)
      socket.off('disconnect', handleDisconnect)
    }
  }, [socket, setMode])

  const handleSwitchMode = (targetMode: RoomMode) => {
    if (!socket || !isHost || targetMode === roomMode || isModeSwitching) {
      return
    }

    const nextId = (switchingRef.current?.id ?? 0) + 1
    if (switchingRef.current?.timer) {
      clearTimeout(switchingRef.current.timer)
    }
    switchingRef.current = { id: nextId, timer: null }
    setIsModeSwitching(true)

    const timer = setTimeout(() => {
      if (switchingRef.current?.id === nextId) {
        switchingRef.current = null
        setIsModeSwitching(false)
        message.error('切换超时，请重试')
      }
    }, 5000)

    switchingRef.current.timer = timer

    socket.emit(
      'update-room-mode',
      { roomId, mode: targetMode },
      (response: {
        success: boolean
        message?: string
        data?: { mode?: RoomMode }
      }) => {
        if (switchingRef.current?.id !== nextId) {
          return
        }
        if (switchingRef.current.timer) {
          clearTimeout(switchingRef.current.timer)
        }
        switchingRef.current = null

        // 后端 AckResponse 标准格式：mode 在 data 字段内
        const mode = response.data?.mode
        if (response.success && mode) {
          setMode(mode)
        } else {
          message.error(response.message ?? '切换模式失败')
        }
        setIsModeSwitching(false)
      }
    )
  }

  // 共享状态下：侧栏显示「共享情况」面板，评论区（rightPanel）移动到下方 controls 区域
  const effectiveRightPanel = isSharing ? (
    <SharingStatusPanel
      pc={peerConnection}
      mode={sharingRole}
      sharingMode={sharingMode}
      p2pEnabled={p2pEnabled}
      p2pPC={p2pPC}
      p2pStatus={p2pStatus}
      fallbackNotice={p2pFallbackNotice}
      onToggleP2P={onToggleP2P ?? (() => {})}
    />
  ) : (
    rightPanel
  )

  // 共享状态下：将评论区（rightPanel）追加到下方 controls 区域与原 controls 合并渲染
  const effectiveControls = isSharing ? (
    controls ? (
      <>
        {controls}
        {rightPanel}
      </>
    ) : (
      rightPanel
    )
  ) : (
    controls
  )

  // 根据当前模式渲染主区域：切换中显示加载占位，否则渲染调用方传入的 mainContent
  const renderMainContent = () => {
    if (isModeSwitching) {
      return (
        <div className="flex h-full w-full items-center justify-center">
          <Spinner tip="正在切换模式..." size={32} />
        </div>
      )
    }

    return mainContent
  }

  // 顶部模式切换栏：房主显示两个按钮（当前模式高亮），观众只显示当前模式标签
  // 使用 Google Monet 主题变量 + 玻璃拟态效果 + 增强边框
  const modeSwitchBar = isHost ? (
    <SegmentedToggle
      options={MODE_ORDER.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
      value={roomMode}
      onChange={(value) => handleSwitchMode(value as RoomMode)}
      disabled={isModeSwitching}
      className="[&_button]:px-2.5 [&_button]:py-1 md:[&_button]:px-4 md:[&_button]:py-1.5"
    />
  ) : (
    <div
      className="glass-strong rounded-full border border-[var(--md-sys-color-outline)] px-4 py-1.5 text-xs font-medium shadow-lg ring-1 ring-[var(--md-sys-color-outline-variant)]/40"
      style={{
        backgroundColor: 'var(--md-sys-color-primary)',
        color: 'var(--md-sys-color-on-primary)',
      }}
    >
      {MODE_LABELS[roomMode]}
    </div>
  )

  // 右侧评论/弹幕面板：
  // - 桌面端：固定宽度侧边栏（320px），独立卡片式设计（圆角 + 边框 + 阴影）。
  //   高度通过外层 absolute 容器 h-full 与左侧视频严格等高；动画由父容器
  //   的 translateX 与占位区 width 共同完成，避免直接对 panel 做 width/scale。
  // - 移动端：从右侧滑入的全宽抽屉，覆盖在视频区域上方，避免 320px 超出窄屏。
  // - 原生全屏：悬浮卡片从右侧滑入，带圆角和强阴影。
  const rightPanelNode = (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden',
        isNativeFullscreen
          ? 'glass-strong absolute inset-y-0 right-0 z-20 w-[85%] max-w-[340px] rounded-l-2xl border-l transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]'
          : 'glass-card h-full w-full rounded-none rounded-l-2xl md:rounded-xl bg-[color-mix(in_srgb,var(--md-sys-color-surface)_96%,transparent)] shadow-[-4px_0_24px_-4px_rgba(0,0,0,0.25)] md:bg-transparent md:shadow-none',
        isNativeFullscreen && !isRightPanelOpen && 'translate-x-full'
      )}
      style={{
        boxShadow: isNativeFullscreen
          ? '0 8px 32px -4px rgba(0, 0, 0, 0.3)'
          : '0 4px 24px -6px color-mix(in srgb, var(--md-sys-color-shadow) 22%, transparent), 0 0 0 1px color-mix(in srgb, var(--md-sys-color-outline-variant) 50%, transparent)',
        backfaceVisibility: 'hidden',
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {effectiveRightPanel}
      </div>
    </div>
  )

  // 展开 Fragment，收集真实子节点，确保 controls 传入 Fragment 时仍能分成独立卡片
  function flattenChildren(node: ReactNode): ReactNode[] {
    return Children.toArray(node).flatMap((child) => {
      if (isValidElement(child) && child.type === Fragment) {
        return flattenChildren(child.props.children)
      }
      return [child]
    })
  }

  const controlChildren = effectiveControls
    ? flattenChildren(effectiveControls)
    : []

  // 移动端控制卡片的标签：调用方未提供时按索引生成默认文本
  const mobileCardLabels = controlLabels?.length
    ? controlLabels.slice(0, controlChildren.length)
    : controlChildren.map((_, i) => `卡片 ${i + 1}`)

  // 移动端控制卡片横向滚动的当前索引与滚动处理
  const mobileCardsScrollRef = useRef<HTMLDivElement>(null)
  const [activeControlIndex, setActiveControlIndex] = useState(0)

  // React Compiler 无法保留现有手动 memoization，此处依赖已手动优化。
  /* eslint-disable react-hooks/preserve-manual-memoization */
  const handleMobileCardsScroll = useCallback(() => {
    const el = mobileCardsScrollRef.current
    if (!el) return
    const card = el.firstElementChild as HTMLElement | null
    if (!card) return
    const cardWidth = card.offsetWidth
    // gap-3 = 0.75rem = 12px
    const gap = 12
    const index = Math.round(el.scrollLeft / (cardWidth + gap))
    setActiveControlIndex(
      Math.min(controlChildren.length - 1, Math.max(0, index))
    )
  }, [controlChildren.length])

  const scrollToMobileCard = useCallback((index: number) => {
    const el = mobileCardsScrollRef.current
    if (!el) return
    const card = el.children[index] as HTMLElement | undefined
    if (card) {
      card.scrollIntoView({
        behavior: 'smooth',
        inline: 'start',
        block: 'nearest',
      })
    }
  }, [])
  /* eslint-enable react-hooks/preserve-manual-memoization */

  const roomContent = (
    <>
      {/* 顶部工具栏：返回、模式切换、右侧操作在同一行，避免 absolute 重叠 */}
      <div className="z-30 flex flex-none items-center justify-between gap-2 px-2 pt-3 pb-2 md:px-4 md:pt-4">
        <Button
          variant="ghost"
          size="sm"
          disableAnimation
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={handleBack}
          className="glass flex-shrink-0 border px-3"
          style={{
            borderColor: 'var(--md-sys-color-outline-variant)',
            color: 'var(--md-sys-color-on-surface)',
          }}
        >
          返回
        </Button>

        {/* 顶部模式切换栏（玻璃拟态 + Monet 主题变量，当前模式高亮 primary 色） */}
        <div className="flex flex-1 justify-center px-2">{modeSwitchBar}</div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            onClick={toggleRightPanel}
            aria-label={isRightPanelOpen ? '收起侧栏' : '展开侧栏'}
            aria-expanded={isRightPanelOpen}
            title={isRightPanelOpen ? '收起侧栏' : '展开侧栏'}
            className="glass hidden h-9 w-9 items-center justify-center rounded-lg border transition-all duration-200 hover:scale-105 active:scale-95 md:flex"
            style={{
              borderColor: 'var(--md-sys-color-outline-variant)',
              color: isRightPanelOpen
                ? 'var(--md-sys-color-primary)'
                : 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            {isRightPanelOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRight className="h-4 w-4" />
            )}
          </button>
          {headerActions}
        </div>
      </div>

      {title && (
        <Title level={3} className="pt-2 text-center">
          {title}
        </Title>
      )}

      <div
        className={cn(
          'relative mt-4 flex min-h-0 flex-none gap-3 overflow-hidden',
          isNativeFullscreen
            ? ''
            : 'max-h-[calc(100vh-150px)] md:max-h-[calc(100vh-220px)]'
        )}
      >
        {/* 左侧播放器：决定整个容器高度，flex-1 随侧栏开闭平滑改变宽度 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="relative aspect-[4/3] w-full overflow-hidden rounded-lg bg-black md:aspect-video">
            {renderMainContent()}
            {isNativeFullscreen && !webFullscreen && rightPanelNode}
          </div>
        </div>
        {/* 移动端抽屉背景遮罩：点击可关闭侧栏 */}
        {!isNativeFullscreen && !webFullscreen && isRightPanelOpen && (
          <div
            className="absolute inset-0 z-10 bg-black/50 md:hidden"
            aria-hidden="true"
            onClick={() => setIsRightPanelOpen(false)}
          />
        )}
        {/* 右侧占位区：仅桌面端显示，宽度动画与绝对定位面板同步滑动 */}
        {!isNativeFullscreen && !webFullscreen && (
          <div
            className={cn(
              'hidden flex-shrink-0 overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:block',
              isRightPanelOpen ? 'w-[320px]' : 'w-0'
            )}
            aria-hidden="true"
          />
        )}
        {/* 右侧面板：移动端为全宽抽屉覆盖在视频上方，桌面端为固定宽度侧边栏 */}
        {!isNativeFullscreen && !webFullscreen && (
          <div
            className={cn(
              'pointer-events-none fixed inset-y-0 right-0 z-[9999] w-full overflow-hidden transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:absolute md:top-0 md:h-full md:w-[320px]',
              isRightPanelOpen ? 'translate-x-0' : 'translate-x-full'
            )}
            style={{ willChange: 'transform' }}
          >
            <div className="pointer-events-auto h-full w-full overflow-hidden">
              {rightPanelNode}
            </div>
          </div>
        )}
      </div>
    </>
  )

  return (
    <>
      <div
        className={cn(
          'hide-scrollbar flex flex-col items-center overflow-y-auto px-2 py-3 md:px-4 md:py-6',
          webFullscreen
            ? 'fixed inset-0 z-[100] h-screen min-h-0 items-stretch p-0 overflow-hidden'
            : 'h-[calc(100vh-64px)]'
        )}
      >
        {/* 网页全屏时仍然使用 Card，避免容器类型切换导致 WatchTogetherPanel 重新挂载、
          ArtPlayer 重建而重新加载视频。通过 !important 覆盖 glass 样式，使内部 fixed
          定位的 .zart-stage 能相对于 viewport 铺满整个窗口。 */}
        <Card
          disableAnimation={webFullscreen}
          className={cn(
            'relative flex flex-none flex-col overflow-hidden min-h-0 bg-transparent',
            webFullscreen
              ? 'h-full w-full !rounded-none !border-0 !bg-black !p-0 !shadow-none !backdrop-filter-none'
              : 'w-full max-w-6xl p-3 md:p-6'
          )}
        >
          {roomContent}
        </Card>

        {effectiveControls && !webFullscreen && !isNativeFullscreen && (
          <div className="w-full max-w-6xl flex-none mt-2 md:mt-4">
            {(() => {
              if (controlChildren.length === 1) {
                // 共享状态下评论区单独在下方时限制高度，避免无限撑开
                return (
                  <div
                    className={isSharing ? 'h-[360px] md:h-[500px]' : 'h-full'}
                  >
                    {controlChildren[0]}
                  </div>
                )
              }
              // 三个控制卡片固定等高 340px，内部内容各自滚动。
              // 桌面端三列平铺；移动端改为横向滚动，避免纵向堆叠占用过多空间。
              return (
                <>
                  {/* 移动端：横向滚动卡片，顶部显示 Tab 标签便于切换 */}
                  <div className="flex flex-col gap-2 lg:hidden">
                    {controlChildren.length > 1 && (
                      <div className="flex items-center justify-between gap-1 px-1">
                        <div className="flex flex-1 items-center justify-center gap-1">
                          {mobileCardLabels.map((label, index) => (
                            <button
                              key={index}
                              type="button"
                              aria-label={`切换到${label}`}
                              onClick={() => scrollToMobileCard(index)}
                              className={cn(
                                'min-w-[4rem] rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200',
                                activeControlIndex === index
                                  ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-md'
                                  : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                              )}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <button
                          onClick={toggleRightPanel}
                          aria-label={
                            isRightPanelOpen ? '收起侧栏' : '展开侧栏'
                          }
                          aria-expanded={isRightPanelOpen}
                          title={isRightPanelOpen ? '收起侧栏' : '展开侧栏'}
                          className="glass flex h-8 w-8 items-center justify-center rounded-lg border transition-all duration-200 hover:scale-105 active:scale-95"
                          style={{
                            borderColor: 'var(--md-sys-color-outline-variant)',
                            color: isRightPanelOpen
                              ? 'var(--md-sys-color-primary)'
                              : 'var(--md-sys-color-on-surface-variant)',
                          }}
                        >
                          {isRightPanelOpen ? (
                            <PanelRightClose className="h-4 w-4" />
                          ) : (
                            <PanelRight className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    )}
                    <div
                      ref={mobileCardsScrollRef}
                      className="flex h-[340px] snap-x snap-mandatory gap-3 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]"
                      onScroll={handleMobileCardsScroll}
                    >
                      {controlChildren.map((child, index) => (
                        <div
                          key={index}
                          className="h-full w-[80vw] max-w-[320px] flex-shrink-0 snap-start"
                        >
                          {child}
                        </div>
                      ))}
                    </div>
                  </div>
                  {/* 桌面端：根据卡片数量动态列数，避免少量卡片时宽度过小。
                    1 张 → 单列占满；2 张 → 两列；3 张及以上 → 三列。 */}
                  <div
                    className={cn(
                      'hidden h-[340px] gap-4 lg:grid',
                      controlChildren.length === 1 && 'lg:grid-cols-1',
                      controlChildren.length === 2 && 'lg:grid-cols-2',
                      controlChildren.length >= 3 && 'lg:grid-cols-3'
                    )}
                  >
                    {controlChildren.map((child, index) => (
                      <Fragment key={index}>{child}</Fragment>
                    ))}
                  </div>
                </>
              )
            })()}
          </div>
        )}
      </div>
      {/* 离开房间确认对话框（useRoomExitGuard 提供） */}
      {exitGuardModal}
    </>
  )
}
