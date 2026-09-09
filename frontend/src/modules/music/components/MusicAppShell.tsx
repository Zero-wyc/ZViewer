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
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/lib/utils'
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
import { useNcmLogin } from '../hooks/useNcmLogin'

export interface MusicAppShellProps {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  /** 队列管理权限（房主/房管），决定内容页添加按钮可见性 */
  canManage?: boolean
  /** 注入顶导航右侧的额外元素（如房间模式切换滑块/标签） */
  topNavExtra?: ReactNode
  /** 模式切换进行中：底板上渲染全屏加载占位 */
  isModeSwitching?: boolean
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
  isModeSwitching = false,
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
        isModeSwitching={isModeSwitching}
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
        isModeSwitching={isModeSwitching}
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
  isModeSwitching,
}: {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  canManage: boolean
  topNavExtra?: ReactNode
  isModeSwitching: boolean
}) {
  const page = useMusicStore((s) => s.page)
  const playerOverlayOpen = useMusicStore((s) => s.playerOverlayOpen)
  const playerOverlayClosing = useMusicStore((s) => s.playerOverlayClosing)
  const queuePopupOpen = useMusicStore((s) => s.queuePopupOpen)
  const loginModalOpen = useMusicStore((s) => s.loginModalOpen)
  const setLoginModalOpen = useMusicStore((s) => s.setLoginModalOpen)
  // 带滑出动画的覆盖层关闭（0.5s 滑出后卸载）
  const closePlayerOverlay = useMusicStore((s) => s.closePlayerOverlay)

  // 挂载时恢复网易云登录态：useNcmLogin 挂载即调 /api/music/login/status 并
  // 写入 useMusicStore。登录态是内存态（刷新即丢），而扫码弹窗（hook 的唯一
  // 挂载点）未打开前无人恢复——导致后端凭据明明存在（个人中心直查显示已登录），
  // 听页面账户菜单/登录门却显示未登录。壳层挂载即恢复，页面内容即可用。
  useNcmLogin()

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
    <div className="relative flex h-screen min-w-0 flex-col overflow-hidden">
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

      {/* ===== 顶部导航（模式切换滑块/标签注入右侧）。
          底板占满全屏（h-screen）：听模式下全局 Header 默认隐藏，顶栏位置
          由本导航填充；Header 经横条触发显示时以 fixed 悬浮覆盖，不推挤 ===== */}
      <MusicTopNav isHost={isHost} modeSwitchSlot={topNavExtra} />

      {/* ===== 内容页（flex-1 滚动，多页切换；底部让位给悬浮播放条） ===== */}
      <main className="zen-scroll min-h-0 flex-1 overflow-y-auto pb-[118px]">
        {page === 'home' && <MusicHomePage {...pageProps} />}
        {page === 'search' && <MusicSearchPage {...pageProps} />}
        {page === 'daily' && <MusicDailyPage {...pageProps} />}
        {page === 'fm' && (
          <MusicFmPage socket={socket} roomId={roomId} canManage={canManage} />
        )}
        {page === 'mymusic' && <MusicMyPage {...pageProps} />}
        {page === 'cloud' && <MusicCloudPage {...pageProps} />}
      </main>

      {/* ===== 底部悬浮播放条（Hydrogen .musicWidget 范式）：fixed 水平居中 +
          底距 35px + 定宽 722px，阴影托起悬浮感；脱离文档流后不再挤压内容页，
          队列弹窗仍相对本容器从播放条上方弹出。打开完整播放器时整条下滑消失
          （Hydrogen .widget-leave：bottom → -70px） ===== */}
      <div
        className={cn(
          'fixed left-1/2 z-30 w-[722px] max-w-[calc(100%-2rem)] -translate-x-1/2 transition-[bottom] duration-500 ease-[cubic-bezier(0.14,0.91,0.58,1)]',
          playerOverlayOpen ? 'bottom-[-70px]' : 'bottom-[35px]'
        )}
      >
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

      {/* ===== 完整播放器覆盖层（ListenTogetherPanel 复用外层引擎；
          整页从视口底部滑入 / 滑出，对应 Hydrogen .player 过渡） ===== */}
      {playerOverlayOpen && (
        <div
          className={
            playerOverlayClosing
              ? 'player-slide-out absolute inset-0 z-40'
              : 'player-slide-in absolute inset-0 z-40'
          }
        >
          <ListenTogetherPanel
            socket={socket}
            roomId={roomId}
            isHost={isHost}
            username={username}
            canManage={canManage}
          />
          {/* 右上角收起按钮（滑出动画结束后卸载） */}
          <button
            type="button"
            className="absolute right-4 top-4 z-[70] flex h-9 w-9 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-opacity hover:opacity-70 active:scale-90"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
            }}
            onClick={closePlayerOverlay}
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

      {/* ===== 模式切换加载占位：ack 确认前遮住整个底板（与 RoomLayout 主区域一致） ===== */}
      {isModeSwitching && (
        <div
          className="absolute inset-0 z-[90] flex items-center justify-center"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-surface) 80%, transparent)',
          }}
        >
          <Spinner tip="正在切换模式..." size={32} />
        </div>
      )}
    </div>
  )
}
