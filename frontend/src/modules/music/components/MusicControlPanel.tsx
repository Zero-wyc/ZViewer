/**
 * 一起听控制面板（悬浮球 + 展开卡片）。
 *
 * 一起听已从「房间模式」独立出来：屏幕共享 / 一起看房间里也能点歌听歌，
 * 因此原来只有 MusicAppShell 才有的控制入口改成语音聊天面板同款的
 * 右下角悬浮球。面板挂载在 MusicPlayerProvider 内，播放引擎与房间同步
 * 由 useListenTogether 提供（房主是同步源，观众按服务器基线播放）。
 *
 * - 全屏：portal 到 FullscreenOverlayStore 注册的舞台元素，随控制栏显隐
 *   （原生全屏只渲染 fullscreen 元素子树，fixed 到 body 会被吞掉）
 * - 音量 / 收听：均为本地状态（音量持久化 zc-music-volume，收听持久化
 *   zc-music-listening），互不影响，不参与房间同步
 * - 点歌权限：房主在面板内开关「允许成员点歌」并按人白/黑名单；普通成员
 *   能点歌时直接 upsert，不能时退回 control-request 申请（房主审批）
 * - 账号：网易云 / B站 都是「房间共享账号」——任意成员在房间内登录后，
 *   服务端把凭证绑定到房间，房间内其他人直接复用（搜索/歌单/解析都在服务端，
 *   前端只播直链，避免多设备登录被风控）；面板显示当前用的是谁的账号
 */
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Socket } from 'socket.io-client'
import {
  ChevronDown,
  ChevronRight,
  Headphones,
  ListMusic,
  LogOut,
  Music,
  Pause,
  Play,
  Plus,
  QrCode,
  SkipBack,
  SkipForward,
  Trash2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useFullscreenOverlayStore } from '@/store/fullscreenOverlayStore'
import { useMusicPanelStore } from '@/store/musicPanelStore'
import { useIsPortraitMobile } from '@/hooks/useMediaQuery'
import { useRoomStore } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import {
  useSystemSettingsStore,
  canRoomViewerPerform,
} from '@/store/systemSettingsStore'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import { musicItemKey, useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import {
  canRequestMusic,
  memberCanRequestMusic,
} from '../utils/musicPermission'
import { MusicQueueSearchModal } from './MusicQueueSearchModal'
import { MusicQueueWindow } from './MusicQueueWindow'
import { MusicQrLoginModal } from './MusicQrLoginModal'
import { useBilibiliQrLogin } from '@/modules/bilibili/useBilibiliQrLogin'
import { useRoomAccounts } from '@/modules/room/hooks/useRoomAccounts'
import type { RoomAccountInfo } from '@/modules/room/hooks/useRoomAccounts'
import type { MusicPermissionUpdate, MusicQueueItem } from '../types'

export interface MusicControlPanelProps {
  socket: Socket | null
  roomId: string | undefined
  username?: string
  isHost: boolean
}

/** 队列条目 → playItem 申请 / 播放载荷（与 MusicControlRequest.item 同构） */
function toItemPayload(item: MusicQueueItem) {
  return {
    songId: item.songId,
    name: item.name,
    artist: item.artist,
    album: item.album,
    cover: item.cover,
    durationMs: item.durationMs,
    vip: item.vip,
    biliBvid: item.biliBvid,
    biliCid: item.biliCid,
  }
}

/** 秒数 → m:ss */
function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0:00'
  const total = Math.floor(sec)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function MusicControlPanel({
  socket,
  roomId,
  isHost,
}: MusicControlPanelProps) {
  const expanded = useMusicPanelStore((s) => s.expandedRoomId === roomId)
  // 房主可关闭本房间的一起听功能：关闭后成员端不渲染任何入口，
  // 本地播放器也立刻暂停（服务端同时会拒绝队列/同步事件）。
  const musicEnabled = useRoomStore((s) => s.roomFeatures.musicEnabled)
  const setExpanded = useMusicPanelStore((s) => s.setExpanded)
  const searchOpen = useMusicPanelStore((s) => s.searchOpen)
  const setSearchOpen = useMusicPanelStore((s) => s.setSearchOpen)
  const queueOpen = useMusicPanelStore((s) => s.queueOpen)
  const setQueueOpen = useMusicPanelStore((s) => s.setQueueOpen)
  // 手机竖屏：队列大列表改用居中大弹窗（此时先收起控制面板）
  const portraitMobile = useIsPortraitMobile()

  // 语音聊天浮球与音乐浮球都在右下角：语音开启时音乐上移一档，
  // 避免两个 48px 圆形浮球完全重叠（实测重叠时只能点到上面那个）。
  const voiceDockVisible = useSystemSettingsStore(
    (s) => s.showVoiceChatButton
  )

  // 全屏浮层宿主（与语音面板同一套机制）
  const overlayTarget = useFullscreenOverlayStore((s) => s.target)
  const overlayBarVisible = useFullscreenOverlayStore((s) => s.controlBarVisible)
  // 宿主实测的控制栏高度（px）：控制栏在窄屏会因按钮换行变高，浮层必须
  // 按实测值抬升，静态偏移会被盖住（语音浮球已踩过这个坑）。
  const overlayBarHeight = useFullscreenOverlayStore((s) => s.controlBarHeight)
  // 全屏分屏评论区占位：横屏分屏时音乐浮层整体左移，竖屏分屏时上移，
  // 始终贴住画面边框（用户报「评论区将语音和一起听悬浮按钮挤开」）。
  const commentPaneOrientation = useFullscreenOverlayStore(
    (s) => s.commentPaneOrientation
  )
  const commentPaneSize = useFullscreenOverlayStore((s) => s.commentPaneSize)
  const [portalHost] = useState(() => {
    const el = document.createElement('div')
    el.style.display = 'contents'
    return el
  })

  // 一键清空队列的二次确认（4 秒内不确认自动复位，避免误触清空）
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    const parent = overlayTarget ?? document.body
    parent.appendChild(portalHost)
    return () => {
      portalHost.remove()
    }
  }, [overlayTarget, portalHost])

  // 浮层是否接管（播放器自身全屏/播放器网页全屏）。注意「网页全屏」按钮
  // 全屏的是 documentElement，宿主不会注册（见 isElementFullscreen），
  // 此时浮层仍留在 body 上，不会"跳进"播放器。
  const overlayActive = overlayTarget != null

  // 弹窗（扫码登录 / 点歌）必须与浮层挂到同一个宿主：原生全屏时浏览器只
  // 渲染全屏元素的子树，portal 到 body 的弹窗看不到。
  const modalHost = overlayActive ? portalHost : null

  const {
    isPlaying,
    currentSong,
    canControl,
    togglePlay,
    next,
    prev,
    playSong,
    requestControl,
    volume,
    setVolume,
    listening,
    setListening,
    getAudio,
    syncNotice,
    syncNoticeKind,
    approveControl,
    rejectControl,
  } = useMusicPlayer()
  // 一起听被房主关闭：停播 + 收起面板与弹窗
  useEffect(() => {
    if (musicEnabled) return
    getAudio()?.pause()
    setListening(false)
    setSearchOpen(false)
    setQueueOpen(false)
    setExpanded(roomId, false)
  }, [
    musicEnabled,
    getAudio,
    setListening,
    setSearchOpen,
    setQueueOpen,
    setExpanded,
    roomId,
  ])

  const queue = useMusicStore((s) => s.queue)
  const currentKey = useMusicStore((s) => s.currentKey)
  const permission = useMusicStore((s) => s.permission)
  const viewers = useRoomStore((s) => s.viewers)
  const moderators = useRoomStore((s) => s.moderators)
  const guestModerators = useRoomStore((s) => s.guestModerators)
  const user = useAuthStore((s) => s.user)
  const matrix = useSystemSettingsStore((s) => s.roomPermissionMatrix)

  const currentUserId = user ? Number(user.id) : 0
  const isModerator =
    (currentUserId > 0 && moderators.includes(currentUserId)) ||
    (!!socket?.id && guestModerators.includes(socket.id))
  const canManageQueue = canRoomViewerPerform(matrix, 'musicQueue', {
    isHost,
    isModerator,
    role: user?.role,
  })
  // 能否点歌：房主/房管/矩阵允许者 → 是；其余按房间点歌权限判定
  const canRequest = canRequestMusic(permission, {
    isHost,
    isModerator,
    canManageQueue,
    userId: currentUserId > 0 ? currentUserId : undefined,
  })

  // 房主：修改点歌权限（总开关或单用户）
  const emitPermission = (patch: Omit<MusicPermissionUpdate, 'roomId'>) => {
    if (!socket || !roomId) {
      message.error(t('未连接房间'))
      return
    }
    socket.emit(
      'music:update-permission',
      { roomId, ...patch },
      (response: { success?: boolean; message?: string }) => {
        if (response && response.success === false) {
          message.error(response.message || t('更新点歌权限失败'))
        }
      }
    )
  }

  // 队列删除：与点歌同一套权限（后端统一按 CanRequestMusic 校验），
  // 被允许点歌的成员也能删掉加错的歌曲。
  const handleRemove = (itemId: number) => {
    if (!socket || !roomId) {
      message.error(t('未连接房间'))
      return
    }
    socket.emit(
      'music:queue-remove',
      { roomId, id: itemId },
      (response: { success?: boolean; message?: string }) => {
        if (response && response.success === false) {
          message.error(response.message || t('删除歌曲失败'))
        }
      }
    )
  }

  // 一键清空队列（同样按点歌权限放行；二次确认后执行）
  const handleClear = () => {
    if (!socket || !roomId) {
      message.error(t('未连接房间'))
      setConfirmClear(false)
      return
    }
    socket.emit(
      'music:queue-clear',
      { roomId },
      (response: { success?: boolean; message?: string }) => {
        setConfirmClear(false)
        if (response && response.success === false) {
          message.error(response.message || t('清空队列失败'))
        }
      }
    )
  }

  useEffect(() => {
    if (!confirmClear) return undefined
    const timer = window.setTimeout(() => setConfirmClear(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirmClear])

  // 队列大列表开关：竖屏下先收起控制面板，只留居中大弹窗（面板太矮，
  // 两个浮层同时开着会互相挤）；关闭大列表后把面板重新展开。
  const openQueueWindow = () => {
    if (portraitMobile) setExpanded(roomId ?? '', false)
    setQueueOpen(true)
  }

  const closeQueueWindow = () => {
    setQueueOpen(false)
    if (portraitMobile) setExpanded(roomId ?? '', true)
  }

  // 操作面板外部（点舞台、点顶栏、点别处）直接收起面板。
  // 「播放队列大列表」「点歌 / 扫码弹窗」都是从面板点开的二级界面，算内部，
  // 点它们不能把面板关掉——统一用 data-music-ui 标记，命中即忽略。
  // 用捕获阶段：舞台 / 播放器会在冒泡阶段 stopPropagation，冒泡阶段收不到。
  useEffect(() => {
    if (!expanded) return undefined
    const onPointerDown = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('[data-music-ui]')) return
      setQueueOpen(false)
      setExpanded(roomId ?? '', false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () =>
      document.removeEventListener('pointerdown', onPointerDown, true)
  }, [expanded, roomId, setExpanded, setQueueOpen])

  const handlePlayItem = (item: MusicQueueItem) => {
    if (canControl) {
      playSong(item)
      return
    }
    requestControl('playItem', undefined, toItemPayload(item))
  }

  // ── 账号：房间共享账号（网易云 / B站）──
  // 任意成员在房间内登录后，账号会绑定给整个房间使用：搜索/歌单/解析全部在
  // 服务端用同一份凭证完成，前端只播直链，避免多设备登录导致账号被风控。
  const {
    accounts: roomAccounts,
    refresh: refreshRoomAccounts,
    logout: logoutRoomAccount,
  } = useRoomAccounts(socket, roomId)
  const ncmAccount = roomAccounts.ncm
  const biliAccount = roomAccounts.bilibili
  const [ncmModalOpen, setNcmModalOpen] = useState(false)
  const {
    qrModalOpen: biliQrOpen,
    qrDataUrl: biliQrDataUrl,
    qrStatus: biliQrStatus,
    qrMessage: biliQrMessage,
    handleOpenQrModal,
    handleCloseQrModal,
  } = useBilibiliQrLogin({
    onLoginSuccess: () => {
      void refreshRoomAccounts()
    },
    onLogoutSuccess: () => void refreshRoomAccounts(),
  })

  // 退出房间共享账号：只解绑房间，不影响登录者的个人凭证。
  const handleRoomAccountLogout = async (provider: 'ncm' | 'bilibili') => {
    const ok = await logoutRoomAccount(provider)
    if (!ok) message.error(t('退出账号失败'))
  }

  // 「谁在用这个账号」：房间绑定 > 房主回退 > 仅本人
  const accountScopeText = (account: RoomAccountInfo | undefined): string => {
    if (!account?.loggedIn) return ''
    if (account.source === 'room') {
      return t('由 {{name}} 登录 · 全房间共用', {
        name: account.binderName || t('成员'),
      })
    }
    if (account.source === 'owner') return t('房主账号 · 全房间共用')
    if (account.source === 'self') return t('仅我的账号')
    return ''
  }

  const accountName = (account: RoomAccountInfo | undefined): string =>
    account?.loggedIn ? account.nickname || t('已登录') : t('未登录')

  // 房主视角：可单独授权的成员（游客无 user id，只受总开关控制）
  const memberViewers = useMemo(
    () =>
      viewers.filter(
        (v) =>
          typeof v.userId === 'number' &&
          Number.isFinite(v.userId) &&
          v.userId > 0 &&
          v.socketId !== socket?.id
      ),
    [viewers, socket]
  )

  const hasQueue = queue.length > 0
  const busy = socket == null

  // 悬浮卡片 / 队列大列表共用的高度上限。
  // 非全屏时页面顶栏是 fixed top-0 z-50、实测高 4rem，而浮层在它下面（z 更低），
  // 所以高度上限必须把顶栏一起扣掉：否则卡片顶边会钻到顶栏底下，手机横屏等矮视口下
  // 顶部「收起」按钮被顶栏盖住、点不中，表现为弹窗关不掉（用户报的横屏问题）。
  // 语音浮球占位时浮层上移一档（bottom-6 → bottom-24），可用高度相应再少 4.5rem。
  // 全屏浮层内没有页面顶栏，沿用原来的值。
  const cardMaxHeightClass = overlayActive
    ? voiceDockVisible
      ? 'max-h-[calc(100dvh-12rem)]' // 声浮球占位 + 抬到控制栏上方的保守值
      : 'max-h-[calc(100dvh-8rem)]' // 抬到全屏控制栏上方的保守值
    : voiceDockVisible
      ? 'max-h-[calc(100dvh-11rem)]' // 96(底) + 64(顶栏) + 16(间距)
      : 'max-h-[calc(100dvh-6.5rem)]' // 24(底) + 64(顶栏) + 16(间距)

  const card = (
    <div
      className={cn(
        'glass-card flex w-72 flex-col gap-2 overflow-y-auto overscroll-contain p-3',
        // 悬浮卡片贴着右下角、底对齐：手机横屏等矮视口下内容比屏幕高，
        // 原来 overflow-hidden 会把「点歌」「收起」等顶部按钮顶出屏幕且无法滚动
        // （横屏下点不到点歌）。这里按视口高度限高并允许卡片内部滚动。
        // 语音浮球占位时卡片上移一档（bottom-24），可用高度相应少 4.5rem。
        cardMaxHeightClass
      )}
      style={
        overlayActive
          ? {
              // 竖屏上下分屏时浮层整体上移，可用高度要按实测落点重算，
              // 否则卡片顶部会顶出视口（顶部按钮点不到）。
              maxHeight: `calc(100dvh - ${
                overlayDockBottom(
                  overlayBarHeight,
                  voiceDockVisible,
                  commentPaneOrientation === 'stacked' ? commentPaneSize : 0
                ) + 16
              }px)`,
            }
          : undefined
      }
    >
      {/* 播放中 */}
      <SectionHeader
        icon={<Music className="h-4 w-4" />}
        title={t('一起听')}
        subtitle={
          currentSong
            ? currentSong.name
            : hasQueue
              ? t('等待播放')
              : t('队列为空，点歌吧')
        }
        extra={
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            onClick={() => {
              // 收起面板时一并关掉大列表（二级页面跟着一级入口走）
              setQueueOpen(false)
              setExpanded(roomId ?? '', false)
            }}
            aria-label={t('收起')}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        }
      />

      {/* 房主审批条 / 观众申请反馈：观众点播放、暂停、切歌时向房主申请，
          房主被「点歌权限」放行的申请已由引擎免审批执行，只有受限成员会落到这里 */}
      {syncNotice && (
        <div className="flex items-center gap-2 rounded-lg bg-black/5 px-2 py-1.5 text-[11px] leading-snug">
          <span className="min-w-0 flex-1">{syncNotice}</span>
          {isHost && syncNoticeKind === 'approval' && (
            <span className="flex shrink-0 items-center gap-1">
              <Button
                size="sm"
                variant="primary"
                className="h-6 px-2 text-[11px]"
                onClick={approveControl}
                title={t('通过申请')}
              >
                {t('通过')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={rejectControl}
                title={t('拒绝申请')}
              >
                {t('拒绝')}
              </Button>
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        {currentSong?.cover ? (
          <img
            src={currentSong.cover}
            alt=""
            className="h-10 w-10 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-black/10">
            <Headphones className="h-4 w-4 opacity-50" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {currentSong?.name ?? t('暂无播放')}
          </div>
          <div className="truncate text-[11px] opacity-60">
            {currentSong?.artist ?? ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={busy}
            onClick={() => prev()}
            aria-label={t('上一首')}
          >
            <SkipBack className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            disabled={busy}
            onClick={() => togglePlay()}
            aria-label={isPlaying ? t('暂停') : t('播放')}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            disabled={busy}
            onClick={() => next()}
            aria-label={t('下一首')}
          >
            <SkipForward className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* 本地音量 + 收听开关（每人独立） */}
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 shrink-0 p-0"
          onClick={() => setVolume(volume > 0 ? 0 : 0.6)}
          aria-label={volume > 0 ? t('静音') : t('取消静音')}
        >
          {volume > 0 ? (
            <Volume2 className="h-3.5 w-3.5" />
          ) : (
            <VolumeX className="h-3.5 w-3.5" />
          )}
        </Button>
        <Slider
          size="sm"
          className="flex-1"
          min={0}
          max={100}
          step={1}
          value={Math.round(volume * 100)}
          showValue={false}
          onChange={(v) => setVolume(v / 100)}
          aria-label={t('音量')}
        />
        <span className="w-7 shrink-0 text-right text-[11px] tabular-nums opacity-60">
          {Math.round(volume * 100)}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <Text className="text-[11px] opacity-70">{t('收听（仅本机）')}</Text>
        <Switch
          aria-label={t('收听（仅本机）')}
          checked={listening}
          onChange={(e) => setListening(e.target.checked)}
        />
      </div>

      {/* 队列 */}
      <div className="mt-1 flex items-center justify-between">
        {/* 队列行 = 大列表入口：横屏 / 竖屏都点开独立列表（面板里的小列表
            在全屏时被移除，入口保持始终可达） */}
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 text-[11px] opacity-70 transition hover:opacity-100"
          onClick={openQueueWindow}
          title={t('播放队列')}
          aria-label={t('播放队列')}
        >
          <ListMusic className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t('播放队列')}</span>
          <span className="shrink-0 tabular-nums">({queue.length})</span>
          <ChevronRight className="h-3 w-3 shrink-0" />
        </button>
        <div className="flex items-center gap-1">
          {canRequest && queue.length > 0 && (
            <Button
              size="sm"
              variant={confirmClear ? 'danger' : 'ghost'}
              className="h-6 px-2 text-[11px]"
              onClick={() => {
                if (confirmClear) {
                  handleClear()
                  return
                }
                setConfirmClear(true)
              }}
            >
              <Trash2 className="mr-0.5 h-3 w-3" />
              {confirmClear ? t('确认清空？') : t('清空队列')}
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            className="h-6 px-2 text-[11px]"
            disabled={!canRequest || !roomId}
            onClick={() => setSearchOpen(true)}
          >
            <Plus className="mr-0.5 h-3 w-3" />
            {t('点歌')}
          </Button>
        </div>
      </div>
      {!canRequest && (
        <div className="text-[11px] opacity-60">{t('房主未允许你点歌，可向房主申请')}</div>
      )}
      {/* 小队列列表：非全屏保留（面板内快速预览）；全屏浮层里空间给视频，
          只保留上面的队列行入口，点开左侧大列表 */}
      {!overlayActive && (
        <div className="max-h-40 overflow-y-auto rounded-lg">
          {queue.length === 0 ? (
            <div className="py-4 text-center text-[11px] opacity-50">
              {t('队列为空')}
            </div>
          ) : (
            queue.map((item) => {
              const key = musicItemKey(item)
              const active = key === currentKey
              return (
                <div
                  key={item.id}
                  className={cn(
                    'group flex items-center gap-1.5 rounded-md px-1.5 py-1',
                    active ? 'bg-black/10' : 'hover:bg-black/5'
                  )}
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => handlePlayItem(item)}
                  >
                    <div
                      className={cn(
                        'truncate text-[11px]',
                        active && 'font-medium text-[var(--md-sys-color-primary)]'
                      )}
                    >
                      {item.name}
                    </div>
                    <div className="truncate text-[10px] opacity-50">
                      {item.artist}
                      {item.durationMs > 0
                        ? ` · ${formatDuration(item.durationMs / 1000)}`
                        : ''}
                    </div>
                  </button>
                  {(canRequest || canManageQueue) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 shrink-0 p-0 opacity-60 hover:opacity-100"
                      onClick={() => handleRemove(item.id)}
                      aria-label={t('从队列移除')}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {/* 房主：点歌权限 */}
      {isHost && (
        <div className="mt-1 border-t pt-2"
          style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
        >
          <PermissionSection
            permission={permission}
            members={memberViewers}
            onChange={emitPermission}
          />
        </div>
      )}

      {/* 账号：房间共享账号（网易云 / B站） */}
      <div className="mt-1 space-y-1.5 border-t pt-2"
        style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
      >
        <div className="text-[10px] opacity-50">
          {t('房间共享账号：成员登录后全房间共用')}
        </div>
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <div className="text-[11px] font-medium">{t('网易云账号')}</div>
            <div className="truncate text-[10px] opacity-60">
              {accountName(ncmAccount)}
            </div>
            <div className="truncate text-[10px] opacity-40">
              {accountScopeText(ncmAccount)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {ncmAccount?.loggedIn && ncmAccount.source === 'room' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => void handleRoomAccountLogout('ncm')}
              >
                <LogOut className="mr-0.5 h-3 w-3" />
                {t('退出')}
              </Button>
            )}
            <Button
              size="sm"
              variant={ncmAccount?.loggedIn ? 'ghost' : 'secondary'}
              className="h-6 px-2 text-[11px]"
              onClick={() => setNcmModalOpen(true)}
            >
              <QrCode className="mr-0.5 h-3 w-3" />
              {ncmAccount?.loggedIn ? t('切换') : t('扫码登录')}
            </Button>
          </div>
        </div>
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0">
            <div className="text-[11px] font-medium">{t('B站账号')}</div>
            <div className="truncate text-[10px] opacity-60">
              {accountName(biliAccount)}
            </div>
            <div className="truncate text-[10px] opacity-40">
              {accountScopeText(biliAccount)}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {biliAccount?.loggedIn && biliAccount.source === 'room' && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => void handleRoomAccountLogout('bilibili')}
              >
                <LogOut className="mr-0.5 h-3 w-3" />
                {t('退出')}
              </Button>
            )}
            <Button
              size="sm"
              variant={biliAccount?.loggedIn ? 'ghost' : 'secondary'}
              className="h-6 px-2 text-[11px]"
              onClick={() => void handleOpenQrModal()}
            >
              <QrCode className="mr-0.5 h-3 w-3" />
              {biliAccount?.loggedIn ? t('切换') : t('扫码登录')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )

  const panel = (
    <>
      <div className={cn(expanded ? '' : 'hidden')}>{card}</div>
      {!expanded && (
        <button
          type="button"
          onClick={() => setExpanded(roomId ?? '', true)}
          className={cn(
            'glass-card relative flex h-12 w-12 items-center justify-center rounded-full',
            'transition-transform hover:scale-105'
          )}
          aria-label={t('一起听')}
          title={t('一起听')}
        >
          <Music className="h-5 w-5" />
          {(isPlaying || hasQueue) && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--md-sys-color-primary)] px-1 text-[9px] font-medium text-[var(--md-sys-color-on-primary)]">
              {isPlaying ? '♪' : queue.length}
            </span>
          )}
        </button>
      )}
    </>
  )

  // 一次性收口：所有 hook 已执行完，关闭一起听时不再渲染任何入口
  if (!musicEnabled) return null

  return (
    <>
      {createPortal(
        <div
          data-music-ui="panel"
          className={cn(
            dockClass(overlayActive, voiceDockVisible),
            overlayActive && !overlayBarVisible
              ? 'pointer-events-none opacity-0'
              : ''
          )}
          style={
            overlayActive
              ? {
                  bottom: overlayDockBottom(
                    overlayBarHeight,
                    voiceDockVisible,
                    commentPaneOrientation === 'stacked' ? commentPaneSize : 0
                  ),
                  ...(sidePaneWidth(commentPaneOrientation, commentPaneSize) > 0
                    ? {
                        right:
                          sidePaneWidth(
                            commentPaneOrientation,
                            commentPaneSize
                          ) + 24,
                      }
                    : null),
                }
              : undefined
          }
        >
          {panel}
        </div>,
        portalHost
      )}

      {/* 队列大列表：横屏 / 宽屏贴在控制面板左侧并排（全屏与非全屏都适用）；
          竖屏手机先收起面板，只留居中大弹窗 */}
      {queueOpen &&
        expanded &&
        !portraitMobile &&
        createPortal(
          <div
            data-music-ui="queue"
            className={cn(
              queueDockClass(overlayActive, voiceDockVisible),
              overlayActive && !overlayBarVisible
                ? 'pointer-events-none opacity-0'
                : ''
            )}
            style={
              overlayActive
                ? {
                    bottom: overlayDockBottom(
                      overlayBarHeight,
                      voiceDockVisible,
                      commentPaneOrientation === 'stacked'
                        ? commentPaneSize
                        : 0
                    ),
                    // 队列大列表平时贴在控制面板左侧（面板 18rem + 0.75rem 间距
                    // ⇒ 324px），横屏分屏时整组一起左移评论区宽度。
                    ...(sidePaneWidth(commentPaneOrientation, commentPaneSize) >
                    0
                      ? {
                          right:
                            sidePaneWidth(
                              commentPaneOrientation,
                              commentPaneSize
                            ) + 324,
                        }
                      : null),
                  }
                : undefined
            }
          >
            <MusicQueueWindow
              queue={queue}
              currentKey={currentKey}
              isPlaying={isPlaying}
              canRequest={canRequest}
              canRemove={canRequest || canManageQueue}
              layout="side"
              onPlay={handlePlayItem}
              onRemove={handleRemove}
              onClear={handleClear}
              onOpenSearch={() => setSearchOpen(true)}
              onClose={closeQueueWindow}
              maxHeightClass={cardMaxHeightClass}
            />
          </div>,
          portalHost
        )}

      {queueOpen && portraitMobile && (
        <MusicQueueWindow
          queue={queue}
          currentKey={currentKey}
          isPlaying={isPlaying}
          canRequest={canRequest}
          canRemove={canRequest || canManageQueue}
          layout="dialog"
          onPlay={handlePlayItem}
          onRemove={handleRemove}
          onClear={handleClear}
          onOpenSearch={() => setSearchOpen(true)}
          onClose={closeQueueWindow}
          maxHeightClass={cardMaxHeightClass}
          container={modalHost}
        />
      )}

      {searchOpen && (
        <MusicQueueSearchModal
          socket={socket}
          roomId={roomId}
          onClose={() => setSearchOpen(false)}
          container={modalHost}
        />
      )}

      {ncmModalOpen && (
        <MusicQrLoginModal
          container={modalHost}
          onClose={() => {
            setNcmModalOpen(false)
            // 登录成功后账号已绑定到房间，刷新一次房间共享账号状态
            void refreshRoomAccounts()
          }}
        />
      )}

      {/* B站 扫码弹窗（全屏遮罩，登录成功由 hook 自动关闭） */}
      {biliQrOpen &&
        createPortal(
          <div
            data-music-ui="modal"
            className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
            onClick={() => handleCloseQrModal()}
          >
            <div
              className="glass-strong flex w-72 flex-col items-center gap-3 rounded-2xl p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <Text className="text-sm font-semibold">{t('扫码登录 B站')}</Text>
              {biliQrDataUrl ? (
                <img
                  src={biliQrDataUrl}
                  alt={t('B站 登录二维码')}
                  className="h-[200px] w-[200px] rounded-lg"
                />
              ) : (
                <div className="flex h-[200px] w-[200px] items-center justify-center rounded-lg bg-black/5">
                  {biliQrStatus === 3 ? (
                    <span className="p-3 text-center text-xs opacity-70">
                      {biliQrMessage}
                    </span>
                  ) : (
                    <Spinner size={24} tip={t('正在获取二维码')} />
                  )}
                </div>
              )}
              <Text className="text-center text-xs opacity-70">
                {biliQrMessage}
              </Text>
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={() => handleCloseQrModal()}
              >
                {t('关闭')}
              </Button>
            </div>
          </div>,
          modalHost ?? document.body
        )}
    </>
  )
}

/**
 * 全屏浮层里的纵向落点（px）。
 *
 * 播放器控制栏是 full-width 的 absolute bottom-0 z-[80]，浮层若照旧贴 bottom-6
 * 会被它整块盖住（语音浮球用户已报过同一问题）。控制栏高度不固定：窄屏按钮
 * 换行时整条可达 ~110px，静态偏移挡不住，所以用宿主实测高度 + 8px 间距；
 * 语音浮球占位时再让出 48px 球 + 12px 间距。
 */
function overlayDockBottom(
  controlBarHeight: number,
  voiceDockVisible: boolean,
  stackedPaneHeight = 0
): number {
  // 尚未测到（控制栏还没渲染）时按桌面常见值兜底；竖屏上下分屏时控制栏在
  // 画面内部底边，浮层还要再让出评论区高度。
  return (
    (controlBarHeight || 88) +
    8 +
    (voiceDockVisible ? 60 : 0) +
    Math.max(0, stackedPaneHeight)
  )
}

/** 横屏左右分屏时评论区占的宽度（px）：0 表示没开分屏 */
function sidePaneWidth(
  orientation: 'side' | 'stacked' | null,
  size: number
): number {
  return orientation === 'side' ? Math.max(0, size) : 0
}

/**
 * 悬浮容器定位：全屏舞台内 absolute，普通页面 fixed 到右下角。
 * 语音聊天浮球固定在 bottom-6 right-6（全屏时抬到控制栏上方），占位时音乐
 * 浮球上移一档避免重叠。
 */
function dockClass(inOverlay: boolean, voiceDockVisible: boolean): string {
  const offsetY = voiceDockVisible ? 'bottom-24' : 'bottom-6'
  return cn(
    'flex flex-col items-end gap-3',
    inOverlay
      ? // 纵向落点由 overlayDockBottom 以内联 style 给出（按实测控制栏高度）
        'absolute right-6 z-30'
      // 非全屏页面浮在顶栏（z-50）之上：配合 cardMaxHeightClass 扣掉顶栏高度，
      // 双保险——万一某档视口算出的高度仍有重叠，面板也不会被顶栏盖住点不动。
      : `fixed ${offsetY} right-6 z-[60]`
  )
}

/**
 * 队列大列表的悬浮定位：贴在控制面板左侧并排。
 * 面板是 right-6（1.5rem）+ w-72（18rem），再加 0.75rem 间距 ⇒ 右边距 20.25rem，
 * 两个浮层底边对齐；纵向偏移与面板同一档（语音浮球占位时一起上移）。
 */
function queueDockClass(inOverlay: boolean, voiceDockVisible: boolean): string {
  const offsetY = voiceDockVisible ? 'bottom-24' : 'bottom-6'
  return cn(
    'flex flex-col items-stretch',
    inOverlay
      ? 'absolute right-[20.25rem] z-40'
      : `fixed ${offsetY} right-[20.25rem] z-[60]`
  )
}

interface PermissionSectionProps {
  permission: ReturnType<typeof useMusicStore.getState>['permission']
  members: Array<{ socketId: string; userId?: number; username?: string }>
  onChange: (patch: Omit<MusicPermissionUpdate, 'roomId'>) => void
}

/** 房主：点歌权限（总开关 + 逐人白/黑名单） */
function PermissionSection({ permission, members, onChange }: PermissionSectionProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex w-full items-center justify-between text-[11px] font-medium"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="flex items-center gap-1">
          <Headphones className="h-3.5 w-3.5" />
          {t('点歌权限')}
        </span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
        />
      </button>
      <div className="flex items-center justify-between">
        <Text className="text-[11px] opacity-70">{t('允许成员点歌')}</Text>
        <Switch
          aria-label={t('允许成员点歌')}
          checked={permission.allowMembers}
          onChange={(e) => onChange({ allowMembers: e.target.checked })}
        />
      </div>
      {open && (
        <div className="max-h-32 space-y-0.5 overflow-y-auto pt-1">
          {members.length === 0 ? (
            <div className="py-2 text-center text-[10px] opacity-50">
              {t('暂无其他成员')}
            </div>
          ) : (
            members.map((m) => (
              <div
                key={m.socketId}
                className="flex items-center justify-between gap-1"
              >
                <span className="min-w-0 flex-1 truncate text-[11px]">
                  {m.username || t('观众')}
                </span>
                <Switch
                  aria-label={`${t('点歌权限')} - ${m.username || t('观众')}`}
                  checked={memberCanRequestMusic(permission, m.userId)}
                  onChange={(e) =>
                    onChange({ userId: m.userId, allowed: e.target.checked })
                  }
                />
              </div>
            ))
          )}
          <div className="pt-1 text-[10px] leading-tight opacity-50">
            {t('游客仅受上方总开关控制')}
          </div>
        </div>
      )}
    </div>
  )
}
