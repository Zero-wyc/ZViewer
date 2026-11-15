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
import { t } from '@/i18n'

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
  kind: 'kazumi' | 'anisubs' | 'cms'
  title: string
  getSources: () => Promise<AniSubsSource[]>
  search: (source: string, keyword: string) => Promise<AniSubsSearchResult[]>
  getEpisodes: (source: string, identifier: string) => Promise<AniSubsEpisode[]>
  /** 搜索框占位文案（默认番剧语义） */
  searchPlaceholder?: string
  /** 空状态文案（默认番剧语义） */
  emptyText?: string
  /** 无可用数据源时的提示（默认指向管理面板订阅配置） */
  noSourcesHint?: string
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
  searchPlaceholder = t('输入番剧名称搜索'),
  emptyText = t('输入关键词开始搜索番剧'),
  noSourcesHint = t('未找到可用数据源，请在管理面板检查订阅配置'),
}: Props) {
  const [sources, setSources] = useState<AniSubsSource[]>([])
  const [sourceId, setSourceId] = useState('')
  const [sourceError, setSourceError] = useState('')
  const [addingSeries, setAddingSeries] = useState(false)
  /** 复合 path（站点 + 主体 id）→ 搜索结果。聚合模式下不同站点的 id 可能撞车。 */
  const shows = useRef(new Map<string, AniSubsSearchResult>())
  const selections = useRef(new Map<string, AnimeEpisodeSelection>())
  const posters = useRef(new Map<string, { cover?: string; referer: string }>())
  const episodes = useRef(new Map<string, EmbyDirectoryEntry[]>())
  const sourceGeneration = useRef(0)
  const failedSeries = useRef(new Map<string, string[]>())

  /**
   * 搜索结果的复合标识（站点 key + 站内 id）。
   *
   * 聚合搜索的结果来自不同站点，站内 id（数字自增等）并不保证全局唯一，
   * 直接拿 id 当 path 会让两张卡片撞 key、详情路由进错误的站点。
   * 单站点搜索时结果不带 source，回落到当前下拉选中项。
   */
  const showKey = useCallback(
    (show: AniSubsSearchResult): string =>
      JSON.stringify([show.source || sourceId, show.id]),
    [sourceId]
  )

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
        setSourceError(items.length ? '' : noSourcesHint)
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setSourceError(
            err instanceof Error ? err.message : t('加载数据源失败')
          )
      })
    return () => {
      cancelled = true
    }
  }, [getSources, noSourcesHint, open])

  const mapShows = useCallback(
    (items: AniSubsSearchResult[]): EmbyDirectoryEntry[] =>
      items.map((show) => {
        const path = showKey(show)
        posters.current.set(path, { cover: show.cover, referer: show.id })
        shows.current.set(path, show)
        // 聚合搜索模式下卡片上标出来源站点，用户才知道这张卡来自哪里
        const name = show.sourceName
          ? t('{{title}}（{{source}}）', {
              title: show.title,
              source: show.sourceName,
            })
          : show.title
        return {
          name,
          path,
          type: 'directory',
          embyType: 'Series',
        }
      }),
    [showKey]
  )

  const doSearch = useCallback(
    async (_mountId: number, keyword: string) => {
      const generation = ++sourceGeneration.current
      const items = await search(sourceId, keyword)
      if (generation !== sourceGeneration.current) return []
      shows.current = new Map()
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
      if (!path) return mapShows([...shows.current.values()])
      const cached = episodes.current.get(path)
      if (cached) return cached
      const show = shows.current.get(path)
      if (!show) return []
      // 聚合搜索模式下搜索结果自带真实站点 key（result.source），
      // 详情/选集必须路由到该站点而非当前下拉选中项（__all__）
      const siteKey = show.source || sourceId
      const generation = sourceGeneration.current
      const items = await getEpisodes(siteKey, show.id)
      if (generation !== sourceGeneration.current) return []
      const entries = items.map((episode): EmbyDirectoryEntry => {
        const key = JSON.stringify([path, episode.id])
        selections.current.set(key, {
          sourceId: siteKey,
          episode,
          title: `${show.title} - ${episode.title}`,
        })
        posters.current.set(key, { cover: show.cover, referer: show.id })
        return {
          name: /^\d+(?:\.\d+)?$/.test(episode.title)
            ? t('第{{title}}集', { title: episode.title })
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
        message.error(
          err instanceof Error ? err.message : t('添加失败，请重试')
        )
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
          message.info(t('暂无集数信息'))
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
        message.error(err instanceof Error ? err.message : t('获取集数失败'))
      } finally {
        setAddingSeries(false)
      }
    },
    [addFiles, addingSeries, browse, disabled]
  )

  return (
    <EmbyBrowser
      mountId={
        sourceId
          ? sources.findIndex((source) => source.id === sourceId) + 1
          : null
      }
      open={open}
      onClose={() => onOpenChange(false)}
      title={title}
      rootLabel={t('搜索结果')}
      searchPlaceholder={searchPlaceholder}
      emptyText={emptyText}
      showParentDirectory={false}
      episodeGrid
      preserveSearchTerm
      searchOnSourceChange
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
            placeholder={t('选择数据源')}
            disabled={!sources.length || disabled || addingSeries}
            onChange={(value) => {
              if (value === sourceId) return
              sourceGeneration.current++
              shows.current = new Map()
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
