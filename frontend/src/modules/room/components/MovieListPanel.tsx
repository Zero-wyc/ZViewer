import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Play,
  Trash2,
  Film,
  Monitor,
  Settings2,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Select } from '@/components/ui/Select'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore, type Movie } from '@/store/roomStore'
import {
  resolveBilibiliWithOptions,
  filterQualitiesByVip,
  getBilibiliUserInfo,
} from '@/modules/bilibili/bilibiliApi'
import {
  getBilibiliParseOptions,
  setBilibiliParseOptions,
  BILIBILI_CDN_OPTIONS,
  type BilibiliCodec,
} from '@/modules/room/watch-together/resolveSource'
import { cn } from '@/lib/utils'

interface MovieListPanelProps {
  isHost: boolean
}

const SOURCE_LABELS: Record<string, string> = {
  bilibili: '哔哩哔哩',
  mp4: 'MP4',
  webdav: 'WebDAV',
  ftp: 'FTP',
  openlist: 'OpenList',
  smb: 'SMB',
}

/**
 * B站解析设置子组件：编码格式 + CDN 偏好。
 *
 * 折叠展开式，默认收起。修改后立即写入 localStorage 持久化，
 * 并通过 triggerReloadBilibili 触发当前 B站 影片的重新解析（应用新偏好）。
 * 仅当当前影片为 bilibili 源时显示，避免无关影片看到不相关设置。
 * 所有 B站 影片共享同一份解析偏好（localStorage 单 key 存储）。
 */
function BilibiliParseSettings({ movieId }: { movieId: number }) {
  const [expanded, setExpanded] = useState(false)
  const initial = getBilibiliParseOptions()
  const [codec, setCodec] = useState<BilibiliCodec>(initial.codec)
  const [cdn, setCdn] = useState(initial.preferCdn ?? '')
  const triggerReloadBilibili = useRoomStore(
    (state) => state.triggerReloadBilibili
  )
  const currentMovieId = useRoomStore((state) => state.currentMovieId)

  const handleCodecChange = useCallback(
    (value: string) => {
      const next = value as BilibiliCodec
      setCodec(next)
      setBilibiliParseOptions({
        codec: next,
        preferCdn: cdn.trim() || undefined,
      })
      // 仅当当前正在播放的就是本影片时才触发重载，避免影响其他影片
      if (currentMovieId === movieId) {
        triggerReloadBilibili()
      }
    },
    [cdn, currentMovieId, movieId, triggerReloadBilibili]
  )

  // CDN 选择为下拉菜单，选项均为预定义关键词，无需防抖
  const handleCdnChange = useCallback(
    (value: string) => {
      setCdn(value)
      setBilibiliParseOptions({
        codec,
        preferCdn: value || undefined,
      })
      if (currentMovieId === movieId) {
        triggerReloadBilibili()
      }
    },
    [codec, currentMovieId, movieId, triggerReloadBilibili]
  )

  return (
    <div className="mt-1.5 w-full">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-[var(--md-sys-shape-corner)] px-1.5 py-1 text-[10px] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1">
          <Settings2 className="h-3 w-3" />
          B站解析设置
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded && (
        <div
          key={movieId}
          className="flex flex-col gap-1.5 rounded-[var(--md-sys-shape-corner)] border p-1.5"
          style={{
            borderColor: 'var(--md-sys-color-outline-variant)',
            backgroundColor: 'var(--md-sys-color-surface-container)',
          }}
        >
          <Select
            label="编码格式"
            size="sm"
            options={[
              { label: '自动', value: 'auto' },
              { label: 'H.264', value: 'avc' },
              { label: 'HEVC', value: 'hevc' },
              { label: 'AV1', value: 'av1' },
            ]}
            value={codec}
            onChange={handleCodecChange}
          />
          <Select
            label="CDN 偏好"
            size="sm"
            options={BILIBILI_CDN_OPTIONS.map((opt) => ({
              label: opt.label,
              value: opt.value,
            }))}
            value={cdn}
            onChange={handleCdnChange}
          />
        </div>
      )}
    </div>
  )
}

export function MovieListPanel({ isHost }: MovieListPanelProps) {
  const { socket } = useSocket()
  const movies = useRoomStore((state) => state.movies)
  const currentMovieId = useRoomStore((state) => state.currentMovieId)
  const setCurrentMovieId = useRoomStore((state) => state.setCurrentMovieId)
  const roomId = useRoomStore((state) => state.roomId)
  const removeMovie = useRoomStore((state) => state.removeMovie)
  const updateMovie = useRoomStore((state) => state.updateMovie)
  const setPendingQualityChange = useRoomStore(
    (state) => state.setPendingQualityChange
  )
  const mode = useRoomStore((state) => state.mode)
  const [search, setSearch] = useState('')
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [qualityLoadingId, setQualityLoadingId] = useState<number | null>(null)
  const [bilibiliVip, setBilibiliVip] = useState(false)
  const isScreenShare = mode === 'screen-share'

  // 获取当前 B站 会员状态，用于过滤清晰度列表
  const hasBilibiliMovie = movies.some((m) => m.sourceType === 'bilibili')
  useEffect(() => {
    if (!hasBilibiliMovie) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 无 B站影片时重置会员状态
      setBilibiliVip(false)
      return
    }
    let cancelled = false
    getBilibiliUserInfo().then((info) => {
      if (!cancelled) setBilibiliVip(info?.vipStatus === 1)
    })
    return () => {
      cancelled = true
    }
  }, [hasBilibiliMovie])

  const filteredMovies = useMemo(() => {
    if (!search.trim()) return movies
    const keyword = search.trim().toLowerCase()
    return movies.filter((m) => m.title.toLowerCase().includes(keyword))
  }, [movies, search])

  const handlePlay = (movieId: number) => {
    if (!isHost) {
      message.info('只有房主可以切换影片')
      return
    }
    if (!socket) {
      message.error('未连接房间')
      return
    }
    socket.emit('play-movie', { roomId, movieId })
    setCurrentMovieId(movieId)
  }

  const handleRemove = async (movieId: number) => {
    if (!isHost) {
      message.info('只有房主可以删除影片')
      return
    }
    if (!roomId) {
      message.error('未连接房间')
      return
    }
    setRemovingId(movieId)
    try {
      await removeMovie(roomId, movieId)
      message.success('影片已删除')
    } catch (err) {
      console.error('[MovieListPanel] remove movie error:', err)
      message.error(err instanceof Error ? err.message : '删除影片失败')
    } finally {
      setRemovingId(null)
    }
  }

  const handleQualityChange = async (movie: Movie, value: string) => {
    if (!isHost || isScreenShare || !roomId) return
    const qn = Number(value)
    if (!Number.isFinite(qn) || qn === movie.currentQn) return

    setQualityLoadingId(movie.id)
    try {
      const resolved = await resolveBilibiliWithOptions(movie.url, qn)
      await updateMovie(roomId, movie.id, {
        audioUrl: resolved.audioUrl,
        format: resolved.format,
        videoCodec: resolved.videoCodec,
        audioCodec: resolved.audioCodec,
        duration: resolved.duration,
        cid: resolved.cid,
        currentQn: resolved.currentQn,
        acceptQuality: resolved.acceptQuality,
      })
      if (movie.id === currentMovieId) {
        setPendingQualityChange({ movieId: movie.id, resolved })
      }
    } catch (err) {
      console.error('[MovieListPanel] change quality error:', err)
      message.error(err instanceof Error ? err.message : '切换清晰度失败')
    } finally {
      setQualityLoadingId(null)
    }
  }

  return (
    <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* 卡片头部：图标 + 标题 + 影片数量 */}
      <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            background:
              'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent))',
          }}
        >
          <Film
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-tertiary)' }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Text className="text-sm font-semibold leading-tight">
            影片列表
          </Text>
          <Text type="secondary" className="text-[10px] uppercase tracking-wide">
            {filteredMovies.length} 部影片
          </Text>
        </div>
      </div>

      {/* 卡片内容 */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-4 py-3">
        {isScreenShare && (
          <div
            className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] p-2"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-secondary-container) calc(var(--glass-strength) * 100%), transparent)',
            }}
          >
            <Monitor
              className="h-4 w-4 flex-shrink-0"
              style={{ color: 'var(--md-sys-color-secondary)' }}
            />
            <Paragraph type="secondary" className="m-0 text-xs">
              当前为远程共享模式，影片播放已暂停
            </Paragraph>
          </div>
        )}

        <Input
          size="sm"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索影片…"
        />

        {/* 影片列表滚动区域 */}
        <div className="min-h-[120px] min-w-0 flex-1 overflow-y-auto rounded-[var(--md-sys-shape-corner)]">
          {filteredMovies.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full"
                style={{
                  backgroundColor:
                    'var(--md-sys-color-surface-container-high)',
                }}
              >
                <Film
                  className="h-5 w-5 opacity-40"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                />
              </div>
              <Paragraph type="secondary" className="m-0 text-xs">
                {search ? '未找到匹配的影片' : '暂无影片，请在右侧添加'}
              </Paragraph>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {filteredMovies.map((movie, idx) => {
              const isActive = movie.id === currentMovieId
              return (
                <div
                  key={movie.id}
                  className={cn(
                    'zen-item-enter rounded-[var(--md-sys-shape-corner)] border p-2.5 transition-all',
                    isActive
                      ? 'border-[var(--md-sys-color-primary)] shadow-md'
                      : 'border-transparent hover:-translate-y-0.5 hover:border-[var(--md-sys-color-outline-variant)] hover:shadow-md'
                  )}
                  style={
                    {
                      '--item-delay': `${idx * 50}ms`,
                      backgroundColor: isActive
                        ? 'var(--md-sys-color-primary-container)'
                        : 'var(--md-sys-color-surface-container-high)',
                    } as React.CSSProperties
                  }
                >
                  <div
                    draggable={false}
                    className={cn(
                      'grid items-center gap-2',
                      isHost
                        ? 'grid-cols-[auto_1fr_auto_auto]'
                        : 'grid-cols-[auto_1fr]'
                    )}
                  >
                    <div
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                      style={{
                        background: isActive
                          ? 'var(--md-sys-color-primary)'
                          : 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                      }}
                    >
                      <Film
                        className="h-3 w-3"
                        style={{
                          color: isActive
                            ? 'var(--md-sys-color-on-primary)'
                            : 'var(--md-sys-color-primary)',
                        }}
                      />
                    </div>
                    <div className="min-w-0 overflow-hidden">
                      <Paragraph
                        className="m-0 truncate text-xs font-medium"
                        title={movie.title}
                      >
                        {movie.title}
                      </Paragraph>
                      <div className="mt-1 flex items-center gap-1.5">
                        <Tag
                          color="primary"
                          className="inline-flex min-w-0 max-w-full truncate"
                        >
                          {SOURCE_LABELS[movie.sourceType] || movie.sourceType}
                        </Tag>
                      </div>
                      {isHost &&
                        movie.sourceType === 'bilibili' &&
                        movie.acceptQuality &&
                        movie.acceptQuality.length > 0 && (
                          <Select
                            className="mt-1.5"
                            size="sm"
                            value={String(
                              movie.currentQn ?? movie.acceptQuality[0]?.id
                            )}
                            options={filterQualitiesByVip(
                              movie.acceptQuality,
                              bilibiliVip
                            ).map((q) => ({
                              label: q.resolution
                                ? `${q.label} · ${q.resolution}`
                                : q.label,
                              value: String(q.id),
                            }))}
                            disabled={
                              !isHost ||
                              isScreenShare ||
                              qualityLoadingId === movie.id
                            }
                            onChange={(value) =>
                              handleQualityChange(movie, value)
                            }
                          />
                        )}
                    </div>
                    {isHost && (
                      <Button
                        variant={isActive ? 'primary' : 'secondary'}
                        size="sm"
                        className="h-7 flex-shrink-0 px-2"
                        icon={<Play className="h-3.5 w-3.5" />}
                        onClick={() => handlePlay(movie.id)}
                        disabled={!isHost || isScreenShare}
                        title={
                          isScreenShare
                            ? '远程共享模式下不可播放'
                            : isHost
                              ? '播放'
                              : '仅房主可播放'
                        }
                      />
                    )}
                    {isHost && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 flex-shrink-0 px-2"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => handleRemove(movie.id)}
                        loading={removingId === movie.id}
                        disabled={!isHost || isScreenShare}
                        title={
                          isScreenShare
                            ? '远程共享模式下不可删除'
                            : isHost
                              ? '删除'
                              : '仅房主可删除'
                        }
                      />
                    )}
                  </div>
                  {isHost && movie.sourceType === 'bilibili' && (
                    <BilibiliParseSettings movieId={movie.id} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
