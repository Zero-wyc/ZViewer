import {
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react'
import {
  Search,
  Loader2,
  Tv,
  PlayCircle,
  ChevronLeft,
  Play,
  ThumbsUp,
  Coins,
  ListVideo,
  Plus,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Space } from '@/components/ui/Space'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Modal } from '@/components/ui/Modal'
import { useDanmakuStore } from '@/store/danmakuStore'
import {
  searchDanmaku,
  getDanmakuEpisodes,
  fetchDanmaku,
} from '@/modules/danmaku/api'
import { buildBilibiliImageProxyUrl, isBilibiliImageUrl } from './resolveSource'
import {
  DANMAKU_SOURCE_OPTIONS,
  type DanmakuSource,
  type DanmakuSearchResult,
  type DanmakuEpisode,
} from '@/modules/danmaku/types'

/** 格式化数字：万 / 亿 */
function formatCount(n: number | undefined): string {
  if (n == null) return '-'
  if (n >= 1_0000_0000) return `${(n / 1_0000_0000).toFixed(1)}亿`
  if (n >= 1_0000) return `${(n / 1_0000).toFixed(1)}万`
  return String(n)
}

interface DanmakuSearchModalProps {
  open: boolean
  onClose: () => void
  defaultSource?: DanmakuSource
  onSourceChange?: (source: DanmakuSource) => void
  /** 打开弹窗时预填的关键词，传入后会自动触发搜索 */
  initialKeyword?: string
}

type Step = 'search' | 'episodes'

export function DanmakuSearchModal({
  open,
  onClose,
  defaultSource,
  onSourceChange,
  initialKeyword,
}: DanmakuSearchModalProps) {
  const addTrack = useDanmakuStore((state) => state.addTrack)

  const [source, setSource] = useState<DanmakuSource>(
    defaultSource ?? 'bilibili'
  )

  useEffect(() => {
    if (defaultSource && defaultSource !== source) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 同步 defaultSource 到内部状态
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

  const performSearch = useCallback(
    async (searchSource: DanmakuSource, searchKeyword: string) => {
      setLoading(true)
      setResults([])
      setSelectedResult(null)
      setEpisodes([])
      setStep('search')
      try {
        const list = await searchDanmaku(searchSource, searchKeyword)
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
    },
    []
  )

  const handleSearch = () => {
    const trimmed = keyword.trim()
    if (!trimmed) {
      message.warning('请输入搜索关键词')
      return
    }
    void performSearch(source, trimmed)
  }

  // 弹窗打开时若有 initialKeyword，自动填入并触发搜索
  const lastAutoSearchRef = useRef<string | null>(null)
  useEffect(() => {
    if (open && initialKeyword && lastAutoSearchRef.current !== initialKeyword) {
      lastAutoSearchRef.current = initialKeyword
      setKeyword(initialKeyword)
      const searchSource = defaultSource ?? 'bilibili'
      void performSearch(searchSource, initialKeyword)
    }
    if (!open) {
      lastAutoSearchRef.current = null
    }
  }, [open, initialKeyword, defaultSource, performSearch])

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
      addTrack(trackId, label, source, items, 0)
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

  const modalTitle = '搜索弹幕'

  // 右侧集数面板是否展开（step === 'episodes'）
  const episodesOpen = step === 'episodes' && !!selectedResult

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={modalTitle}
      className="max-w-4xl"
    >
      <div
        className="grid h-[70vh] gap-3"
        style={{
          gridTemplateColumns: episodesOpen
            ? '1fr 340px'
            : '1fr 0fr',
          transition: 'grid-template-columns 0.4s var(--ease-out-expo)',
        }}
      >
        {/* 左栏：搜索区（常驻显示） */}
        <div className="flex min-w-0 flex-col gap-3">
          <Space className="w-full" size="sm" align="end">
            <Select
              label="数据源"
              value={source}
              options={DANMAKU_SOURCE_OPTIONS}
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
              placeholder="输入番剧/视频名称或 BV 号"
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

          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {!hasResult && !loading && (
              <div
                className="flex flex-1 flex-col items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] border p-6 text-center"
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

            {results.map((result) => {
              const stats = result.stats
              // B站 CDN 封面有防盗链 + ORB 限制，按 URL 域名判断是否走代理
              // （巴哈姆特等源也可能热链 B站 CDN 图片）
              const coverUrl = result.cover
                ? isBilibiliImageUrl(result.cover)
                  ? buildBilibiliImageProxyUrl(result.cover)
                  : result.cover
                : ''
              const isActive = selectedResult?.identifier === result.identifier
              return (
                <div
                  key={result.identifier}
                  className="flex items-start gap-3 rounded-[var(--md-sys-shape-corner)] border p-2.5 transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{
                    backgroundColor: isActive
                      ? 'var(--md-sys-color-primary-container)'
                      : 'var(--md-sys-color-surface-container-high)',
                    borderColor: isActive
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  {/* 封面 */}
                  <div
                    className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-highest)]"
                    style={{
                      backgroundImage: coverUrl
                        ? `url(${coverUrl})`
                        : undefined,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }}
                  >
                    {!coverUrl && <Tv className="h-5 w-5 opacity-40" />}
                  </div>

                  {/* 标题 + 统计 */}
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Text className="line-clamp-2 text-sm font-medium leading-tight">
                      {result.title}
                    </Text>
                    {result.description && (
                      <Text
                        type="secondary"
                        className="line-clamp-1 text-[11px] leading-tight"
                      >
                        {result.description}
                      </Text>
                    )}
                    {stats && (
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                        <span className="flex items-center gap-0.5">
                          <Play className="h-3 w-3" />
                          {formatCount(stats.play)}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <ThumbsUp className="h-3 w-3" />
                          {formatCount(stats.like)}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <Coins className="h-3 w-3" />
                          {formatCount(stats.coin)}
                        </span>
                        <span className="flex items-center gap-0.5">
                          <ListVideo className="h-3 w-3" />
                          {formatCount(stats.danmaku)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* 右侧添加按钮 */}
                  <Button
                    variant={isActive ? 'secondary' : 'primary'}
                    size="sm"
                    className="h-8 w-8 shrink-0 p-0"
                    onClick={() => handleSelectResult(result)}
                    icon={
                      isActive ? (
                        <ChevronLeft className="h-4 w-4" />
                      ) : (
                        <Plus className="h-4 w-4" />
                      )
                    }
                  />
                </div>
              )
            })}
          </div>
        </div>

        {/* 右栏：集数面板（从右侧滑入） */}
        <div
          className="flex min-w-0 flex-col overflow-hidden"
          style={{
            opacity: episodesOpen ? 1 : 0,
            transform: episodesOpen
              ? 'translateX(0)'
              : 'translateX(16px)',
            transition:
              'opacity 0.32s var(--ease-out-expo), transform 0.4s var(--ease-out-expo)',
          }}
        >
          {episodesOpen && (
            <div className="flex h-full flex-col border-l border-[var(--md-sys-color-outline-variant)] pl-3">
            <div className="flex items-center justify-between gap-2 pb-2">
              <div className="flex min-w-0 flex-col">
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  选择集数
                </Text>
                <Text className="truncate text-sm font-medium">
                  {selectedResult?.title}
                </Text>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0"
                onClick={handleBack}
                icon={<X className="h-4 w-4" />}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {episodes.length === 0 && !loading && (
                <div className="flex flex-1 items-center justify-center">
                  <Text type="secondary" className="text-xs">
                    暂无可用集数
                  </Text>
                </div>
              )}
              {episodes.map((episode) => (
                <div
                  key={episode.id}
                  className="flex items-center justify-between gap-3 rounded-[var(--md-sys-shape-corner)] border p-3"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                    borderColor: 'var(--md-sys-color-outline-variant)',
                  }}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <PlayCircle className="h-4 w-4 shrink-0 opacity-60" />
                    <Text className="truncate text-sm">
                      {episode.title}
                    </Text>
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

              {loading && (
                <div className="flex items-center justify-center gap-2 py-2 text-[var(--md-sys-color-on-surface-variant)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <Text type="secondary" className="text-xs">
                    加载中…
                  </Text>
                </div>
              )}
            </div>
            </div>
          )}
        </div>
      </div>

      {/* 左栏 loading 指示（独立于右侧面板） */}
      {loading && step === 'search' && (
        <div className="mt-2 flex items-center justify-center gap-2 py-2 text-[var(--md-sys-color-on-surface-variant)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          <Text type="secondary" className="text-xs">
            加载中…
          </Text>
        </div>
      )}
    </Modal>
  )
}
