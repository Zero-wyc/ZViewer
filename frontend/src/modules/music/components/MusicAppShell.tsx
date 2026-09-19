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
import { useContext, useEffect } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/lib/utils'
import { useMusicStore } from '../store'
import { useMusicPlayer, MusicPlayerContext } from '../hooks/useMusicPlayer'
import { MusicPlayerProvider } from '../MusicPlayerContext'
import { ListenTogetherPanel } from './ListenTogetherPanel'
import { MusicTopNav, type RoomModeMenuState } from './MusicTopNav'
import { MusicWidgetBar } from './MusicWidgetBar'
import { MusicQueuePopup } from './MusicQueuePopup'
import { MusicSideDock } from './MusicSideDock'
import { MusicQrLoginModal } from './MusicQrLoginModal'
import { MusicHomePage } from '../pages/MusicHomePage'
import { MusicBilibiliPage } from '../pages/MusicBilibiliPage'
import { MusicSearchPage } from '../pages/MusicSearchPage'
import { MusicFmPage } from '../pages/MusicFmPage'
import { MusicMyPage } from '../pages/MusicMyPage'
import { MusicCloudPage } from '../pages/MusicCloudPage'
import { MusicSettingsPage } from '../pages/MusicSettingsPage'
import { useNcmLogin } from '../hooks/useNcmLogin'

export interface MusicAppShellProps {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  /** 队列管理权限（房主/房管），决定内容页添加按钮可见性 */
  canManage?: boolean
  /** 账户菜单内的「房间模式」分组（房间内提供；独立音乐页不传则隐藏） */
  roomModeMenu?: RoomModeMenuState
  /** 模式切换进行中：底板上渲染全屏加载占位 */
  isModeSwitching?: boolean
}

/** syncNotice 自动消失时长（毫秒，与 ListenTogetherPanel 一致） */
const SYNC_NOTICE_AUTO_DISMISS_MS = 5000

/** 观众同步回执展示时长（毫秒）：超时后从左下角提示区移除 */
const SYNC_ACK_TTL_MS = 4000

export function MusicAppShell({
  socket,
  roomId,
  isHost,
  username,
  canManage = false,
  roomModeMenu,
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
        roomModeMenu={roomModeMenu}
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
        roomModeMenu={roomModeMenu}
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
  roomModeMenu,
  isModeSwitching,
}: {
  socket: Socket | null
  roomId: string
  isHost: boolean
  username?: string
  canManage: boolean
  roomModeMenu?: RoomModeMenuState
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

  // 观众同步回执（左下角「xx 已同步」）：最新一条入列 TTL 后统一清理过期项
  const syncAcks = useMusicStore((s) => s.syncAcks)
  useEffect(() => {
    if (syncAcks.length === 0) return
    const timer = setTimeout(() => {
      useMusicStore.getState().pruneSyncAcks(SYNC_ACK_TTL_MS)
    }, SYNC_ACK_TTL_MS)
    return () => clearTimeout(timer)
  }, [syncAcks])

  // 卸载/离开音乐页：重置播放状态（清队列/停播/对齐标记），保留登录态与
  // UI 状态（页面、覆盖层开关等）。引擎内部分配资源在 useListenTogether
  // 的卸载 effect 释放；store 仅走轻量 resetPlayback，不触发全量 reset
  //（后者由离开房间流程统一处理）。
  useEffect(() => {
    return () => {
      useMusicStore.getState().resetPlayback()
    }
  }, [])

  /** 内容页共享 props（队列添加需要 socket/roomId/canManage） */
  const pageProps = { socket, roomId, canManage }

  return (
    // 高度用 100dvh：移动浏览器地址栏收展时 h-screen(100vh) 会造成底部
    // 播放条被遮挡/跳动；不支持的旧浏览器声明无效，回退 h-screen 类
    <div
      className="relative flex h-screen min-w-0 flex-col overflow-hidden"
      style={{ height: '100dvh' }}
    >
      {/* ===== 左下角观众同步回执：观众完成切歌同步后回执，房主在此
          看到「xx 已同步」——刻意做得极浅（opacity 0.25）极小（10px），
          存在感弱不干扰主内容；每条淡入，4s 后自动消失 ===== */}
      {syncAcks.length > 0 && (
        <div className="pointer-events-none absolute bottom-2 left-3 z-[60] flex flex-col items-start gap-0.5">
          {syncAcks.map((ack) => (
            <span
              key={ack.id}
              className="zen-cover-fade text-[10px] font-medium leading-4"
              style={{
                color: 'var(--md-sys-color-on-surface)',
                opacity: 0.25,
              }}
            >
              {ack.username} 已同步
            </span>
          ))}
        </div>
      )}

      {/* ===== 左上角提示区：房主离线 + syncNotice（含房主审批按钮） ===== */}
      <div className="pointer-events-none absolute left-4 top-4 z-[60] flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 max-md:left-3 max-md:top-3">
        {hostOffline && !canControl && (
          <div
            className="zen-stagger-fade-up pointer-events-auto flex items-center gap-2 rounded-[14px] border px-3.5 py-2 text-xs font-medium shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
            style={{
              backgroundColor: 'rgba(8, 8, 8, 0.72)',
              backdropFilter: 'blur(28px)',
              WebkitBackdropFilter: 'blur(28px)',
              borderColor: 'rgba(255, 255, 255, 0.12)',
              color: 'rgba(255, 255, 255, 0.92)',
            }}
          >
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--md-sys-color-tertiary)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--md-sys-color-tertiary)]" />
            </span>
            房主已离开，您可以自主控制播放
          </div>
        )}
        {syncNotice && (
          <div
            className="zen-stagger-fade-up pointer-events-auto flex items-center gap-2.5 rounded-[14px] border py-2 pl-3.5 pr-2 text-xs font-medium shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
            style={{
              backgroundColor: 'rgba(8, 8, 8, 0.72)',
              backdropFilter: 'blur(28px)',
              WebkitBackdropFilter: 'blur(28px)',
              borderColor: 'rgba(255, 255, 255, 0.12)',
              color: 'rgba(255, 255, 255, 0.92)',
            }}
          >
            <span>{syncNotice}</span>
            {isHost && (
              <span className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={approveControl}
                  className="flex h-6 items-center gap-1 rounded-full px-2.5 text-[11px] font-bold text-[#111114] transition-all hover:opacity-85 active:scale-95"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.92)' }}
                  title="通过申请"
                >
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                  通过
                </button>
                <button
                  type="button"
                  onClick={rejectControl}
                  className="flex h-6 items-center gap-1 rounded-full border border-white/20 px-2.5 text-[11px] font-medium text-[#ff6b6b] transition-colors hover:border-white/35 hover:bg-white/10 active:scale-95"
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
      <MusicTopNav isHost={isHost} roomModeMenu={roomModeMenu} />

      {/* ===== 内容页（flex-1 滚动，多页切换；底部让位给悬浮播放条，
          手机端底距收窄并叠加 iOS 安全区） ===== */}
      <main className="zen-scroll min-h-0 flex-1 overflow-y-auto pb-[118px] max-md:pb-[calc(96px+env(safe-area-inset-bottom))]">
        {page === 'home' && <MusicHomePage {...pageProps} />}
        {page === 'search' && <MusicSearchPage {...pageProps} />}
        {page === 'fm' && (
          <MusicFmPage socket={socket} roomId={roomId} canManage={canManage} />
        )}
        {page === 'mymusic' && <MusicMyPage {...pageProps} />}
        {page === 'cloud' && <MusicCloudPage {...pageProps} />}
        {page === 'bilibili' && (
          <MusicBilibiliPage
            socket={socket}
            roomId={roomId}
            isHost={isHost}
            canManage={canManage}
          />
        )}
        {page === 'settings' && <MusicSettingsPage />}
      </main>

      {/* ===== 底部悬浮播放条（Hydrogen .musicWidget 范式）：fixed 水平居中 +
          底距 35px + 定宽 722px，阴影托起悬浮感；脱离文档流后不再挤压内容页，
          队列弹窗仍相对本容器从播放条上方弹出。打开完整播放器时整条下滑消失
          （Hydrogen .widget-leave：bottom → -70px） ===== */}
      <div
        className={cn(
          'fixed left-1/2 z-30 w-[722px] max-w-[calc(100%-2rem)] -translate-x-1/2 transition-[bottom] duration-500 ease-[cubic-bezier(0.14,0.91,0.58,1)]',
          // 手机端：底距收窄贴边 + iOS 安全区（原 35px 悬浮距小屏浪费空间）
          playerOverlayOpen
            ? 'bottom-[-70px]'
            : 'bottom-[35px] max-md:bottom-[calc(10px+env(safe-area-inset-bottom))]'
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

      {/* ===== 右侧悬浮工具坞（语音聊天 / 房间状态 / 流量统计）：默认仅显示
          一条右缘竖线，hover 滑出侧边栏（悬浮不挤压内容）；
          完整播放器覆盖层打开期间整坞卸载，保持沉浸 ===== */}
      {!playerOverlayOpen && !playerOverlayClosing && (
        <MusicSideDock
          socket={socket}
          roomId={roomId}
          username={username}
          isHost={isHost}
          canManage={canManage}
        />
      )}

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
          {/* 右上角收起按钮（滑出动画结束后卸载）：默认隐藏，
              鼠标移到其区域上方才显示（键盘聚焦/触屏设备常显——
              手机无 hover，若仅 hover 显形会导致覆盖层无法收起） */}
          <div className="group/hide absolute right-4 top-4 z-[70] h-16 w-16 max-md:right-3 max-md:top-3">
            <button
              type="button"
              className="lt-touch-visible flex h-9 w-9 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] opacity-0 transition-opacity group-focus-within/hide:opacity-100 group-hover/hide:opacity-100 active:scale-90"
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
