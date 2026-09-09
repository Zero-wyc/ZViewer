/**
 * 一起听主区域新根（Hydrogen 完整应用框架）。
 *
 * 竖向布局 = 顶部导航（MusicTopNav）+ 内容页（flex-1 滚动，多页切换）+
 * 底部固定条（MusicWidgetBar）+ 队列弹窗（MusicQueuePopup）。
 * 点击 widget 封面 → playerOverlayOpen=true，覆盖层渲染 ListenTogetherPanel
 * （完整播放器，复用外层 Provider 实例）。
 *
 * 房主审批/房主离线提示条置于 shell 顶部左上（absolute，同 ListenTogetherPanel
 * 的提示范式：5s 自动消失，房主带通过/拒绝小按钮）。
 *
 * 内部 useMusicPlayer()：MusicPlayerProvider 已由 RoomPage/WatchPage 包裹，
 * 组件保留与 ListenTogetherPanel 相同的"外层实例复用检测"（无外层时自建）。
 */
import { useContext, useEffect, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { useMusicStore } from '../store'
import { useMusicPlayer, MusicPlayerContext } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { ListenTogetherPanel } from './ListenTogetherPanel'
import { MusicTopNav } from './MusicTopNav'
import { MusicWidgetBar } from './MusicWidgetBar'
import { MusicQueuePopup } from './MusicQueuePopup'
import { MusicQrLoginModal } from './MusicQrLoginModal'
import { MusicHomePage } from '../pages/MusicHomePage'
import { MusicSearchPage } from '../pages/MusicSearchPage'
import { MusicDailyPage } from '../pages/MusicDailyPage'
import { MusicFmPage } from '../pages/MusicFmPage'
import { MusicMyPage } from '../pages/MusicMyPage'
import { MusicCloudPage } from '../pages/MusicCloudPage'
import { MusicSirenPage } from '../pages/MusicSirenPage'

export interface MusicAppShellProps {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  /** 队列管理权限（房主/房管），决定内容页添加按钮可见性 */
  canManage?: boolean
  /** 注入顶导航右侧的额外元素（如房间模式切换滑块/标签） */
  topNavExtra?: ReactNode
}

/** syncNotice 自动消失时长（毫秒，与 ListenTogetherPanel 一致） */
const SYNC_NOTICE_AUTO_DISMISS_MS = 5000

export function MusicAppShell({
  socket,
  roomId,
  isHost,
  username,
  canManage = false,
  topNavExtra,
}: MusicAppShellProps) {
  // 页面级集成：RoomPage/WatchPage 用 MusicPlayerProvider 包裹整个 RoomLayout，
  // shell 直接复用外层实例；独立使用时自建 Provider（避免双引擎）。
  const outerPlayer = useContext(MusicPlayerContext)
  if (outerPlayer) {
    return (
      <ShellInner
        socket={socket}
        roomId={roomId}
        isHost={isHost}
        username={username}
        canManage={canManage}
        topNavExtra={topNavExtra}
      />
    )
  }
  return (
    <MusicPlayerProvider
      socket={socket}
      roomId={roomId}
      isHost={isHost}
      username={username}
    >
      <ShellInner
        socket={socket}
        roomId={roomId}
        isHost={isHost}
        username={username}
        canManage={canManage}
        topNavExtra={topNavExtra}
      />
    </MusicPlayerProvider>
  )
}

function ShellInner({
  socket,
  roomId,
  isHost,
  username,
  canManage,
  topNavExtra,
}: {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  canManage: boolean
  topNavExtra?: ReactNode
}) {
  const page = useMusicStore((s) => s.page)
  const playerOverlayOpen = useMusicStore((s) => s.playerOverlayOpen)
  const queuePopupOpen = useMusicStore((s) => s.queuePopupOpen)
  const loginModalOpen = useMusicStore((s) => s.loginModalOpen)
  const setPlayerOverlayOpen = useMusicStore((s) => s.setPlayerOverlayOpen)
  const setLoginModalOpen = useMusicStore((s) => s.setLoginModalOpen)

  const {
    approveControl,
    rejectControl,
    canControl,
    hostOffline,
    syncNotice,
    setSyncNotice,
  } = useMusicPlayer()

  // syncNotice 5s 自动消失（shell 常驻提示；覆盖层内 ListenTogetherPanel
  // 亦有一份相同逻辑，行为一致）
  useEffect(() => {
    if (!syncNotice) return
    const timer = setTimeout(
      () => setSyncNotice(null),
      SYNC_NOTICE_AUTO_DISMISS_MS
    )
    return () => clearTimeout(timer)
  }, [syncNotice, setSyncNotice])

  /** 内容页共享 props（队列添加需要 socket/roomId/canManage） */
  const pageProps = { socket, roomId, canManage }

  return (
    <div className="glass-card zen-card relative flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* ===== 左上角提示区：房主离线 + syncNotice（含房主审批按钮） ===== */}
      <div className="pointer-events-none absolute left-4 top-4 z-[60] flex max-w-[calc(100%-2rem)] flex-col items-start gap-2">
        {hostOffline && !canControl && (
          <div
            className="pointer-events-auto flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-tertiary) 15%, transparent)',
              color: 'var(--md-sys-color-tertiary)',
            }}
          >
            房主已离开，您可以自主控制播放
          </div>
        )}
        {syncNotice && (
          <div
            className="pointer-events-auto flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
              color: 'var(--md-sys-color-on-surface)',
            }}
          >
            <span>{syncNotice}</span>
            {isHost && (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={approveControl}
                  className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                  title="通过申请"
                >
                  <Check className="h-3 w-3" />
                  通过
                </button>
                <button
                  type="button"
                  onClick={rejectControl}
                  className="flex h-5 items-center gap-0.5 rounded-full px-1.5 text-[11px] font-medium transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ color: 'var(--md-sys-color-error)' }}
                  title="拒绝申请"
                >
                  <X className="h-3 w-3" />
                  拒绝
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* ===== 顶部导航（topNavExtra：房间模式切换滑块/标签注入右侧） ===== */}
      <MusicTopNav isHost={isHost} modeSwitchSlot={topNavExtra} />

      {/* ===== 内容页（flex-1 滚动，多页切换） ===== */}
      <main className="zen-scroll min-h-0 flex-1 overflow-y-auto">
        {page === 'home' && <MusicHomePage {...pageProps} />}
        {page === 'search' && <MusicSearchPage {...pageProps} />}
        {page === 'daily' && <MusicDailyPage {...pageProps} />}
        {page === 'fm' && (
          <MusicFmPage socket={socket} roomId={roomId} canManage={canManage} />
        )}
        {page === 'mymusic' && <MusicMyPage {...pageProps} />}
        {page === 'cloud' && <MusicCloudPage {...pageProps} />}
        {page === 'siren' && <MusicSirenPage {...pageProps} />}
      </main>

      {/* ===== 底部固定条：widget + 队列弹窗 ===== */}
      <div className="relative shrink-0">
        <MusicWidgetBar />
        {queuePopupOpen && (
          <MusicQueuePopup
            socket={socket}
            roomId={roomId}
            isHost={isHost}
            canManage={canManage}
          />
        )}
      </div>

      {/* ===== 完整播放器覆盖层（ListenTogetherPanel 复用外层引擎） ===== */}
      {playerOverlayOpen && (
        <div className="zen-page-enter absolute inset-0 z-40">
          <ListenTogetherPanel
            socket={socket}
            roomId={roomId}
            isHost={isHost}
            username={username}
          />
          {/* 右上角收起按钮（回到应用主框架） */}
          <button
            type="button"
            className="absolute right-4 top-4 z-[70] flex h-9 w-9 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
            }}
            onClick={() => setPlayerOverlayOpen(false)}
            title="收起播放器"
            aria-label="收起播放器"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      )}

      {/* ===== 网易云扫码登录弹窗 ===== */}
      {loginModalOpen && (
        <MusicQrLoginModal onClose={() => setLoginModalOpen(false)} />
      )}
    </div>
  )
}
