import { useState, useMemo, useEffect } from 'react'
import { Search, Loader2, Tv, PlayCircle, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { Space } from '@/components/ui/Space'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'
import { useDanmakuStore } from '@/store/danmakuStore'
import type { BilibiliDanmakuItem } from './danmakuEngine'

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export type DanmakuSource =
  'bilibili' | 'bilibili_bangumi' | 'bahamut' | 'dandanplay'

interface DanmakuSearchResult {
  identifier: string
  title: string
  description?: string
  cover?: string
}

interface DanmakuEpisode {
  id: string
  title: string
}

interface DanmakuPayload {
  time: number
  mode: number
  color: number
  content: string
}

const SOURCE_OPTIONS = [
  { label: 'B站视频', value: 'bilibili' },
  { label: 'B站番剧', value: 'bilibili_bangumi' },
  { label: '巴哈姆特', value: 'bahamut' },
  { label: '弹弹play', value: 'dandanplay' },
]

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().accessToken
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function searchDanmaku(
  source: DanmakuSource,
  keyword: string
): Promise<DanmakuSearchResult[]> {
  const res = await fetch(
    `${API_URL}/api/stream/danmaku/search?source=${encodeURIComponent(
      source
    )}&keyword=${encodeURIComponent(keyword)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    results?: DanmakuSearchResult[]
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.results)) {
    throw new Error(data.message || '搜索弹幕失败')
  }
  return data.results
}

async function getDanmakuEpisodes(
  source: DanmakuSource,
  identifier: string
): Promise<DanmakuEpisode[]> {
  const res = await fetch(
    `${API_URL}/api/stream/danmaku/episodes?source=${encodeURIComponent(
      source
    )}&identifier=${encodeURIComponent(identifier)}`,
    { headers: getAuthHeaders() }
  )
  const data = (await res.json()) as {
    success: boolean
    episodes?: DanmakuEpisode[]
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.episodes)) {
    throw new Error(data.message || '获取集数失败')
  }
  return data.episodes
}

async function fetchDanmaku(
  source: DanmakuSource,
  episode: DanmakuEpisode
): Promise<BilibiliDanmakuItem[]> {
  const res = await fetch(`${API_URL}/api/stream/danmaku/fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeaders(),
    },
    body: JSON.stringify({ source, episode }),
  })
  const data = (await res.json()) as {
    success: boolean
    danmaku?: DanmakuPayload[]
    message?: string
  }
  if (!res.ok || !data.success || !Array.isArray(data.danmaku)) {
    throw new Error(data.message || '获取弹幕失败')
  }
  return data.danmaku.map((item, index) => ({
    id: `${source}:${episode.id}:${index}`,
    content: item.content,
    time: item.time,
    mode: item.mode,
    color: item.color,
    size: 25,
  }))
}

interface DanmakuSearchModalProps {
  open: boolean
  onClose: () => void
  defaultSource?: DanmakuSource
  onSourceChange?: (source: DanmakuSource) => void
}

type Step = 'search' | 'episodes'

export function DanmakuSearchModal({
  open,
  onClose,
  defaultSource,
  onSourceChange,
}: DanmakuSearchModalProps) {
  const addTrack = useDanmakuStore((state) => state.addTrack)

  const [source, setSource] = useState<DanmakuSource>(
    defaultSource ?? 'bilibili'
  )

  useEffect(() => {
    if (defaultSource && defaultSource !== source) {
      setSource(defaultSource)
    }
  }, [defaultSource, source])
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<DanmakuSearchResult[]>([])
  const [selectedResult, setSelectedResult] =
    useState<DanmakuSearchResult | null>(null)
  const [episodes, setEpisodes] = useState<DanmakuEpisode[]>([])
  const [step, setStep] = useState<Step>('search')
  const [loading, setLoading] = useState(false)
  const [addingEpisodeId, setAddingEpisodeId] = useState<string | null>(null)

  const hasResult = results.length > 0

  const handleSearch = async () => {
    const trimmed = keyword.trim()
    if (!trimmed) {
      message.warning('请输入搜索关键词')
      return
    }

    setLoading(true)
    setResults([])
    setSelectedResult(null)
    setEpisodes([])
    setStep('search')
    try {
      const list = await searchDanmaku(source, trimmed)
      setResults(list)
      if (list.length === 0) {
        message.info('未找到相关结果')
      }
    } catch (err) {
      console.error('[DanmakuSearchModal] search error:', err)
      message.error(err instanceof Error ? err.message : '搜索失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectResult = async (result: DanmakuSearchResult) => {
    setSelectedResult(result)
    setLoading(true)
    setEpisodes([])
    try {
      const list = await getDanmakuEpisodes(source, result.identifier)
      setEpisodes(list)
      setStep('episodes')
      if (list.length === 0) {
        message.info('该作品暂无可用集数')
      }
    } catch (err) {
      console.error('[DanmakuSearchModal] episodes error:', err)
      message.error(err instanceof Error ? err.message : '获取集数失败')
    } finally {
      setLoading(false)
    }
  }

  const handleAddEpisode = async (episode: DanmakuEpisode) => {
    if (!selectedResult) return
    const trackId = `${source}:${episode.id}`

    setAddingEpisodeId(episode.id)
    try {
      const items = await fetchDanmaku(source, episode)
      const label = `${selectedResult.title} · ${episode.title}`
      addTrack(trackId, label, items, 0)
      message.success(`已添加 ${label} 弹幕轨道（共 ${items.length} 条）`)
      onClose()
    } catch (err) {
      console.error('[DanmakuSearchModal] fetch error:', err)
      message.error(err instanceof Error ? err.message : '添加弹幕轨道失败')
    } finally {
      setAddingEpisodeId(null)
    }
  }

  const handleBack = () => {
    setStep('search')
    setSelectedResult(null)
    setEpisodes([])
  }

  const handleClose = () => {
    if (addingEpisodeId) return
    onClose()
  }

  const modalTitle = useMemo(() => {
    if (step === 'episodes' && selectedResult) {
      return (
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 shrink-0 p-0"
            onClick={handleBack}
            icon={<ChevronLeft className="h-4 w-4" />}
          />
          <span>选择集数</span>
        </div>
      )
    }
    return '搜索弹幕'
  }, [step, selectedResult])

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={modalTitle}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4">
        {step === 'search' && (
          <>
            <Space className="w-full" size="sm" align="end">
              <Select
                label="数据源"
                value={source}
                options={SOURCE_OPTIONS}
                onChange={(value) => {
                  const newSource = value as DanmakuSource
                  setSource(newSource)
                  onSourceChange?.(newSource)
                }}
                className="w-36 shrink-0"
              />
              <Input
                label="关键词"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSearch()
                  }
                }}
                placeholder="输入番剧/视频名称"
                className="flex-1"
              />
              <Button
                variant="primary"
                size="md"
                className="h-9 w-9 shrink-0 p-0"
                loading={loading}
                disabled={!keyword.trim() || loading}
                onClick={handleSearch}
                icon={
                  loading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4" />
                  )
                }
              />
            </Space>

            <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
              {!hasResult && !loading && (
                <div
                  className="flex flex-col items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] border p-6 text-center"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                    borderColor: 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  <Search className="h-8 w-8 opacity-40" />
                  <Text type="secondary" className="text-xs">
                    输入关键词并搜索以查找弹幕源
                  </Text>
                </div>
              )}

              {results.map((result) => (
                <button
                  key={result.identifier}
                  type="button"
                  onClick={() => handleSelectResult(result)}
                  className="flex items-start gap-3 rounded-[var(--md-sys-shape-corner)] border p-2.5 text-left transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                    borderColor: 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  <div
                    className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-highest)]"
                    style={{
                      backgroundImage: result.cover
                        ? `url(${result.cover})`
                        : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }}
                  >
                    {!result.cover && <Tv className="h-5 w-5 opacity-40" />}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <Text className="truncate text-sm font-medium">
                      {result.title}
                    </Text>
                    {result.description && (
                      <Text type="secondary" className="line-clamp-2 text-xs">
                        {result.description}
                      </Text>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'episodes' && (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
            {episodes.length === 0 && !loading && (
              <Text type="secondary" className="py-6 text-center text-xs">
                暂无可用集数
              </Text>
            )}
            {episodes.map((episode) => (
              <div
                key={episode.id}
                className="flex items-center justify-between gap-3 rounded-[var(--md-sys-shape-corner)] border p-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container-high)',
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <PlayCircle className="h-4 w-4 shrink-0 opacity-60" />
                  <Text className="truncate text-sm">{episode.title}</Text>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="h-7 shrink-0 px-2.5 text-xs"
                  loading={addingEpisodeId === episode.id}
                  disabled={!!addingEpisodeId}
                  onClick={() => handleAddEpisode(episode)}
                >
                  添加
                </Button>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center gap-2 py-2 text-[var(--md-sys-color-on-surface-variant)]">
            <Loader2 className="h-4 w-4 animate-spin" />
            <Text type="secondary" className="text-xs">
              加载中…
            </Text>
          </div>
        )}
      </div>
    </Modal>
  )
}
