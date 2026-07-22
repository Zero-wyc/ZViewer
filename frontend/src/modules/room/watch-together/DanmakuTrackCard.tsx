import { useState } from 'react'
import { Plus, Trash2, Film, Search, Loader2, Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Slider } from '@/components/ui/Slider'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { DanmakuSearchModal } from './DanmakuSearchModal'
import { useDanmakuStore } from '@/store/danmakuStore'
import { cn } from '@/lib/utils'
import { getDanmakuEpisodes, fetchDanmaku } from '@/modules/danmaku/api'
import type { DanmakuSource } from '@/modules/danmaku/types'

const BV_REGEX = /^BV[0-9A-Za-z]{10}$/

const SOURCE_LABELS: Record<DanmakuSource, string> = {
  bilibili: 'B站',
  bahamut: '巴哈',
  dandanplay: '弹弹',
}

const SOURCE_COLORS: Record<DanmakuSource, string> = {
  bilibili: 'var(--md-sys-color-primary)',
  bahamut: 'var(--md-sys-color-tertiary)',
  dandanplay: 'var(--md-sys-color-secondary)',
}

export function DanmakuTrackCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  const addTrack = useDanmakuStore((state) => state.addTrack)
  const removeTrack = useDanmakuStore((state) => state.removeTrack)
  const updateTrackOffset = useDanmakuStore((state) => state.updateTrackOffset)
  const toggleTrackHidden = useDanmakuStore((state) => state.toggleTrackHidden)

  const [searchOpen, setSearchOpen] = useState(false)
  const [danmakuSource, setDanmakuSource] = useState<DanmakuSource>('bilibili')
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
      const episodes = await getDanmakuEpisodes('bilibili', bvid)
      if (episodes.length === 0) {
        message.info('未找到可用集数')
        return
      }
      if (episodes.length === 1) {
        // 单集：直接获取弹幕并添加
        const episode = episodes[0]
        const trackId = `bilibili:${episode.id}`
        if (tracks.some((t) => t.trackId === trackId)) {
          message.warning('该弹幕轨道已存在')
          return
        }
        const items = await fetchDanmaku('bilibili', episode)
        addTrack(trackId, episode.title, 'bilibili', items, 0)
        message.success(
          `已添加 ${episode.title} 弹幕轨道（共 ${items.length} 条）`
        )
        setBvInput('')
      } else {
        // 多集：打开搜索弹窗预填 BV 号并自动搜索
        setModalInitialKeyword(bvid)
        setDanmakuSource('bilibili')
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

  const handleOpenSearch = () => {
    setModalInitialKeyword(undefined)
    setSearchOpen(true)
  }

  const handleCloseSearch = () => {
    setSearchOpen(false)
    setModalInitialKeyword(undefined)
  }

  return (
    <div
      className="flex min-h-0 flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-3"
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
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

      <div className="flex min-h-0 flex-col gap-2 overflow-hidden">
        <div className="max-h-[240px] min-h-[120px] overflow-y-auto pr-1">
          {tracks.length === 0 && (
            <div
              className="flex h-full min-h-[120px] flex-col items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] border py-8"
              style={{
                backgroundColor:
                  'var(--md-sys-color-surface-container-high)',
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--md-sys-color-surface-container-highest)]">
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
                'mb-2 flex flex-col gap-1.5 rounded-[var(--md-sys-radius-small)] border p-2',
                track.hidden && 'opacity-60'
              )}
              style={{
                backgroundColor: 'var(--md-sys-color-surface-container-high)',
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
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
                    onClick={() => toggleTrackHidden(track.trackId)}
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
                      onClick={() => removeTrack(track.trackId)}
                      icon={<Trash2 className="h-3 w-3" />}
                    />
                  )}
                </div>
              </div>
              <Slider
                size="sm"
                value={track.offset}
                min={-60}
                max={60}
                step={0.5}
                valueFormatter={(v) => `${v > 0 ? '+' : ''}${v}s`}
                onChange={(v) => updateTrackOffset(track.trackId, v)}
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
