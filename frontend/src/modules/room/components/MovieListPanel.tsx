import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
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
import { Space } from '@/components/ui/Space'
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
 * 折叠展开式，默认收起。修改后立即写入 localStorage 持久化；
 * 仅当当前影片为 bilibili 源时显示，避免无关影片看到不相关设置。
 * 所有 B站 影片共享同一份解析偏好（localStorage 单 key 存储）。
 */
function BilibiliParseSettings({ movieId }: { movieId: number }) {
  const [expanded, setExpanded] = useState(false)
  const initial = getBilibiliParseOptions()
  const [codec, setCodec] = useState<BilibiliCodec>(initial.codec)
  const [cdn, setCdn] = useState(initial.preferCdn ?? '')
  const cdnDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (cdnDebounceRef.current) clearTimeout(cdnDebounceRef.current)
    }
  }, [])

  const handleCodecChange = useCallback(
    (value: string) => {
      const next = value as BilibiliCodec
      setCodec(next)
      setBilibiliParseOptions({
        codec: next,
        preferCdn: cdn.trim() || undefined,
      })
    },
    [cdn]
  )

  const handleCdnChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setCdn(value)
      if (cdnDebounceRef.current) clearTimeout(cdnDebounceRef.current)
      cdnDebounceRef.current = setTimeout(() => {
        setBilibiliParseOptions({
          codec,
          preferCdn: value.trim() || undefined,
        })
      }, 500)
    },
    [codec]
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
            className="[&_select]:h-7 [&_select]:py-0.5 [&_select]:pl-2 [&_select]:pr-1 [&_select]:text-xs"
            options={[
              { label: '自动', value: 'auto' },
              { label: 'H.264', value: 'avc' },
              { label: 'HEVC', value: 'hevc' },
              { label: 'AV1', value: 'av1' },
            ]}
            value={codec}
            onChange={handleCodecChange}
          />
          <Input
            label="CDN 偏好"
            size="sm"
            value={cdn}
            onChange={handleCdnChange}
            placeholder="如 upos（留空为自动）"
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
    <Space direction="vertical" className="min-w-0 h-full w-full" size="sm">
      <div className="flex items-center justify-between">
        <Text className="text-sm font-medium">
          影片列表 ({filteredMovies.length})
        </Text>
      </div>

      {isScreenShare && (
        <div
          className="glass flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] p-2"
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

      <div className="glass min-h-[120px] max-h-[220px] min-w-0 flex-1 overflow-hidden overflow-y-auto rounded-[var(--md-sys-shape-corner)] p-2">
        <Space direction="vertical" className="min-w-0 w-full" size="sm">
          {filteredMovies.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
              <Film
                className="h-6 w-6 opacity-40"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              />
              <Paragraph type="secondary" className="m-0 text-xs">
                {search ? '未找到匹配的影片' : '暂无影片，请在右侧添加'}
              </Paragraph>
            </div>
          )}
          {filteredMovies.map((movie, idx) => {
            const isActive = movie.id === currentMovieId
            return (
              <div
                key={movie.id}
                className={cn(
                  'zen-item-enter rounded-[var(--md-sys-shape-corner)] border p-2 transition-all',
                  isActive
                    ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)] shadow-sm'
                    : 'border-transparent bg-[var(--md-sys-color-surface-container-high)] hover:-translate-y-0.5 hover:border-[var(--md-sys-color-outline-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)] hover:shadow-md'
                )}
                style={
                  {
                    '--item-delay': `${idx * 50}ms`,
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
                  <Film
                    className="h-4 w-4 flex-shrink-0"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                  <div className="min-w-0 overflow-hidden">
                    <Paragraph
                      className="m-0 truncate text-xs font-medium"
                      title={movie.title}
                    >
                      {movie.title}
                    </Paragraph>
                    <Tag
                      color="primary"
                      className="mt-1 inline-flex min-w-0 max-w-full truncate"
                    >
                      {SOURCE_LABELS[movie.sourceType] || movie.sourceType}
                    </Tag>
                    {isHost &&
                      movie.sourceType === 'bilibili' &&
                      movie.acceptQuality &&
                      movie.acceptQuality.length > 0 && (
                        <Select
                          className="mt-1 [&_select]:h-7 [&_select]:py-0.5 [&_select]:pl-2 [&_select]:pr-1 [&_select]:text-xs"
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
        </Space>
      </div>
    </Space>
  )
}
