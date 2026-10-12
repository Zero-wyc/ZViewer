import { useCallback, useEffect, useRef, useState } from 'react'
import EmbyBrowser from '@/modules/emby/EmbyBrowser'
import type { EmbyDirectoryEntry } from '@/modules/emby/types'
import type {
  AniSubsEpisode,
  AniSubsSearchResult,
  AniSubsSource,
} from '@/modules/anisubs'
import { Select } from '@/components/ui/Select'
import { message } from '@/components/ui/message'
import { AnimePoster } from './AnimePoster'
import type { AnimeEpisodeSelection } from './AnimeEpisodePicker'

export interface AnimeSourceBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectEpisode: (
    sourceId: string,
    episode: AniSubsEpisode,
    title: string
  ) => void
  onSelectEpisodes: (items: AnimeEpisodeSelection[]) => Promise<string[]>
  disabled?: boolean
}

interface Props extends AnimeSourceBrowserProps {
  kind: 'kazumi' | 'anisubs'
  title: string
  getSources: () => Promise<AniSubsSource[]>
  search: (source: string, keyword: string) => Promise<AniSubsSearchResult[]>
  getEpisodes: (source: string, identifier: string) => Promise<AniSubsEpisode[]>
}

/** Same cards, navigation and confirmation footer as Emby/Jellyfin. */
export function AnimeSourceBrowser({
  open,
  onOpenChange,
  onSelectEpisodes,
  disabled,
  kind,
  title,
  getSources,
  search,
  getEpisodes,
}: Props) {
  const [sources, setSources] = useState<AniSubsSource[]>([])
  const [sourceId, setSourceId] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [addingSeries, setAddingSeries] = useState(false)
  const shows = useRef<AniSubsSearchResult[]>([])
  const selections = useRef(new Map<string, AnimeEpisodeSelection>())
  const posters = useRef(new Map<string, { cover?: string; referer: string }>())
  const episodes = useRef(new Map<string, EmbyDirectoryEntry[]>())
  const sourceGeneration = useRef(0)
  const failedSeries = useRef(new Map<string, string[]>())

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getSources()
      .then((items) => {
        if (cancelled) return
        setSources(items)
        setSourceId((current) =>
          items.some((item) => item.id === current)
            ? current
            : items[0]?.id || ''
        )
        setSourceError(
          items.length ? '' : '未找到可用数据源，请在管理面板检查订阅配置'
        )
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setSourceError(err instanceof Error ? err.message : '加载数据源失败')
      })
    return () => {
      cancelled = true
    }
  }, [getSources, open])

  const mapShows = useCallback(
    (items: AniSubsSearchResult[]): EmbyDirectoryEntry[] =>
      items.map((show) => {
        posters.current.set(show.id, { cover: show.cover, referer: show.id })
        return {
          name: show.title,
          path: show.id,
          type: 'directory',
          embyType: 'Series',
        }
      }),
    []
  )

  const doSearch = useCallback(
    async (_mountId: number, keyword: string) => {
      const generation = ++sourceGeneration.current
      const items = await search(sourceId, keyword)
      if (generation !== sourceGeneration.current) return []
      shows.current = items
      selections.current.clear()
      episodes.current.clear()
      failedSeries.current.clear()
      posters.current.clear()
      return mapShows(items)
    },
    [mapShows, search, sourceId]
  )

  const browse = useCallback(
    async (_mountId: number, path?: string): Promise<EmbyDirectoryEntry[]> => {
      if (!path) return mapShows(shows.current)
      const cached = episodes.current.get(path)
      if (cached) return cached
      const show = shows.current.find((item) => item.id === path)
      if (!show) return []
      const generation = sourceGeneration.current
      const items = await getEpisodes(sourceId, path)
      if (generation !== sourceGeneration.current) return []
      const entries = items.map((episode): EmbyDirectoryEntry => {
        const key = JSON.stringify([path, episode.id])
        selections.current.set(key, {
          sourceId,
          episode,
          title: `${show.title} - ${episode.title}`,
        })
        posters.current.set(key, { cover: show.cover, referer: show.id })
        return {
          name: /^\d+(?:\.\d+)?$/.test(episode.title)
            ? `第${episode.title}集`
            : episode.title,
          path: key,
          type: 'file',
        }
      })
      episodes.current.set(path, entries)
      return entries
    },
    [getEpisodes, mapShows, sourceId]
  )

  const addFiles = useCallback(
    async (paths: string[]) => {
      const items = paths.flatMap((path) => {
        const item = selections.current.get(path)
        return item ? [item] : []
      })
      try {
        const added = await onSelectEpisodes(items)
        return paths.filter((path) => {
          const item = selections.current.get(path)
          return item && added.includes(item.episode.id)
        })
      } catch (err) {
        message.error(err instanceof Error ? err.message : '添加失败，请重试')
        return []
      }
    },
    [onSelectEpisodes]
  )

  const addSeries = useCallback(
    async (entry: EmbyDirectoryEntry) => {
      if (disabled || addingSeries) return
      setAddingSeries(true)
      try {
        const entries = await browse(1, entry.path)
        if (!entries.length) {
          message.info('暂无集数信息')
          return
        }
        const paths =
          failedSeries.current.get(entry.path) ??
          entries.map((item) => item.path)
        const added = await addFiles(paths)
        const failed = paths.filter((path) => !added.includes(path))
        if (failed.length) failedSeries.current.set(entry.path, failed)
        else failedSeries.current.delete(entry.path)
      } catch (err) {
        message.error(err instanceof Error ? err.message : '获取集数失败')
      } finally {
        setAddingSeries(false)
      }
    },
    [addFiles, addingSeries, browse, disabled]
  )

  return (
    <EmbyBrowser
      key={sourceId}
      mountId={sourceId ? 1 : null}
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      rootLabel="搜索结果"
      searchPlaceholder="输入番剧名称搜索"
      emptyText="输入关键词开始搜索番剧"
      showParentDirectory={false}
      episodeGrid
      browse={browse}
      search={doSearch}
      onSelectFiles={addFiles}
      onQuickAddSeries={(entry) => {
        void addSeries(entry)
      }}
      disabled={disabled || addingSeries}
      searchPrefix={
        <div>
          <Select
            className="[&_button]:h-[42px]"
            value={sourceId}
            options={sources.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            placeholder="选择数据源"
            disabled={!sources.length || disabled || addingSeries}
            onChange={(value) => {
              sourceGeneration.current++
              shows.current = []
              selections.current.clear()
              episodes.current.clear()
              posters.current.clear()
              failedSeries.current.clear()
              setSourceId(value)
            }}
          />
          {sourceError && (
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-error)]">
              {sourceError}
            </p>
          )}
        </div>
      }
      renderPoster={(entry) => {
        const poster = posters.current.get(entry.path)
        return (
          <AnimePoster
            key={`${entry.path}:${poster?.cover}`}
            cover={poster?.cover}
            title={entry.name}
            referer={poster?.referer || entry.path}
            kind={kind}
          />
        )
      }}
    />
  )
}
