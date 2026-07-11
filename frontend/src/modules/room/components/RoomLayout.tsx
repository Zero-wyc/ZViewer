import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, MessageSquare, X, Film } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Text } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { useRoomStore, type RoomMode } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { SharingStatusPanel } from '@/modules/room/components/SharingStatusPanel'
import { BiliCompatPlayer } from '@/modules/room/bili-compat/BiliCompatPlayer'
import type { SharingMode } from '@/hooks/useConnectionStats'

// 房间模式扩展：在 store 现有两模式基础上新增 bili-compat（store 类型暂未更新，本地扩展）
type ExtendedRoomMode = RoomMode | 'bili-compat'

interface RoomLayoutProps {
  /** 房间 ID，用于模式切换 socket 事件与 B站兼容模式同步 */
  roomId: string
  /** 是否房主：房主可切换模式，观众只显示当前模式标签 */
  isHost: boolean
  title?: string
  onBack?: () => void
  headerActions?: ReactNode
  /** 当前模式对应的主区域内容（watch-together / screen-share）。
   *  bili-compat 模式由 RoomLayout 内部直接渲染 BiliCompatPlayer，无需调用方传入。 */
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

const MODE_LABELS: Record<ExtendedRoomMode, string> = {
  'watch-together': '一起看',
  'screen-share': '投屏',
  'bili-compat': 'B站兼容',
}

const MODE_ORDER: ExtendedRoomMode[] = [
  'watch-together',
  'screen-share',
  'bili-compat',
]

// 从 B站 视频 URL 中提取 bvid（BV 后跟 10 位字母数字）
function extractBvid(url: string): string | null {
  const match = url.match(/BV[0-9A-Za-z]{10}/)
  return match ? match[0] : null
}

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
  const [isRightPanelOpen, setIsRightPanelOpen] = useState(false)
  const toggleRightPanel = () => setIsRightPanelOpen((open) => !open)

  const { socket } = useSocket()
  // store 中 RoomMode 类型暂未包含 bili-compat，此处扩展为本地类型以支持新模式
  const roomMode = useRoomStore((state) => state.mode) as ExtendedRoomMode
  const setMode = useRoomStore((state) => state.setMode)
  const storeIsSharing = useRoomStore((state) => state.isSharing)
  const movies = useRoomStore((state) => state.movies)
  const currentMovieId = useRoomStore((state) => state.currentMovieId)

  // 模式切换加载占位：房主点击切换后等待后端确认期间显示 Spinner
  const [isModeSwitching, setIsModeSwitching] = useState(false)

  const isSharing =
    sharingActive ?? (roomMode === 'screen-share' && storeIsSharing)

  // 当前选中影片与 bvid（仅 bili-compat 模式使用）
  const currentMovie = useMemo(
    () => movies.find((m) => m.id === currentMovieId) ?? null,
    [movies, currentMovieId]
  )

  const bvid = useMemo(() => {
    if (!currentMovie) return null
    if (currentMovie.sourceType !== 'bilibili') return null
    return extractBvid(currentMovie.url)
  }, [currentMovie])

  // 监听 room-mode-changed：观众端跟随房主切换无需刷新；
  // 同时清除本地加载占位（房主切换完成后）。
  useEffect(() => {
    if (!socket) return
    const handleRoomModeChanged = (data: { mode: ExtendedRoomMode }) => {
      setMode(data.mode as RoomMode)
      setIsModeSwitching(false)
    }
    socket.on('room-mode-changed', handleRoomModeChanged)
    return () => {
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [socket, setMode])

  const handleSwitchMode = (targetMode: ExtendedRoomMode) => {
    if (!socket || !isHost || targetMode === roomMode || isModeSwitching) {
      return
    }
    setIsModeSwitching(true)
    socket.emit(
      'update-room-mode',
      { roomId, mode: targetMode },
      (response: {
        success: boolean
        message?: string
        mode?: ExtendedRoomMode
      }) => {
        if (response.success && response.mode) {
          setMode(response.mode as RoomMode)
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

  // 根据当前模式渲染主区域：
  // - 切换中：加载占位，避免画面闪烁
  // - bili-compat：RoomLayout 直接渲染 B站 iframe 播放器，
  //   隐藏自创播放器控制器与弹幕引擎（B站 iframe 自带弹幕）
  // - 其他模式：渲染调用方传入的 mainContent
  // 切换出 bili-compat 时 BiliCompatPlayer 卸载，React 自动清理 iframe 资源
  const renderMainContent = () => {
    if (isModeSwitching) {
      return (
        <div className="flex h-full w-full items-center justify-center">
          <Spinner tip="正在切换模式..." size={32} />
        </div>
      )
    }

    if (roomMode === 'bili-compat') {
      if (bvid) {
        return <BiliCompatPlayer bvid={bvid} roomId={roomId} isHost={isHost} />
      }
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
          <div className="glass-strong flex h-16 w-16 items-center justify-center rounded-full">
            <Film className="h-8 w-8 opacity-70" />
          </div>
          <Text type="secondary" className="text-sm">
            {isHost
              ? '请在右侧影片列表中选择 B站 视频，再切换到 B站兼容模式'
              : '等待房主选择 B站 视频'}
          </Text>
        </div>
      )
    }

    return mainContent
  }

  // 顶部模式切换栏：房主显示三个按钮（当前模式高亮），观众只显示当前模式标签
  // 使用 Google Monet 主题变量 + 玻璃拟态效果 + 增强边框
  const modeSwitchBar = isHost ? (
    <SegmentedToggle
      options={MODE_ORDER.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
      value={roomMode}
      onChange={(value) => handleSwitchMode(value as ExtendedRoomMode)}
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

  // 右侧评论/弹幕面板：以悬浮层形式覆盖在视频区域上方，避免改变播放器宽度
  const rightPanelNode = (
    <div
      className={cn(
        'glass-strong absolute inset-y-0 right-0 z-20 flex w-[80%] max-w-[320px] flex-col overflow-hidden border-l border-[var(--glass-border)] transition-transform duration-200 ease-in-out',
        isRightPanelOpen ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      {effectiveRightPanel}
    </div>
  )

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="relative flex h-full w-full max-w-7xl flex-col overflow-hidden">
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
          <div className="flex-1 flex justify-center px-2">
            {modeSwitchBar}
          </div>

          <div className="flex flex-shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={
                isRightPanelOpen ? (
                  <X className="h-4 w-4" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )
              }
              onClick={toggleRightPanel}
              aria-label={isRightPanelOpen ? '收起评论' : '展开评论'}
              aria-expanded={isRightPanelOpen}
            >
              评论
            </Button>
            {headerActions}
          </div>
        </div>

        {title && (
          <Title level={3} className="pt-2 text-center">
            {title}
          </Title>
        )}

        <div className="relative mt-4 flex flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
            <div className="relative min-h-[280px] flex-1 overflow-hidden rounded-lg bg-black">
              {renderMainContent()}
              {rightPanelNode}
            </div>
            {controls && (
              <div className="mt-3 flex-shrink-0 overflow-y-auto">
                {controls}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  )
}
