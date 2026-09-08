/**
 * 歌曲搜索面板（侧栏）：搜索网易云歌曲并添加到房间播放队列。
 *
 * - 搜索：GET /api/music/ncm/cloudsearch?keywords=&limit=30（回车手动触发）
 * - 添加：canManage（房主/房管）时行尾 Plus 按钮 emit `music:queue-upsert`：
 *   `{ roomId, item: { songId, name, artist, album, cover, durationMs, vip } }`
 *   （后端 MusicSyncHandler 契约，变更后经 `music:queue-changed` 广播完整队列）
 * - 底部网易云登录区：surface-container-high 圆角 inset，扫码二维码弹窗
 *   （顶部出现、无全屏遮罩、圆角），状态机由 useNcmLogin 驱动
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Music,
  Search,
  Plus,
  Check,
  Loader2,
  LogOut,
  QrCode,
  User,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
import { apiGet } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { useNcmLogin } from '../hooks/useNcmLogin'
import type { NcmSong } from '../types'
import { cn } from '@/lib/utils'

export interface MusicSearchPanelProps {
  socket: Socket | null
  roomId?: string
  /** 队列管理权限（房主/房管）才能添加歌曲 */
  canManage: boolean
}

/** 网易云 cloudsearch 原始响应（后端透传结构） */
interface NcmCloudsearchResponse {
  code?: number
  result?: {
    songs?: Array<{
      id: number
      name: string
      ar?: Array<{ name?: string }>
      al?: { name?: string; picUrl?: string }
      dt?: number
      /** 0 免费 / 1 VIP / 4 购买专辑 / 8 低音质免费 */
      fee?: number
    }>
  }
}

/** 搜索结果条数上限（与任务约定一致） */
const SEARCH_LIMIT = 30

/** 「已添加」行内态的展示时长（毫秒） */
const ADDED_STATE_MS = 2000

/** 毫秒时长格式化为 m:ss */
function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function MusicSearchPanel({
  socket,
  roomId,
  canManage,
}: MusicSearchPanelProps) {
  const [keywords, setKeywords] = useState('')
  const [results, setResults] = useState<NcmSong[]>([])
  const [searching, setSearching] = useState(false)
  /** 是否已发起过搜索（区分初始空态与无结果空态） */
  const [searched, setSearched] = useState(false)
  /** 已添加行内态（songId 集合，2s 自动恢复） */
  const [addedSongIds, setAddedSongIds] = useState<Set<number>>(() => new Set())
  /** 已添加状态自动恢复的定时器（卸载时清理） */
  const addedTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // 二维码登录弹窗
  const [qrOpen, setQrOpen] = useState(false)
  const { qrImg, status, startLogin, stopPolling, loginStatus, logout } =
    useNcmLogin()

  // 卸载时清理「已添加」恢复定时器
  useEffect(() => {
    const timers = addedTimersRef.current
    return () => {
      for (const t of timers) clearTimeout(t)
      timers.clear()
    }
  }, [])

  // 登录成功：提示并关闭二维码弹窗
  useEffect(() => {
    if (status === 'success') {
      message.success('网易云登录成功')
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 登录成功由扫码状态机驱动，关闭二维码弹窗
      setQrOpen(false)
    }
  }, [status])

  const handleSearch = useCallback(async () => {
    const kw = keywords.trim()
    if (!kw) {
      message.warning('请输入歌曲名或歌手')
      return
    }
    setSearching(true)
    try {
      const { data, ok } = await apiGet<NcmCloudsearchResponse>(
        `/api/music/ncm/cloudsearch?keywords=${encodeURIComponent(
          kw
        )}&limit=${SEARCH_LIMIT}`
      )
      const songs = data?.result?.songs
      if (!ok || !Array.isArray(songs)) {
        throw new Error('搜索失败，请稍后重试')
      }
      setResults(
        songs.map((song) => ({
          songId: song.id,
          name: song.name,
          artist: (song.ar ?? [])
            .map((a) => a.name)
            .filter(Boolean)
            .join(' / '),
          album: song.al?.name ?? '',
          cover: song.al?.picUrl ?? '',
          durationMs: song.dt ?? 0,
          // fee=1（VIP 曲目）与 fee=4（购买专辑）未登录时不可播
          vip: song.fee === 1 || song.fee === 4,
        }))
      )
      setSearched(true)
    } catch (err) {
      console.error('[MusicSearchPanel] 搜索失败:', err)
      message.error(err instanceof Error ? err.message : '搜索失败，请稍后重试')
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [keywords])

  const handleAdd = useCallback(
    (song: NcmSong) => {
      if (!canManage) {
        message.info('只有房主或房管可以添加歌曲')
        return
      }
      if (!socket || !roomId) {
        message.error('未连接房间')
        return
      }
      socket.emit(
        'music:queue-upsert',
        {
          roomId,
          item: {
            songId: song.songId,
            name: song.name,
            artist: song.artist,
            album: song.album,
            cover: song.cover,
            durationMs: song.durationMs,
            vip: song.vip,
          },
        },
        (response: { success?: boolean; message?: string }) => {
          if (response && response.success === false) {
            message.error(response.message || '添加歌曲失败')
          }
        }
      )
      // 行内「已添加」状态，2s 后恢复
      setAddedSongIds((prev) => new Set(prev).add(song.songId))
      const timer = setTimeout(() => {
        setAddedSongIds((prev) => {
          const next = new Set(prev)
          next.delete(song.songId)
          return next
        })
        addedTimersRef.current.delete(timer)
      }, ADDED_STATE_MS)
      addedTimersRef.current.add(timer)
    },
    [canManage, socket, roomId]
  )

  const handleOpenQr = useCallback(() => {
    setQrOpen(true)
    void startLogin()
  }, [startLogin])

  const handleCloseQr = useCallback(() => {
    stopPolling()
    setQrOpen(false)
  }, [stopPolling])

  const qrStatusText: Record<string, string> = {
    generating: '正在生成二维码…',
    waiting: '请使用网易云音乐 App 扫码登录',
    scanned: '已扫描，请在手机上确认登录',
    success: '登录成功',
    error: '二维码生成失败，请重试',
  }

  return (
    <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* 卡片头部：图标 + 标题 */}
      <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            background:
              'linear-gradient(135deg, var(--md-sys-color-primary), color-mix(in srgb, var(--md-sys-color-primary) 70%, var(--md-sys-color-tertiary)))',
          }}
        >
          <Music
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-on-primary)' }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Text className="text-sm font-semibold leading-tight">歌曲搜索</Text>
          <Text
            type="secondary"
            className="text-[10px] uppercase tracking-wide"
          >
            MUSIC SEARCH
          </Text>
        </div>
      </div>

      {/* 卡片内容 */}
      <div className="zen-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-3">
        {/* 搜索框（回车触发手动搜索，无防抖） */}
        <div className="flex items-center gap-2">
          <Input
            size="sm"
            value={keywords}
            onChange={(e) => setKeywords(e.target.value)}
            placeholder="搜索歌曲、歌手…"
            className="min-w-0 flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleSearch()
              }
            }}
          />
          <Button
            variant="primary"
            size="sm"
            className="h-8 w-8 shrink-0 px-0"
            loading={searching}
            disabled={searching}
            icon={<Search className="h-3.5 w-3.5" />}
            onClick={() => void handleSearch()}
            title="搜索"
          />
        </div>

        {/* 搜索结果列表 */}
        <div className="flex min-h-[120px] flex-1 flex-col gap-1">
          {results.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full"
                style={{
                  backgroundColor: 'var(--glass-bg)',
                }}
              >
                <Music
                  className="h-5 w-5 opacity-40"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                />
              </div>
              <Paragraph type="secondary" className="m-0 text-xs">
                {searched
                  ? '未找到相关歌曲，换个关键词试试'
                  : '输入关键词搜索网易云歌曲'}
              </Paragraph>
            </div>
          )}
          {results.map((song) => {
            const added = addedSongIds.has(song.songId)
            return (
              <div
                key={song.songId}
                className="glass zen-item-enter flex items-center gap-2.5 rounded-[var(--md-sys-shape-corner)] border border-transparent p-2 transition-all hover:-translate-y-0.5 hover:border-[var(--md-sys-color-outline-variant)] hover:shadow-md"
              >
                {/* 封面缩略图 */}
                {song.cover ? (
                  <img
                    src={song.cover}
                    alt={song.name}
                    className="h-9 w-9 shrink-0 rounded-[var(--md-sys-shape-corner)] object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <Music
                      className="h-4 w-4"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                  </div>
                )}
                {/* 歌名 / 歌手 - 专辑 / 时长 + VIP */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <Paragraph
                    className="m-0 truncate text-sm font-medium"
                    title={song.name}
                  >
                    {song.name}
                  </Paragraph>
                  <div className="flex items-center gap-1.5">
                    <Text
                      type="secondary"
                      className="truncate text-xs"
                      title={`${song.artist}${song.album ? ` - ${song.album}` : ''}`}
                    >
                      {song.artist}
                      {song.album ? ` - ${song.album}` : ''}
                    </Text>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Text type="secondary" className="text-[10px] tabular-nums">
                      {formatDurationMs(song.durationMs)}
                    </Text>
                    {song.vip && (
                      <span
                        className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium"
                        style={{
                          backgroundColor:
                            'color-mix(in srgb, var(--md-sys-color-tertiary) 15%, transparent)',
                          color: 'var(--md-sys-color-tertiary)',
                        }}
                      >
                        VIP
                      </span>
                    )}
                  </div>
                </div>
                {/* 添加按钮（房主/房管） */}
                {canManage && (
                  <Button
                    variant={added ? 'primary' : 'secondary'}
                    size="sm"
                    className="h-7 w-7 shrink-0 px-0"
                    icon={
                      added ? (
                        <Check className="h-3.5 w-3.5" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )
                    }
                    onClick={() => handleAdd(song)}
                    title={added ? '已添加' : '添加到队列'}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* 网易云登录区（surface-container-high 圆角 inset） */}
        <div
          className="rounded-[var(--md-sys-shape-corner)] p-2.5"
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container-high)',
          }}
        >
          <div className="flex items-center gap-2">
            <Music
              className="h-3.5 w-3.5"
              style={{ color: 'var(--md-sys-color-primary)' }}
            />
            <Text
              type="secondary"
              className="text-[10px] uppercase tracking-wide"
            >
              网易云登录状态
            </Text>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {loginStatus.loggedIn ? (
              <>
                {loginStatus.avatarUrl ? (
                  <img
                    src={loginStatus.avatarUrl}
                    alt={loginStatus.nickname ?? '网易云账号'}
                    className="h-6 w-6 rounded-full object-cover"
                  />
                ) : (
                  <div
                    className="flex h-6 w-6 items-center justify-center rounded-full"
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-highest)',
                    }}
                  >
                    <User className="h-3.5 w-3.5" />
                  </div>
                )}
                <Text className="text-xs">
                  {loginStatus.nickname ?? '已登录'}
                </Text>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  icon={<LogOut className="h-3 w-3" />}
                  onClick={() => void logout()}
                >
                  退出
                </Button>
              </>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                className="h-6 px-2 text-xs"
                icon={<QrCode className="h-3 w-3" />}
                onClick={handleOpenQr}
              >
                登录网易云音乐
              </Button>
            )}
          </div>
          <Paragraph type="secondary" className="m-0 mt-1.5 text-[11px]">
            {loginStatus.loggedIn
              ? '已登录，可播放 VIP 歌曲'
              : '登录后可播放 VIP 歌曲'}
          </Paragraph>
        </div>
      </div>

      {/* 扫码登录二维码弹窗：顶部出现、无全屏遮罩、圆角 */}
      {qrOpen &&
        createPortal(
          <>
            {/* 透明捕获层：点击外部关闭（不遮挡视觉） */}
            <div
              className="fixed inset-0 z-[998]"
              onClick={handleCloseQr}
              aria-hidden="true"
            />
            <div className="fixed left-1/2 top-16 z-[999] -translate-x-1/2">
              <div
                className={cn(
                  'glass-strong flex w-72 flex-col items-center gap-4',
                  'rounded-[var(--md-sys-shape-corner)] p-6 shadow-lg',
                  'zen-modal-content-enter'
                )}
                style={{
                  boxShadow:
                    '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                }}
              >
                <Text className="text-sm font-semibold">
                  扫码登录网易云音乐
                </Text>
                {qrImg ? (
                  <img
                    src={qrImg}
                    alt="网易云登录二维码"
                    className="rounded-lg border"
                    style={{
                      width: 200,
                      height: 200,
                      borderColor: 'var(--md-sys-color-outline-variant)',
                    }}
                  />
                ) : (
                  <div
                    className="glass flex items-center justify-center rounded-lg"
                    style={{ width: 200, height: 200 }}
                  >
                    {status === 'generating' ? (
                      <div className="flex flex-col items-center gap-2">
                        <Loader2 className="h-6 w-6 animate-spin text-[var(--md-sys-color-primary)]" />
                        <Text type="secondary" className="text-xs">
                          正在生成二维码…
                        </Text>
                      </div>
                    ) : (
                      <Spinner size={28} tip="正在生成二维码" />
                    )}
                  </div>
                )}
                <Paragraph
                  type={
                    status === 'error'
                      ? 'danger'
                      : status === 'success'
                        ? 'success'
                        : 'secondary'
                  }
                  className="m-0 text-center text-xs"
                >
                  {qrStatusText[status] ?? '请使用网易云音乐 App 扫码登录'}
                  {status === 'waiting' && '（二维码过期将自动刷新）'}
                </Paragraph>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  onClick={handleCloseQr}
                >
                  关闭
                </Button>
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  )
}
