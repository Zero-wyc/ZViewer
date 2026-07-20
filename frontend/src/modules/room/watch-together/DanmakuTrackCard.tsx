import { useState } from 'react'
import { Plus, Trash2, Film, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Slider } from '@/components/ui/Slider'
import { Space } from '@/components/ui/Space'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { fetchBilibiliDanmaku } from './danmakuEngine'
import { DanmakuSearchModal, type DanmakuSource } from './DanmakuSearchModal'
import { useDanmakuStore } from '@/store/danmakuStore'

const BV_REGEX = /^BV[0-9A-Za-z]{10}$/

const DANMAKU_SOURCE_OPTIONS = [
  { label: 'B站视频', value: 'bilibili' },
  { label: 'B站番剧', value: 'bilibili_bangumi' },
  { label: '巴哈姆特', value: 'bahamut' },
  { label: '弹弹play', value: 'dandanplay' },
]

function isValidBvid(input: string): boolean {
  return BV_REGEX.test(input.trim())
}

export function DanmakuTrackCard() {
  const tracks = useDanmakuStore((state) => state.tracks)
  const addTrack = useDanmakuStore((state) => state.addTrack)
  const removeTrack = useDanmakuStore((state) => state.removeTrack)
  const updateTrackOffset = useDanmakuStore((state) => state.updateTrackOffset)

  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [danmakuSource, setDanmakuSource] = useState<DanmakuSource>('bilibili')

  const handleAdd = async () => {
    const bvid = input.trim()
    if (!isValidBvid(bvid)) {
      message.warning('请输入正确的 BV 号（如 BV1xx411c7mD）')
      return
    }

    if (tracks.some((t) => t.trackId === bvid)) {
      message.warning('该 BV 弹幕轨道已存在')
      return
    }

    setLoading(true)
    try {
      const items = await fetchBilibiliDanmaku(bvid)
      addTrack(bvid, bvid, items, 0)
      message.success(`已添加 ${bvid} 弹幕轨道（共 ${items.length} 条）`)
      setInput('')
    } catch (err) {
      console.error('[DanmakuTrackCard] add track error:', err)
      message.error(err instanceof Error ? err.message : '添加弹幕轨道失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-3"
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

      <Select
        label="弹幕数据源"
        value={danmakuSource}
        options={DANMAKU_SOURCE_OPTIONS}
        onChange={(value) => setDanmakuSource(value as DanmakuSource)}
        className="w-40"
      />

      <Space className="w-full" size="sm">
        <Input
          size="sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              handleAdd()
            }
          }}
          placeholder="输入 BV 号叠加弹幕"
          className="flex-1"
        />
        <Button
          variant="primary"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          loading={loading}
          disabled={!input.trim() || loading}
          onClick={handleAdd}
          icon={<Plus className="h-4 w-4" />}
        />
        <Button
          variant="secondary"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          title="搜索弹幕"
          onClick={() => setSearchOpen(true)}
          icon={<Search className="h-4 w-4" />}
        />
      </Space>

      <div className="flex min-h-0 flex-[1.5] flex-col gap-2 overflow-hidden">
        <div className="flex-1 overflow-y-auto pr-1">
          {tracks.length === 0 && (
            <Text type="secondary" className="text-center text-xs">
              暂无轨道，添加 BV 号以叠加弹幕
            </Text>
          )}
          {tracks.map((track) => (
            <div
              key={track.trackId}
              className="flex flex-col gap-1 rounded-[var(--md-sys-radius-small)] border p-1.5"
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
        onClose={() => setSearchOpen(false)}
        defaultSource={danmakuSource}
        onSourceChange={setDanmakuSource}
      />
    </div>
  )
}
