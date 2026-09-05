import { useState } from 'react'
import { Plus, Trash2, Film, Search, Loader2, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Slider } from '@/components/ui/Slider'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { DanmakuSearchModal } from './DanmakuSearchModal'
import { useDanmakuStore } from '@/store/danmakuStore'
import { useRoomStore } from '@/store/roomStore'
import { cn } from '@/lib/utils'
import { extractMediaTitle } from '@/lib/mediaTitleParser'
import { getDanmakuEpisodes, fetchDanmaku } from '@/modules/danmaku/api'
import type { DanmakuSource } from '@/modules/danmaku/types'

const BV_REGEX = /^BV[0-9A-Za-z]{10}$/

const MAX_OFFSET_SECONDS = 60 // Slider 范围为 ±60s

function formatOffset(offset: number): string {
  const sign = offset > 0 ? '+' : offset < 0 ? '-' : ''
  const abs = Math.round(Math.abs(offset))
  const minutes = Math.floor(abs / 60)
  const seconds = abs - minutes * 60
  const secStr = String(seconds).padStart(2, '0')
  if (minutes === 0) {
    return `${sign}${seconds}s`
  }
  return `${sign}${minutes}m${secStr}s`
}

const SOURCE_LABELS: Record<DanmakuSource, string> = {
  'bilibili-video': 'B站视频',
  'bilibili-bangumi': 'B站番剧',
  bahamut: '巴哈',
  dandanplay: '弹弹',
}

const SOURCE_COLORS: Record<DanmakuSource, string> = {
  'bilibili-video': 'var(--md-sys-color-primary)',
  'bilibili-bangumi': 'var(--md-sys-color-tertiary)',
  bahamut: 'var(--md-sys-color-secondary)',
  dandanplay: 'var(--md-sys-color-error)',
}

export function DanmakuTrackCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  const addTrack = useDanmakuStore((state) => state.addTrack)
  const removeTrack = useDanmakuStore((state) => state.removeTrack)
  const updateTrackOffset = useDanmakuStore((state) => state.updateTrackOffset)
  const toggleTrackHidden = useDanmakuStore((state) => state.toggleTrackHidden)

  const [searchOpen, setSearchOpen] = useState(false)
  const [danmakuSource, setDanmakuSource] =
    useState<DanmakuSource>('bilibili-video')
  const [bvInput, setBvInput] = useState('')
  const [bvLoading, setBvLoading] = useState(false)
  const [modalInitialKeyword, setModalInitialKeyword] = useState<
    string | undefined
  >(undefined)

  const handleQuickAddBv = async () => {
    const bvid = bvInput.trim()
    if (!BV_REGEX.test(bvid)) {
      message.warning('请输入正确的 BV 号（如 BV1xx411c7mD）')
      return
    }

    setBvLoading(true)
    try {
      const episodes = await getDanmakuEpisodes('bilibili-video', bvid)
      if (episodes.length === 0) {
        message.info('未找到可用集数')
        return
      }
      if (episodes.length === 1) {
        // 单集：直接获取弹幕并添加
        const episode = episodes[0]
        const trackId = `bilibili-video:${episode.id}`
        if (tracks.some((t) => t.trackId === trackId)) {
          message.warning('该弹幕轨道已存在')
          return
        }
        const items = await fetchDanmaku('bilibili-video', episode)
        await addTrack(trackId, episode.title, 'bilibili-video', items, 0)
        message.success(
          `已添加 ${episode.title} 弹幕轨道（共 ${items.length} 条）`
        )
        setBvInput('')
      } else {
        // 多集：打开搜索弹窗预填 BV 号并自动搜索
        setModalInitialKeyword(bvid)
        setDanmakuSource('bilibili-video')
        setSearchOpen(true)
        setBvInput('')
      }
    } catch (err) {
      console.error('[DanmakuTrackCard] BV add error:', err)
      message.error(err instanceof Error ? err.message : '添加弹幕轨道失败')
    } finally {
      setBvLoading(false)
    }
  }

  /**
   * 从当前播放影片的文件名解析影视名，作为搜索弹窗的默认关键词。
   *
   * 挂载源（server-files/webdav/emby 等）的 movie.title 通常就是原始
   * 文件名（含发布组/分辨率/编码噪声），直接搜索命中率极低；经
   * extractMediaTitle 提炼后得到「影视名」，弹幕站点命中率显著更高。
   * B站 源的 title 是官方标题，同样适用（解析器对正常标题是幂等的）。
   *
   * @returns 解析结果；无当前影片或解析为空时返回 undefined（不预填）
   */
  const resolveDefaultKeyword = (): string | undefined => {
    const { currentMovieId, movies } = useRoomStore.getState()
    if (currentMovieId == null) return undefined
    const movie = movies.find((m) => m.id === currentMovieId)
    if (!movie) return undefined
    // 优先用 title（添加时已从文件名提炼），fallback 到 path/url 的文件名
    const source = movie.title || movie.path || movie.url || ''
    if (!source) return undefined
    const parsed = extractMediaTitle(source).trim()
    return parsed || undefined
  }

  const handleOpenSearch = () => {
    setModalInitialKeyword(resolveDefaultKeyword())
    setSearchOpen(true)
  }

  const handleCloseSearch = () => {
    setSearchOpen(false)
    setModalInitialKeyword(undefined)
  }

  return (
    <div className="glass flex h-full min-h-0 flex-col gap-3 rounded-[var(--md-sys-shape-corner)] p-3">
      <div className="flex items-center justify-between">
        <Text className="text-sm font-medium">弹幕轨道</Text>
        <Text type="secondary" className="text-[10px]">
          {tracks.length} 条轨道
        </Text>
      </div>

      <Button
        variant="primary"
        size="sm"
        className="h-8 w-full"
        onClick={handleOpenSearch}
        icon={<Search className="h-4 w-4" />}
      >
        搜索添加弹幕
      </Button>

      <div className="flex items-center gap-1.5">
        <Input
          size="sm"
          value={bvInput}
          onChange={(e) => setBvInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void handleQuickAddBv()
            }
          }}
          placeholder="输入 BV 号快速添加"
          className="flex-1"
          disabled={bvLoading}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          loading={bvLoading}
          disabled={!bvInput.trim() || bvLoading}
          onClick={() => void handleQuickAddBv()}
          icon={
            bvLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )
          }
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="zen-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          {tracks.length === 0 && (
            <div
              className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] border py-8"
              style={{
                backgroundColor: 'var(--glass-bg)',
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--glass-bg)]">
                <Plus className="h-5 w-5 opacity-40" />
              </div>
              <Text type="secondary" className="text-xs">
                暂无弹幕轨道
              </Text>
            </div>
          )}
          {tracks.map((track) => (
            <div
              key={track.trackId}
              className={cn(
                'glass mb-2 flex flex-col gap-1.5 rounded-[var(--md-sys-radius-small)] p-2',
                track.hidden && 'opacity-60'
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Film className="h-3 w-3 shrink-0 opacity-70" />
                  <Text className="truncate text-[11px] font-medium">
                    {track.label}
                  </Text>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                    style={{
                      backgroundColor: `color-mix(in srgb, ${SOURCE_COLORS[track.source]} 15%, transparent)`,
                      color: SOURCE_COLORS[track.source],
                    }}
                  >
                    {SOURCE_LABELS[track.source]}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 shrink-0 p-0 text-[var(--md-sys-color-on-surface-variant)]"
                    title={track.hidden ? '显示该轨道弹幕' : '隐藏该轨道弹幕'}
                    onClick={() => void toggleTrackHidden(track.trackId)}
                    icon={
                      track.hidden ? (
                        <EyeOff className="h-3 w-3" />
                      ) : (
                        <Eye className="h-3 w-3" />
                      )
                    }
                  />
                  {track.trackId !== 'default' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-5 w-5 shrink-0 p-0 text-[var(--md-sys-color-error)]"
                      onClick={() => void removeTrack(track.trackId)}
                      icon={<Trash2 className="h-3 w-3" />}
                    />
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1">
                  <Text className="text-[10px] tabular-nums">
                    {formatOffset(track.offset)}
                  </Text>
                  <Text className="text-[9px] text-[var(--md-sys-color-primary)]">
                    当前
                  </Text>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Input
                    type="number"
                    size="sm"
                    step={1}
                    min={-999}
                    max={999}
                    value={String(Math.trunc(track.offset / 60))}
                    onChange={(e) => {
                      const value = e.target.value
                      if (value === '' || value === '-') return
                      const minutes = Number(value)
                      if (Number.isNaN(minutes)) return
                      const seconds = Math.round(
                        track.offset - Math.trunc(track.offset / 60) * 60
                      )
                      const clampedMinutes = Math.min(
                        999,
                        Math.max(-999, minutes)
                      )
                      void updateTrackOffset(
                        track.trackId,
                        clampedMinutes * 60 + seconds
                      )
                    }}
                    onBlur={(e) => {
                      const value = e.target.value
                      if (value === '' || value === '-') {
                        const seconds = Math.round(
                          track.offset - Math.trunc(track.offset / 60) * 60
                        )
                        void updateTrackOffset(track.trackId, seconds)
                      }
                    }}
                    className="h-6 w-[88px] px-1 text-right text-[11px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <Text type="secondary" className="text-[10px]">
                    m
                  </Text>
                  <Input
                    type="number"
                    size="sm"
                    step={1}
                    min={-60}
                    max={60}
                    value={String(
                      Math.round(
                        track.offset - Math.trunc(track.offset / 60) * 60
                      )
                    )}
                    onChange={(e) => {
                      const value = e.target.value
                      if (value === '' || value === '-') return
                      const seconds = Number(value)
                      if (Number.isNaN(seconds)) return
                      const minutes = Math.trunc(track.offset / 60)
                      void updateTrackOffset(
                        track.trackId,
                        minutes * 60 + seconds
                      )
                    }}
                    onBlur={(e) => {
                      const value = e.target.value
                      const minutes = Math.trunc(track.offset / 60)
                      if (value === '' || value === '-') {
                        void updateTrackOffset(track.trackId, minutes * 60)
                        return
                      }
                      let seconds = Number(value)
                      if (Number.isNaN(seconds)) return
                      // 将秒数规范化到 [-59, 59]，并向分钟进位
                      let normalizedMinutes = minutes
                      if (seconds >= 60) {
                        normalizedMinutes += Math.floor(seconds / 60)
                        seconds = seconds % 60
                      } else if (seconds <= -60) {
                        normalizedMinutes += Math.ceil(seconds / 60)
                        seconds = seconds % 60
                      }
                      normalizedMinutes = Math.min(
                        999,
                        Math.max(-999, normalizedMinutes)
                      )
                      void updateTrackOffset(
                        track.trackId,
                        normalizedMinutes * 60 + seconds
                      )
                    }}
                    className="h-6 w-[72px] px-1 text-right text-[11px] [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                  <Text type="secondary" className="text-[10px]">
                    s
                  </Text>
                </div>
              </div>
              <Slider
                size="sm"
                value={track.offset}
                min={-MAX_OFFSET_SECONDS}
                max={MAX_OFFSET_SECONDS}
                step={1}
                valueFormatter={(v) => formatOffset(v)}
                onChange={(v) => void updateTrackOffset(track.trackId, v)}
              />
              <Text type="secondary" className="text-[10px]">
                共 {track.items.length} 条弹幕
              </Text>
            </div>
          ))}
        </div>
      </div>

      <DanmakuSearchModal
        open={searchOpen}
        onClose={handleCloseSearch}
        defaultSource={danmakuSource}
        onSourceChange={setDanmakuSource}
        initialKeyword={modalInitialKeyword}
      />
    </div>
  )
}
