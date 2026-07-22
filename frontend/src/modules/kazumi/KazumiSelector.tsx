import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Search,
  Tv,
  Play,
  Loader2,
  LayoutGrid,
  List,
  Clapperboard,
  ChevronDown,
} from 'lucide-react'
import { FullscreenOverlay } from '@/components/ui/FullscreenOverlay'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { message } from '@/components/ui/message'
import {
  getKazumiSources,
  searchKazumi,
  getKazumiEpisodes,
  type KazumiSource,
  type KazumiSearchResult,
  type KazumiEpisode,
} from '@/modules/kazumi'
import { cn } from '@/lib/utils'

interface KazumiSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectEpisode: (
    sourceId: string,
    episode: KazumiEpisode,
    title: string
  ) => void
  disabled?: boolean
}

export function KazumiSelector({
  open,
  onOpenChange,
  onSelectEpisode,
  disabled,
}: KazumiSelectorProps) {
  const [sources, setSources] = useState<KazumiSource[]>([])
  const [selectedSource, setSelectedSource] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<KazumiSearchResult[]>([])
  const [episodesMap, setEpisodesMap] = useState<
    Record<string, KazumiEpisode[]>
  >({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loadingSources, setLoadingSources] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(
    null
  )
  const [viewMode, setViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('kazumi-selector-view-mode')
    return saved === 'list' ? 'list' : 'tile'
  })

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时加载数据源
    setLoadingSources(true)
    setSourcesError(null)
    getKazumiSources()
      .then((data) => {
        setSources(data)
        if (data.length > 0 && !selectedSource) {
          setSelectedSource(data[0].id)
        }
        if (data.length === 0) {
          setSourcesError('未找到可用数据源，请在管理面板检查 Kazumi 规则配置')
        }
      })
      .catch((err) => {
        console.error('[KazumiSelector] load sources error:', err)
        setSourcesError(
          err instanceof Error ? err.message : '加载数据源失败'
        )
      })
      .finally(() => setLoadingSources(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 open 变化时加载
  }, [open])

  useEffect(() => {
    if (open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 关闭时清理选中态
    setSelectedEpisodeId(null)
  }, [open])

  const sourceOptions = useMemo(
    () => sources.map((s) => ({ value: s.id, label: s.name })),
    [sources]
  )

  const selectedSourceLabel = useMemo(() => {
    return sources.find((s) => s.id === selectedSource)?.name || selectedSource
  }, [sources, selectedSource])

  const handleSearch = useCallback(async () => {
    if (!selectedSource) {
      message.warning('请选择数据源')
      return
    }
    if (!keyword.trim()) {
      message.warning('请输入搜索关键词')
      return
    }
    setSearching(true)
    setSearchResults([])
    setExpandedId(null)
    setEpisodesMap({})
    try {
      const results = await searchKazumi(selectedSource, keyword.trim())
      setSearchResults(results)
      if (results.length === 0) {
        message.info('未找到匹配结果')
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '搜索番剧失败'
      if (
        errMsg.includes('Cloudflare') ||
        errMsg.includes('403') ||
        errMsg.includes('503') ||
        errMsg.includes('请求失败') ||
        errMsg.includes('超时') ||
        errMsg.includes('fetch failed')
      ) {
        message.warning(
          `${selectedSourceLabel} 无法访问，请尝试切换其他数据源`
        )
      } else {
        message.error(errMsg)
      }
      console.error('[KazumiSelector] search error:', err)
    } finally {
      setSearching(false)
    }
  }, [selectedSource, keyword])

  const handleToggleExpand = useCallback(
    async (result: KazumiSearchResult) => {
      if (expandedId === result.id) {
        setExpandedId(null)
        return
      }
      setExpandedId(result.id)
      if (episodesMap[result.id]) return

      setLoadingEpisodes(true)
      try {
        const episodes = await getKazumiEpisodes(result.source, result.id)
        setEpisodesMap((prev) => ({ ...prev, [result.id]: episodes }))
      } catch (err) {
        console.error('[KazumiSelector] load episodes error:', err)
        message.error(err instanceof Error ? err.message : '获取集数失败')
      } finally {
        setLoadingEpisodes(false)
      }
    },
    [expandedId, episodesMap]
  )

  const handleSelectEpisode = useCallback(
    (result: KazumiSearchResult, episode: KazumiEpisode) => {
      if (disabled) {
        message.info('当前不可用')
        return
      }
      setSelectedEpisodeId(episode.id)
      const title = `${result.title} - ${episode.title}`
      onSelectEpisode(result.source, episode, title)
      onOpenChange(false)
      setTimeout(() => setSelectedEpisodeId(null), 500)
    },
    [disabled, onSelectEpisode, onOpenChange]
  )

  return (
    <FullscreenOverlay
      open={open}
      onClose={() => onOpenChange(false)}
      className="max-w-5xl"
      title={
        <div className="flex items-center gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              background:
                'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent))',
            }}
          >
            <Clapperboard
              className="h-5 w-5"
              style={{ color: 'var(--md-sys-color-primary)' }}
            />
          </div>
          <div className="flex min-w-0 flex-col">
            <Text className="text-base font-semibold leading-tight">
              Kazumi 番剧源
            </Text>
            <Text
              type="secondary"
              className="text-[10px] uppercase tracking-wide"
            >
              {loadingSources
                ? '加载中'
                : sources.length > 0
                  ? `${sources.length} 个数据源可用`
                  : '暂无数据源'}
            </Text>
          </div>
        </div>
      }
    >
      <div className="flex h-full flex-col">
        {/* 搜索区 */}
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="sm:w-52">
            <Text
              type="secondary"
              className="mb-1.5 block text-[10px] uppercase tracking-wide"
            >
              数据源
            </Text>
            <Select
              value={selectedSource}
              options={sourceOptions}
              onChange={(value) => {
                setSelectedSource(value)
                setSearchResults([])
                setExpandedId(null)
                setEpisodesMap({})
              }}
              disabled={loadingSources || sourceOptions.length === 0}
              placeholder="选择数据源"
            />
            {sourcesError && (
              <p className="mt-1.5 text-xs text-[var(--md-sys-color-error)]">
                {sourcesError}
              </p>
            )}
          </div>
          <div className="flex-1">
            <Text
              type="secondary"
              className="mb-1.5 block text-[10px] uppercase tracking-wide"
            >
              关键词
            </Text>
            <Input
              size="md"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="输入番剧名称搜索"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSearch()
                }
              }}
            />
          </div>
          <Button
            variant="primary"
            size="md"
            icon={<Search className="h-4 w-4" />}
            onClick={() => void handleSearch()}
            loading={searching}
            disabled={searching || !selectedSource}
            className="h-[42px] shrink-0"
          >
            搜索
          </Button>
        </div>

        {/* 工具栏 */}
        <div className="mb-3 flex items-center justify-between">
          <Text type="secondary" className="text-xs">
            {searchResults.length > 0
              ? `共 ${searchResults.length} 条结果`
              : searching
                ? '搜索中...'
                : '输入关键词开始搜索'}
          </Text>
          <div
            className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5"
            style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
          >
            <button
              type="button"
              onClick={() => {
                setViewMode('list')
                localStorage.setItem('kazumi-selector-view-mode', 'list')
              }}
              className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-3 py-1.5 text-xs font-medium transition-all"
              style={{
                backgroundColor:
                  viewMode === 'list'
                    ? 'var(--md-sys-color-primary-container)'
                    : 'transparent',
                color:
                  viewMode === 'list'
                    ? 'var(--md-sys-color-on-primary-container)'
                    : 'var(--md-sys-color-on-surface-variant)',
              }}
              aria-label="列表视图"
              title="列表视图"
            >
              <List className="h-3.5 w-3.5" />
              <span>列表</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('tile')
                localStorage.setItem('kazumi-selector-view-mode', 'tile')
              }}
              className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-3 py-1.5 text-xs font-medium transition-all"
              style={{
                backgroundColor:
                  viewMode === 'tile'
                    ? 'var(--md-sys-color-primary-container)'
                    : 'transparent',
                color:
                  viewMode === 'tile'
                    ? 'var(--md-sys-color-on-primary-container)'
                    : 'var(--md-sys-color-on-surface-variant)',
              }}
              aria-label="平铺视图"
              title="平铺视图"
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              <span>平铺</span>
            </button>
          </div>
        </div>

        {/* 结果区 */}
        <div
          className={cn(
            'flex-1 overflow-y-auto',
            viewMode === 'tile'
              ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 content-start'
              : 'flex flex-col gap-3'
          )}
        >
          {searchResults.length === 0 && (
            <div
              className={cn(
                'flex items-center justify-center',
                viewMode === 'tile' ? 'col-span-full' : 'w-full'
              )}
            >
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                {searching ? (
                  <div
                    className="flex h-14 w-14 items-center justify-center rounded-full"
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <Loader2
                      className="h-6 w-6 animate-spin"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  </div>
                ) : (
                  <div
                    className="flex h-14 w-14 items-center justify-center rounded-full"
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <Tv
                      className="h-6 w-6"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    />
                  </div>
                )}
                <Paragraph type="secondary" className="m-0 text-xs">
                  {searching
                    ? '正在搜索...'
                    : keyword
                      ? '暂无结果，换个关键词试试'
                      : '输入关键词开始搜索番剧'}
                </Paragraph>
              </div>
            </div>
          )}

          {searchResults.map((result) => {
            const expanded = expandedId === result.id
            const episodes = episodesMap[result.id] || []

            return (
              <div
                key={result.id}
                className={cn(
                  'zen-card overflow-hidden rounded-[var(--md-sys-shape-corner)] border transition-all',
                  expanded
                    ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-surface-container-high)]'
                    : 'border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container)]'
                )}
              >
                <button
                  type="button"
                  onClick={() => void handleToggleExpand(result)}
                  className={cn(
                    'flex w-full gap-3 p-3 text-left',
                    viewMode === 'tile' ? 'flex-col' : 'flex-row'
                  )}
                >
                  {result.cover ? (
                    <img
                      src={result.cover}
                      alt={result.title}
                      className={cn(
                        'flex-shrink-0 rounded-[var(--md-sys-shape-corner)] object-cover',
                        viewMode === 'tile'
                          ? 'aspect-[3/4] w-full'
                          : 'h-[110px] w-[80px]'
                      )}
                    />
                  ) : (
                    <div
                      className={cn(
                        'flex flex-shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]',
                        viewMode === 'tile'
                          ? 'aspect-[3/4] w-full'
                          : 'h-[110px] w-[80px]'
                      )}
                      style={{
                        backgroundColor:
                          'var(--md-sys-color-surface-container-high)',
                      }}
                    >
                      <Tv
                        className={viewMode === 'tile' ? 'h-8 w-8' : 'h-6 w-6'}
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      />
                    </div>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Text
                      className={cn(
                        'block font-semibold leading-snug',
                        viewMode === 'tile' ? 'text-sm' : 'text-sm'
                      )}
                      title={result.title}
                    >
                      {result.title}
                    </Text>
                    {result.description && (
                      <Paragraph
                        type="secondary"
                        className="m-0 mt-1 line-clamp-2 text-xs"
                        title={result.description}
                      >
                        {result.description}
                      </Paragraph>
                    )}
                    <div
                      className="mt-auto flex items-center gap-1 pt-2 text-[10px] uppercase tracking-wide"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      {loadingEpisodes && expanded ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>加载中</span>
                        </>
                      ) : expanded ? (
                        <>
                          <ChevronDown className="h-3 w-3" />
                          <span>收起</span>
                        </>
                      ) : (
                        <>
                          <Play className="h-3 w-3" />
                          <span>展开集数</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>

                {expanded && (
                  <div
                    className="border-t px-3 pb-3"
                    style={{
                      borderColor: 'var(--md-sys-color-outline-variant)',
                    }}
                  >
                    {episodes.length === 0 && !loadingEpisodes && (
                      <div className="flex h-16 items-center justify-center">
                        <Paragraph
                          type="secondary"
                          className="m-0 text-xs"
                        >
                          暂无集数信息
                        </Paragraph>
                      </div>
                    )}
                    {loadingEpisodes && episodes.length === 0 && (
                      <div className="flex h-16 items-center justify-center">
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          style={{ color: 'var(--md-sys-color-primary)' }}
                        />
                      </div>
                    )}
                    {episodes.length > 0 && (
                      <div className="mt-2 grid max-h-[200px] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                        {episodes.map((episode) => (
                          <button
                            key={episode.id}
                            type="button"
                            onClick={() => handleSelectEpisode(result, episode)}
                            disabled={!!selectedEpisodeId}
                            className="group flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] border border-transparent p-2 text-left transition-all hover:border-[var(--md-sys-color-primary)] hover:bg-[var(--md-sys-color-primary-container)] disabled:opacity-60"
                          >
                            <div
                              className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold transition-colors group-hover:text-[var(--md-sys-color-on-primary)]"
                              style={{
                                backgroundColor:
                                  'var(--md-sys-color-surface-container-high)',
                                color: 'var(--md-sys-color-primary)',
                              }}
                            >
                              {episode.episodeNumber || '-'}
                            </div>
                            <span
                              className="min-w-0 flex-1 truncate text-xs font-medium"
                              title={episode.title}
                            >
                              {episode.title}
                            </span>
                            {selectedEpisodeId === episode.id ? (
                              <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                            ) : (
                              <Play
                                className="h-3 w-3 flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                                style={{ color: 'var(--md-sys-color-primary)' }}
                              />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </FullscreenOverlay>
  )
}
