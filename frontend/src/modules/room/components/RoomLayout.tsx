import { type ReactNode, Children, Fragment, isValidElement, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
import { SharingStatusPanel } from '@/modules/room/components/SharingStatusPanel'
import type { SharingMode } from '@/hooks/useConnectionStats'

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
  /**
   * 共享状态下的 RTCPeerConnection 实例。
   * 当前由调用方按需传入（未来通过 ref/context 从 SharePage/WatchPage 提升后接入）。
   */
  peerConnection?: RTCPeerConnection | null
  /** 共享角色：发送端 / 接收端 */
  sharingRole?: 'sender' | 'receiver'
  /** 共享模式标签，默认服务器中转 */
  sharingMode?: SharingMode
  /** P2P 直连开关当前状态（Task 6.3 接入） */
  p2pEnabled?: boolean
  /** P2P 直连开关回调（Task 6.3 接入） */
  onToggleP2P?: (enabled: boolean) => void
  /**
   * 显式覆盖共享状态判断。
   * 未提供时，自动判断为 `mode === 'screen-share' && store.isSharing`。
   */
  sharingActive?: boolean
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
  peerConnection = null,
  sharingRole = 'sender',
  sharingMode = 'server-relay',
  p2pEnabled,
  onToggleP2P,
  sharingActive,
}: RoomLayoutProps) {
  const navigate = useNavigate()
  const handleBack = onBack ?? (() => navigate('/'))
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(true)
  const toggleRightPanel = () => setIsRightPanelOpen((open) => !open)

  // 检测浏览器网页全屏状态：全屏时右侧面板采用悬浮覆盖，非全屏时为固定侧边栏
  const [isWebFullscreen, setIsWebFullscreen] = useState(false)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsWebFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    handleFullscreenChange()
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  const { socket } = useSocket()
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
      (response: { success: boolean; message?: string; mode?: RoomMode }) => {
        if (switchingRef.current?.id !== nextId) {
          return
        }
        if (switchingRef.current.timer) {
          clearTimeout(switchingRef.current.timer)
        }
        switchingRef.current = null

        if (response.success && response.mode) {
          setMode(response.mode)
        } else {
          message.error(response.message ?? '切换模式失败')
        }
        setIsModeSwitching(false)
      }
    )
  }

  // 共享状态下用「共享情况」面板替代影片列表与观看影片控件
  const effectiveRightPanel = isSharing ? (
    <SharingStatusPanel
      pc={peerConnection}
      mode={sharingRole}
      sharingMode={sharingMode}
      p2pEnabled={p2pEnabled}
      onToggleP2P={onToggleP2P}
    />
  ) : (
    rightPanel
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
  // - 非全屏：固定宽度侧边栏（320px），位于视频右侧，不挤压播放器宽度
  // - 网页全屏：悬浮层覆盖在视频区域上方
  const rightPanelNode = (
    <div
      className={cn(
        'glass-strong flex min-h-0 min-w-0 flex-col overflow-hidden border-l border-[var(--glass-border)] transition-all duration-200 ease-in-out',
        isWebFullscreen
          ? 'absolute inset-y-0 right-0 z-20 w-[80%] max-w-[320px]'
          : 'w-[320px] flex-shrink-0',
        isWebFullscreen && !isRightPanelOpen && 'translate-x-full',
        !isWebFullscreen && !isRightPanelOpen && 'w-0 opacity-0'
      )}
    >
      {effectiveRightPanel}
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

  return (
    <div className="flex h-[calc(100vh-64px)] flex-col items-center overflow-hidden px-4 py-6">
      <Card className="relative flex w-full max-w-6xl flex-1 flex-col overflow-hidden min-h-0">
        {/* 顶部工具栏：返回、模式切换、右侧操作在同一行，避免 absolute 重叠 */}
        <div className="z-30 flex flex-none items-center justify-between gap-2 px-4 pt-4 pb-2">
          <Button
            variant="ghost"
            size="sm"
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
            <Button
              variant="ghost"
              size="sm"
              icon={
                isRightPanelOpen ? (
                  <PanelRightClose className="h-4 w-4" />
                ) : (
                  <PanelRight className="h-4 w-4" />
                )
              }
              onClick={toggleRightPanel}
              aria-label={isRightPanelOpen ? '收起侧栏' : '展开侧栏'}
              aria-expanded={isRightPanelOpen}
            >
              侧栏
            </Button>
            {headerActions}
          </div>
        </div>

        {title && (
          <Title level={3} className="pt-2 text-center">
            {title}
          </Title>
        )}

        <div className="relative mt-4 flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div
              className={cn(
                'relative h-full w-full overflow-hidden rounded-lg bg-black',
                !isWebFullscreen && 'aspect-video'
              )}
            >
              {renderMainContent()}
              {isWebFullscreen && rightPanelNode}
            </div>
          </div>
          {!isWebFullscreen && rightPanelNode}
        </div>

        {controls && !isWebFullscreen && (
          <div className="flex-none overflow-y-auto border-t border-[var(--md-sys-color-outline)] px-4 py-3 mt-2 max-h-[160px]">
            {(() => {
              const controlChildren = flattenChildren(controls)
              if (controlChildren.length === 1) {
                return controlChildren[0]
              }
              return (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  {controlChildren.map((child, index) => (
                    <Card
                      key={index}
                      className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container)] p-4"
                    >
                      {child}
                    </Card>
                  ))}
                </div>
              )
            })()}
          </div>
        )}
      </Card>
    </div>
  )
}
