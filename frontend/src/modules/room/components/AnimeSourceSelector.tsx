import { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Tv, Play, X, Loader2, LayoutGrid, List } from 'lucide-react'
import { FullscreenOverlay } from '@/components/ui/FullscreenOverlay'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { message } from '@/components/ui/message'
import {
  getAnimeSources,
  searchAnime,
  getAnimeEpisodes,
  resolveAnimeEpisode,
  type AnimeSearchResult,
  type AnimeEpisode,
  type AnimeSource,
} from '@/modules/room/watch-together/resolveSource'
import { cn } from '@/lib/utils'

interface AnimeSourceSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectEpisode: (
    sourceId: string,
    episode: AnimeEpisode,
    title: string
  ) => void
  disabled?: boolean
}

export function AnimeSourceSelector({
  open,
  onOpenChange,
  onSelectEpisode,
  disabled,
}: AnimeSourceSelectorProps) {
  const [sources, setSources] = useState<AnimeSource[]>([])
  const [selectedSource, setSelectedSource] = useState('')
  const [keyword, setKeyword] = useState('')
  const [searchResults, setSearchResults] = useState<AnimeSearchResult[]>([])
  const [episodesMap, setEpisodesMap] = useState<
    Record<string, AnimeEpisode[]>
  >({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loadingSources, setLoadingSources] = useState(false)
  const [searching, setSearching] = useState(false)
  const [loadingEpisodes, setLoadingEpisodes] = useState(false)
  const [resolving, setResolving] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('anime-source-selector-view-mode')
    return saved === 'tile' ? 'tile' : 'list'
  })

  useEffect(() => {
    if (!open) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开时加载数据源
    setLoadingSources(true)
    getAnimeSources()
      .then((data) => {
        setSources(data)
        if (data.length > 0 && !selectedSource) {
          setSelectedSource(data[0].id)
        }
      })
      .catch((err) => {
        console.error('[AnimeSourceSelector] load sources error:', err)
        message.error(err instanceof Error ? err.message : '加载番剧数据源失败')
      })
      .finally(() => setLoadingSources(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在 open 变化时加载，不依赖 selectedSource
  }, [open])

  const sourceOptions = useMemo(
    () => sources.map((s) => ({ value: s.id, label: s.name })),
    [sources]
  )

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
      const results = await searchAnime(selectedSource, keyword.trim())
      setSearchResults(results)
    } catch (err) {
      console.error('[AnimeSourceSelector] search error:', err)
      message.error(err instanceof Error ? err.message : '搜索番剧失败')
    } finally {
      setSearching(false)
    }
  }, [selectedSource, keyword])

  const handleToggleExpand = useCallback(
    async (result: AnimeSearchResult) => {
      if (expandedId === result.id) {
        setExpandedId(null)
        return
      }
      setExpandedId(result.id)
      if (episodesMap[result.id]) return

      setLoadingEpisodes(true)
      try {
        const episodes = await getAnimeEpisodes(result.source, result.id)
        setEpisodesMap((prev) => ({ ...prev, [result.id]: episodes }))
      } catch (err) {
        console.error('[AnimeSourceSelector] load episodes error:', err)
        message.error(err instanceof Error ? err.message : '获取集数失败')
      } finally {
        setLoadingEpisodes(false)
      }
    },
    [expandedId, episodesMap]
  )

  const handleSelectEpisode = useCallback(
    async (result: AnimeSearchResult, episode: AnimeEpisode) => {
      if (disabled) {
        message.info('当前不可用')
        return
      }
      setResolving(episode.id)
      try {
        await resolveAnimeEpisode(result.source, episode)
        const title = `${result.title} - ${episode.title}`
        onSelectEpisode(result.source, episode, title)
        onOpenChange(false)
      } catch (err) {
        console.error('[AnimeSourceSelector] resolve error:', err)
        message.error(err instanceof Error ? err.message : '解析播放地址失败')
      } finally {
        setResolving(null)
      }
    },
    [disabled, onSelectEpisode, onOpenChange]
  )

  return (
    <FullscreenOverlay
      open={open}
      onClose={() => onOpenChange(false)}
      title="ani-subs 番剧源"
    >
      <div className="flex h-full flex-col">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Select
              label="番剧数据源"
              value={selectedSource}
              options={sourceOptions}
              onChange={(value) => {
                setSelectedSource(value)
                setSearchResults([])
                setExpandedId(null)
                setEpisodesMap({})
              }}
              disabled={loadingSources || sourceOptions.length === 0}
            />
          </div>
          <div className="flex-[2]">
            <Input
              label=""
              size="sm"
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
            size="sm"
            icon={<Search className="h-4 w-4" />}
            onClick={() => void handleSearch()}
            loading={searching}
            disabled={searching || !selectedSource}
          >
            搜索
          </Button>
        </div>

        <div className="mb-3 flex items-center justify-between">
          <Text type="secondary" className="text-xs">
            {searchResults.length > 0
              ? `共 ${searchResults.length} 条结果`
              : '输入关键词开始搜索'}
          </Text>
          <div
            className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5"
            style={{ borderColor: 'var(--md-sys-color-outline)' }}
          >
            <button
              type="button"
              onClick={() => {
                setViewMode('list')
                localStorage.setItem('anime-source-selector-view-mode', 'list')
              }}
              className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
              style={{
                backgroundColor:
                  viewMode === 'list'
                    ? 'var(--md-sys-color-primary-container)'
                    : 'transparent',
                color:
                  viewMode === 'list'
                    ? 'var(--md-sys-color-on-primary-container)'
                    : 'var(--md-sys-color-on-surface)',
              }}
              aria-label="列表视图"
              title="列表视图"
            >
              <List className="h-4 w-4" />
              <span>列表</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('tile')
                localStorage.setItem('anime-source-selector-view-mode', 'tile')
              }}
              className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
              style={{
                backgroundColor:
                  viewMode === 'tile'
                    ? 'var(--md-sys-color-primary-container)'
                    : 'transparent',
                color:
                  viewMode === 'tile'
                    ? 'var(--md-sys-color-on-primary-container)'
                    : 'var(--md-sys-color-on-surface)',
              }}
              aria-label="平铺视图"
              title="平铺视图"
            >
              <LayoutGrid className="h-4 w-4" />
              <span>平铺</span>
            </button>
          </div>
        </div>

        <div
          className={cn(
            'flex-1 overflow-y-auto',
            viewMode === 'tile'
              ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 content-start'
              : 'flex flex-col gap-3'
          )}
        >
          {searchResults.map((result) => {
            const expanded = expandedId === result.id
            const episodes = episodesMap[result.id] || []

            return (
              <div
                key={result.id}
                className={cn(
                  'overflow-hidden rounded-[var(--md-sys-shape-corner)] border transition-all',
                  expanded
                    ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-surface-container-high)]'
                    : 'border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container)] hover:border-[var(--md-sys-color-outline)]'
                )}
              >
                <button
                  type="button"
                  onClick={() => void handleToggleExpand(result)}
                  className={cn(
                    'flex w-full gap-3 p-3 text-left sm:p-4',
                    viewMode === 'tile' ? 'flex-col' : 'flex-row'
                  )}
                >
                  {result.cover ? (
                    <img
                      src={result.cover}
                      alt={result.title}
                      className={cn(
                        'flex-shrink-0 rounded-md object-cover',
                        viewMode === 'tile'
                          ? 'aspect-[3/4] w-full'
                          : 'h-[120px] w-[90px]'
                      )}
                    />
                  ) : (
                    <div
                      className={cn(
                        'flex flex-shrink-0 items-center justify-center rounded-md',
                        viewMode === 'tile'
                          ? 'aspect-[3/4] w-full'
                          : 'h-[120px] w-[90px]'
                      )}
                      style={{
                        backgroundColor:
                          'var(--md-sys-color-surface-container-high)',
                      }}
                    >
                      <Tv
                        className={
                          viewMode === 'tile' ? 'h-10 w-10' : 'h-8 w-8'
                        }
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      />
                    </div>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col justify-center">
                    <Text
                      className={cn(
                        'block font-semibold',
                        viewMode === 'tile' ? 'text-sm' : 'text-base'
                      )}
                      title={result.title}
                    >
                      {result.title}
                    </Text>
                    {result.description && (
                      <Paragraph
                        type="secondary"
                        className={cn(
                          'm-0 text-xs',
                          viewMode === 'tile'
                            ? 'mt-1 line-clamp-2'
                            : 'mt-1 line-clamp-2'
                        )}
                        title={result.description}
                      >
                        {result.description}
                      </Paragraph>
                    )}
                    <div className="mt-auto flex items-center gap-1 pt-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      <span>{expanded ? '收起' : '展开集数'}</span>
                      {loadingEpisodes && expanded ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : expanded ? (
                        <X className="h-3 w-3" />
                      ) : (
                        <Play className="h-3 w-3" />
                      )}
                    </div>
                  </div>
                </button>

                {expanded && (
                  <div className="border-t border-[var(--md-sys-color-outline-variant)] px-3 pb-3 sm:px-4">
                    {episodes.length === 0 && !loadingEpisodes && (
                      <div className="flex h-20 items-center justify-center">
                        <Paragraph type="secondary" className="m-0 text-xs">
                          暂无集数信息
                        </Paragraph>
                      </div>
                    )}
                    <div className="mt-2 grid max-h-[220px] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                      {episodes.map((episode) => (
                        <button
                          key={episode.id}
                          type="button"
                          onClick={() =>
                            void handleSelectEpisode(result, episode)
                          }
                          disabled={!!resolving}
                          className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] border border-transparent p-2 text-left transition-all hover:border-[var(--md-sys-color-primary)] hover:bg-[var(--md-sys-color-primary-container)] disabled:opacity-60"
                        >
                          <div
                            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium"
                            style={{
                              backgroundColor:
                                'var(--md-sys-color-primary-container)',
                              color: 'var(--md-sys-color-primary)',
                            }}
                          >
                            {episode.episodeNumber || '-'}
                          </div>
                          <span
                            className="min-w-0 flex-1 truncate text-xs"
                            title={episode.title}
                          >
                            {episode.title}
                          </span>
                          {resolving === episode.id ? (
                            <Loader2 className="h-3 w-3 flex-shrink-0 animate-spin" />
                          ) : (
                            <Play
                              className="h-3 w-3 flex-shrink-0"
                              style={{
                                color: 'var(--md-sys-color-on-surface-variant)',
                              }}
                            />
                          )}
                        </button>
                      ))}
                    </div>
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
