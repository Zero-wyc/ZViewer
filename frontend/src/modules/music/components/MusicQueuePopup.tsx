/**
 * 队列弹窗（Hydrogen PlayList 弹窗范式，widget 上方弹出）。
 *
 * - 双源列表：随当前播放来源自动切换——B站 曲目显示 B站 播放列表
 *   （本地会话记忆 ∪ 房间队列中的 B站条目），网易云曲目显示网易云列表
 *   （房间队列去除 B站条目）；两源独立记忆、互不混显
 * - 定位：top = absolute bottom-full 右对齐（音乐主页 widget 右上弹出，
 *   glass-card 浅色毛玻璃）；side / sheet = 歌词播放页入口，黑底高斯
 *   模糊皮肤（黑底 SETTING 弹窗同视觉语言，令牌覆盖整体反白），
 *   w-80 高 24rem，从底部进入动画（translate-y + opacity）
 * - 头部：「当前播放 (N)」+ 来源标识 + 自动推荐（B站 视图：按当前视频
 *   拉取相关推荐前 3 条插入下三首）+ 清空 + 定位到当前 + 关闭
 * - 列表行：Hydrogen PlayList 行范式（EQ 频谱 + 「歌名 - 歌手」单行截断）；
 *   当前播放行浅高亮 + EQ 动画；网易云行 canControl 点击切歌（playSong）；
 *   B站行本地插播（playBiliSong，无需房主权限）；网易云行 canManage 删除
 *   （queue-remove）；B站行本地删除
 * - 空态文案
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Crosshair, X, Trash2, Loader2, Sparkles } from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import { useMusicStore, musicItemKey } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { EqBars } from './SongRow'
import { cn } from '@/lib/utils'

/** 歌词页队列面板（side / sheet placement）的黑底高斯模糊皮肤：
 *  对齐黑底 SETTING 弹窗视觉语言（纯黑半透 + backdrop blur + 白描边），
 *  容器级覆盖 MD3 令牌——弹窗内全部 var() 引用（文字 / hover 底色 /
 *  当前行 EQ / 推荐徽章）整体切换到白主题语言（primary = 白） */
const QUEUE_DARK_TOKENS = {
  '--md-sys-color-on-surface': '#ececf0',
  '--md-sys-color-on-surface-variant': '#c6c6ce',
  '--md-sys-color-primary': '#ffffff',
} as React.CSSProperties

export interface MusicQueuePopupProps {
  socket: Socket | null
  roomId?: string
  /** 是否为房主（canControl 者可点击切歌，房主为主） */
  isHost: boolean
  /** 队列管理权限（房主/房管）可删除 */
  canManage: boolean
  /** 弹出位置：top = 向上弹出（widget 上方）；side = 从锚点左侧弹出（全屏播放器）；
   *  sheet = 固定底部居中（手机竖屏：侧挂会出屏） */
  placement?: 'top' | 'side' | 'sheet'
}

export function MusicQueuePopup({
  socket,
  roomId,
  canManage,
  placement = 'top',
}: MusicQueuePopupProps) {
  const queue = useMusicStore((s) => s.queue)
  const biliRecommendedKeys = useMusicStore((s) => s.biliRecommendedKeys)
  const currentKey = useMusicStore((s) => s.currentKey)
  const isPlaying = useMusicStore((s) => s.isPlaying)
  const setQueuePopupOpen = useMusicStore((s) => s.setQueuePopupOpen)
  /** 歌词页入口（side / sheet）启用黑底高斯模糊皮肤；音乐主页 widget
   *  上方弹出（top）保持原 glass-card 浅色毛玻璃 */
  const darkGlass = placement !== 'top'
  const { playSong, canControl, requestControl, addBiliRecommendations } =
    useMusicPlayer()

  /** 「自动推荐」请求进行中（防重复点击） */
  const [recLoading, setRecLoading] = useState(false)

  /** 当前播放来源是否为 B站（决定列表视图与操作路径） */
  const isBiliView = currentKey?.startsWith('bili:') ?? false
  // 两源视图均来自房间队列（全房间同步）：B站视图 = 队列中的 B站 条目，
  // 网易云视图 = 队列去除 B站 条目
  const list = useMemo(
    () =>
      isBiliView
        ? queue.filter((it) => it.biliBvid)
        : queue.filter((it) => !it.biliBvid),
    [isBiliView, queue]
  )

  // 打开时滚动到当前播放行（Hydrogen getPositon 范式）
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (currentKey == null) return
    const idx = list.findIndex((item) => musicItemKey(item) === currentKey)
    if (idx < 0) return
    listRef.current?.scrollTo({
      top: Math.max(0, idx * 37 - 80),
      behavior: 'smooth',
    })
  }, [list, currentKey])

  /** 点击行播放：有控制权（房主/房主离线观众）→ 房间同步切歌；
   *  无控制权 → 一律走 playItem 申请（B站/网易云行一致，房主「自动通过」
   *  开→代理执行；关→房主审批）。本地插播已取消：房间内播放全部统一 */
  const handlePlay = (item: (typeof list)[number]) => {
    if (musicItemKey(item) === currentKey) return
    if (canControl) {
      playSong(item)
      return
    }
    requestControl('playItem', undefined, {
      songId: item.songId,
      name: item.name,
      artist: item.artist,
      album: item.album,
      cover: item.cover,
      durationMs: item.durationMs,
      vip: item.vip,
      biliBvid: item.biliBvid,
      biliCid: item.biliCid,
    })
  }

  /** 删除：走房间 queue-remove（canManage，B站/网易云条目一致） */
  const handleRemove = (itemId: number) => {
    if (!canManage) {
      message.info('只有房主或房管可以删除歌曲')
      return
    }
    if (!socket || !roomId) {
      message.error('未连接房间')
      return
    }
    socket.emit(
      'music:queue-remove',
      { roomId, id: itemId },
      (response: { success?: boolean; message?: string }) => {
        if (response && response.success === false) {
          message.error(response.message || '删除歌曲失败')
        }
      }
    )
  }

  /** 清空：走房间 queue-clear（canManage，B站/网易云条目一致） */
  const handleClear = () => {
    if (!socket || !roomId) {
      message.error('未连接房间')
      return
    }
    socket.emit(
      'music:queue-clear',
      { roomId },
      (response: { success?: boolean; message?: string }) => {
        if (response && response.success === false) {
          message.error(response.message || '清空队列失败')
        }
      }
    )
  }

  return (
    <div
      className={cn(
        'zen-stagger-fade-up absolute z-50 flex h-96 w-80 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]',
        // 黑底皮肤：深投影替代浅色 glass-card 的柔和阴影
        darkGlass
          ? 'shadow-[0_24px_80px_rgba(0,0,0,0.6)]'
          : 'glass-card shadow-lg',
        placement === 'top'
          ? 'bottom-[calc(100%+8px)] right-2'
          : placement === 'side'
            ? // 侧挂（歌词页工具栏）：垂直居中对齐按钮、水平向右展开（左侧会出屏被裁切）；居中用 top+负 margin，不能用 -translate-y-1/2——zen-stagger-fade-up 动画全程接管 transform
              'top-1/2 left-[calc(100%+14px)] mt-[-12rem]'
            : // sheet：手机竖屏固定底部居中（overlay 容器带 transform，
              // fixed 实际相对全屏覆盖层定位，效果等同视口居中）
              'fixed inset-x-0 bottom-[calc(88px+env(safe-area-inset-bottom))] mx-auto h-[min(24rem,55dvh)]'
      )}
      style={
        darkGlass
          ? ({
              // 黑底 + 高斯模糊（黑底 SETTING 弹窗同参数）+ 白描边；
              // 令牌覆盖让弹窗内文字/hover/高亮整体反白
              backgroundColor: 'rgba(8, 8, 8, 0.72)',
              backdropFilter: 'blur(28px)',
              WebkitBackdropFilter: 'blur(28px)',
              border: '0.5px solid rgba(255, 255, 255, 0.12)',
              ...QUEUE_DARK_TOKENS,
            } as React.CSSProperties)
          : undefined
      }
    >
      {/* ===== 头部：当前播放 (N) + 来源标识 + 清空 + 定位 + 关闭 ===== */}
      <div className="flex shrink-0 items-center justify-between pl-4 pr-3 pt-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-base font-semibold text-[var(--md-sys-color-on-surface)]">
            当前播放
          </span>
          <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            ({list.length})
          </span>
          {/* 来源标识（两源列表独立，随当前播放来源切换） */}
          <span
            className="ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent)',
              color: 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            {isBiliView ? '哔哩哔哩' : '网易云'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* 自动推荐（仅 B站 视图 + 已连接房间）：按当前播放视频拉取
              B站 相关推荐前 3 条，插入当前曲目之后的下三首 */}
          {isBiliView && roomId && socket && (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] transition-opacity hover:opacity-70 active:scale-90 disabled:opacity-40"
              disabled={recLoading}
              onClick={() => {
                setRecLoading(true)
                void addBiliRecommendations(canManage).finally(() =>
                  setRecLoading(false)
                )
              }}
              title="自动推荐：根据当前视频加入 B站 相关推荐前 3 首"
              aria-label="自动推荐"
            >
              {recLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </button>
          )}
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] transition-opacity hover:opacity-70 active:scale-90 disabled:opacity-40"
            disabled={list.length === 0}
            onClick={handleClear}
            title={isBiliView ? '清空B站播放列表' : '清空队列'}
            aria-label={isBiliView ? '清空B站播放列表' : '清空队列'}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] transition-opacity hover:opacity-70 active:scale-90"
            onClick={() => {
              const idx = list.findIndex(
                (item) => musicItemKey(item) === currentKey
              )
              if (idx >= 0) {
                listRef.current?.scrollTo({
                  top: Math.max(0, idx * 37 - 80),
                  behavior: 'smooth',
                })
              }
            }}
            title="定位到当前播放"
            aria-label="定位到当前播放"
          >
            <Crosshair className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] transition-opacity hover:opacity-70 active:scale-90"
            onClick={() => setQueuePopupOpen(false)}
            title="关闭"
            aria-label="关闭队列弹窗"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      {/* 分隔线（Hydrogen line：细黑线） */}
      <div
        className="mx-4 my-2 h-px shrink-0"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-on-surface) 60%, transparent)',
        }}
      />

      {/* ===== 列表（EQ + 歌名 - 歌者；当前行高亮；hover 删除） ===== */}
      <div
        ref={listRef}
        className="zen-scroll min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {list.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <ListMusicIcon />
            <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {isBiliView
                ? 'B站播放列表为空，去哔哩哔哩页点播视频'
                : '队列为空，去搜索添加歌曲'}
            </span>
          </div>
        ) : (
          list.map((item) => {
            const itemKey = musicItemKey(item)
            const active = itemKey === currentKey
            return (
              <div
                key={itemKey}
                className={cn(
                  'group flex h-[37px] shrink-0 cursor-pointer items-center justify-between px-3 pl-4 transition-colors duration-200',
                  'hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)]',
                  active &&
                    'bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_5%,transparent)]'
                )}
                onClick={() => handlePlay(item)}
                title={
                  active
                    ? '正在播放'
                    : isBiliView || canControl
                      ? '点击播放'
                      : undefined
                }
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  {/* 当前播放行 EQ（复用 EqBars） */}
                  {active && (
                    <span className="flex w-3.5 shrink-0 items-center justify-center text-[var(--md-sys-color-primary)]">
                      <EqBars paused={!isPlaying} />
                    </span>
                  )}
                  <span
                    className={cn(
                      'min-w-0 truncate text-sm',
                      active
                        ? 'text-[var(--md-sys-color-primary)]'
                        : 'text-[var(--md-sys-color-on-surface)]'
                    )}
                  >
                    {item.name}
                  </span>
                  {/* B站 推荐标记：相关推荐自动追加的条目（后端随队列持久化 +
                      本地记忆兜底） */}
                  {(item.recommended ||
                    biliRecommendedKeys.includes(itemKey)) && (
                    <span
                      className="shrink-0 rounded-full px-1 py-px text-[10px] font-bold"
                      style={{
                        color: 'var(--md-sys-color-primary)',
                        backgroundColor:
                          'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                      }}
                      title="由 B站 相关推荐自动加入"
                    >
                      推荐
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {' - '}
                  </span>
                  <span className="min-w-0 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {item.artist}
                  </span>
                </div>
                {/* 删除（房间队列统一操作，canManage；行 hover 淡入） */}
                {canManage && (
                  <button
                    type="button"
                    className="flex h-6 w-6 shrink-0 items-center justify-center text-[var(--md-sys-color-on-surface-variant)] opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-70"
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRemove(item.id)
                    }}
                    title="从队列删除"
                    aria-label="从队列删除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/** 空态图标（避免与 ListMusic 主按钮命名冲突的内联小图标） */
function ListMusicIcon() {
  return (
    <svg
      className="h-6 w-6 opacity-40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
      aria-hidden="true"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="15" y2="12" />
      <path d="M3 18h8" />
      <circle cx="18" cy="16" r="3" />
      <path d="M21 16V5" />
    </svg>
  )
}
