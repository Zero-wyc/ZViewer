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
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
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
import { useCliAgent } from '@/hooks/useCliAgent'
import { useMediaSessionSync } from '../hooks/useMediaSession'

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

  // ===== 播放器覆盖层右上角收起按钮：触摸显形（3s 后隐藏） =====
  // 触屏无 hover，原 lt-touch-visible 常显会让按钮常驻压在歌词首行上
  // （手机横屏歌词页占满时尤其明显）；桌面鼠标悬停右上角区域的
  // group-hover/hide 显形逻辑保留
  const [overlayCloseVisible, setOverlayCloseVisible] = useState(false)
  const overlayCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )
  const flashOverlayClose = useCallback(() => {
    setOverlayCloseVisible(true)
    if (overlayCloseTimerRef.current) clearTimeout(overlayCloseTimerRef.current)
    overlayCloseTimerRef.current = setTimeout(
      () => setOverlayCloseVisible(false),
      3000
    )
  }, [])
  useEffect(() => {
    return () => {
      if (overlayCloseTimerRef.current)
        clearTimeout(overlayCloseTimerRef.current)
    }
  }, [])

  // 挂载时恢复网易云登录态：useNcmLogin 挂载即调 /api/music/login/status 并
  // 写入 useMusicStore。登录态是内存态（刷新即丢），而扫码弹窗（hook 的唯一
  // 挂载点）未打开前无人恢复——导致后端凭据明明存在（个人中心直查显示已登录），
  // 听页面账户菜单/登录门却显示未登录。壳层挂载即恢复，页面内容即可用。
  useNcmLogin()

  // CLI 代理检测常驻壳层：cliAgentStore.agents 只由 useCliAgent 的 socket
  // 轮询填充，此前唯一挂载点是设置弹窗——刷新后没人轮询，代理列表恒为空，
  // CLI 高画质永不生效，必须开一次设置面板"重新开关"才恢复。壳层挂载即
  // 订阅（立即拉取 + 3s 轮询）；CLI 在服务器全局注册（不绑定房间），
  // 任意房间开启 CLI 功能即自动生效
  useCliAgent()

  // Media Session 接入（常驻壳层，provider 实例内唯一挂载点）：手机播放时
  // 歌曲/封面出现在系统状态栏（Android 通知栏、iOS 锁屏/控制中心），锁屏
  // 可播放/暂停/切歌/拖进度；后台播放由 <audio> 媒体元素天然支持（见
  // hooks/useMediaSession 注释）
  useMediaSessionSync()

  const {
    approveControl,
    rejectControl,
    canControl,
    hostOffline,
    syncNotice,
    syncNoticeKind,
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

  // 提示条退出动画：syncNotice 清除后保留最后文案 0.3s 播放上飘淡出，
  // 动画结束才真正卸载（此前直接闪现消失）。状态同步走 render 期调整
  //（react-hooks 禁止 effect 内同步 setState 与渲染期读 ref），
  // 卸载定时器走 effect
  const [noticeView, setNoticeView] = useState<{
    text: string
    kind: 'info' | 'approval'
  } | null>(null)
  const [noticeLeaving, setNoticeLeaving] = useState(false)
  if (syncNotice) {
    // 新提示到达（或内容变化）：展示并复位退出态
    if (
      noticeLeaving ||
      noticeView?.text !== syncNotice ||
      noticeView?.kind !== syncNoticeKind
    ) {
      setNoticeView({ text: syncNotice, kind: syncNoticeKind })
      setNoticeLeaving(false)
    }
  } else if (noticeView && !noticeLeaving) {
    // 提示清除：进入退出动画
    setNoticeLeaving(true)
  }
  useEffect(() => {
    if (!noticeLeaving) return
    const timer = setTimeout(() => {
      setNoticeLeaving(false)
      setNoticeView(null)
    }, 300)
    return () => clearTimeout(timer)
  }, [noticeLeaving])

  // 观众同步回执（左下角「xx 已同步」）：最新一条入列 TTL 后统一清理过期项
  const syncAcks = useMusicStore((s) => s.syncAcks)
  useEffect(() => {
    if (syncAcks.length === 0) return
    const timer = setTimeout(() => {
      useMusicStore.getState().pruneSyncAcks(SYNC_ACK_TTL_MS)
    }, SYNC_ACK_TTL_MS)
    return () => clearTimeout(timer)
  }, [syncAcks])

  // 同步回执退出动画：store 清理过期项后，消失的条目转入本地 leaving 列表
  // 再播 0.3s 上飘淡出（zen-notice-leave）后卸载——与左上角提示条行为一致
  const [leavingAcks, setLeavingAcks] = useState<
    Array<{ id: number; username: string }>
  >([])
  const prevAcksRef = useRef<Array<{ id: number; username: string }>>([])
  useEffect(() => {
    const prev = prevAcksRef.current
    prevAcksRef.current = syncAcks
    const present = new Set(syncAcks.map((a) => a.id))
    const gone = prev.filter((a) => !present.has(a.id))
    if (gone.length === 0) return
    setLeavingAcks((l) => [...l, ...gone])
    // 每批独立定时器（不随 effect 清理）：连续清理多批互不影响
    const goneIds = new Set(gone.map((a) => a.id))
    setTimeout(() => {
      setLeavingAcks((l) => l.filter((a) => !goneIds.has(a.id)))
    }, 300)
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
      style={
        {
          height: '100dvh',
          // 壁纸作用域文字色：音乐各页内容直接坐在壁纸/遮罩上，文字系
          // 变量引用 --lt-raw-*（按「原始背景」判定的 scheme 文字色，
          // ThemeProvider 注入）——深色模式亮壁纸下自动切深字；底部迷你条
          // 与播放器覆盖层有自己的玻璃作用域引用，不受此层影响
          '--md-sys-color-on-surface': 'var(--lt-raw-on-surface)',
          '--md-sys-color-on-surface-variant':
            'var(--lt-raw-on-surface-variant)',
          '--md-sys-color-outline': 'var(--lt-raw-outline)',
          '--md-sys-color-outline-variant': 'var(--lt-raw-outline-variant)',
        } as React.CSSProperties
      }
    >
      {/* ===== 左下角观众同步回执：观众完成切歌同步后回执，房主在此
          看到「xx 已同步」——浅色玻璃条 + 上滑入场/TTL 后上飘淡出
          （与左上角提示条同款动画 UI） ===== */}
      {(syncAcks.length > 0 || leavingAcks.length > 0) &&
        (() => {
          const leavingIds = new Set(leavingAcks.map((a) => a.id))
          const shown = [
            ...syncAcks.filter((a) => !leavingIds.has(a.id)),
            ...leavingAcks,
          ]
          return (
            <div className="pointer-events-none absolute bottom-2 left-3 z-[60] flex flex-col items-start gap-1.5">
              {shown.map((ack) => (
                <div
                  key={ack.id}
                  className={cn(
                    'zen-notice-bar flex items-center gap-1.5 rounded-[12px] px-3 py-1.5 text-[11px] font-medium',
                    leavingIds.has(ack.id)
                      ? 'zen-notice-leave'
                      : 'zen-notice-drop-in'
                  )}
                >
                  <Check
                    className="h-3 w-3 shrink-0"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                    strokeWidth={2.5}
                  />
                  {ack.username} 已同步
                </div>
              ))}
            </div>
          )
        })()}

      {/* ===== 左上角提示区：房主离线 + syncNotice（含房主审批按钮） ===== */}
      <div className="pointer-events-none absolute left-4 top-4 z-[60] flex max-w-[calc(100%-2rem)] flex-col items-start gap-2 max-md:left-3 max-md:top-3">
        {hostOffline && !canControl && (
          <div className="zen-notice-bar zen-stagger-fade-up pointer-events-auto flex items-center gap-2 rounded-[14px] px-3.5 py-2 text-xs font-medium">
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--md-sys-color-tertiary)] opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--md-sys-color-tertiary)]" />
            </span>
            房主已离开，您可以自主控制播放
          </div>
        )}
        {(syncNotice || noticeLeaving) && noticeView && (
          <div
            className={cn(
              'zen-notice-bar pointer-events-auto flex items-center gap-2.5 rounded-[14px] py-2 pl-3.5 pr-2 text-xs font-medium',
              // 退出动画期间替换入场动画类（上飘淡出后再卸载）
              noticeLeaving ? 'zen-notice-leave' : 'zen-notice-drop-in'
            )}
          >
            <span>{noticeView.text}</span>
            {/* 仅审批类提示（观众控制申请）渲染通过/拒绝按钮；
                纯状态提示（解析进度、结果回执等）不显示；
                退出动画期间 pendingControl 已定，不再渲染 */}
            {isHost && !noticeLeaving && noticeView.kind === 'approval' && (
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
          onPointerDown={flashOverlayClose}
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
          {/* 右上角收起按钮（滑出动画结束后卸载）：手机上默认完全隐藏
              （触摸屏幕任意处亮起 3s——触屏无 hover 且常显会压在歌词
              首行上），桌面保持 hover 区域显形；显形时带圆形毛玻璃底，
              横屏歌词页占满时也不显「错位悬浮字」 */}
          <div className="group/hide absolute right-3 top-3 z-[70] h-16 w-16 max-md:right-2 max-md:top-2">
            <button
              type="button"
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface)] transition-all duration-200 active:scale-90',
                overlayCloseVisible
                  ? 'pointer-events-auto opacity-100 shadow-sm backdrop-blur-md'
                  : 'pointer-events-none opacity-0 group-hover/hide:pointer-events-auto group-hover/hide:opacity-100',
                overlayCloseVisible &&
                  'bg-[color-mix(in_srgb,var(--md-sys-color-surface)_60%,transparent)]'
              )}
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
