import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Tv,
  Play,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  List,
  Search,
} from 'lucide-react'

import { Text, Paragraph } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { FullscreenOverlay } from '@/components/ui/FullscreenOverlay'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import {
  getBilibiliLoginStatus,
  getFollowingBangumi,
  getBangumiEpisodes,
  buildBilibiliImageProxyUrl,
  type FollowingBangumi,
  type BangumiEpisode,
} from '@/modules/room/watch-together/resolveSource'

interface BilibiliBangumiSelectorProps {
  /** 选择某一集后的回调，父组件负责将其加载为 B站 视频源 */
  onSelectEpisode: (bvid: string, cid: number, title: string) => void
  disabled?: boolean
  /** 受控的弹窗打开状态；与 onOpenChange 一起传入时生效 */
  open?: boolean
  /** 受控模式下弹窗状态变化回调 */
  onOpenChange?: (open: boolean) => void
}

export function BilibiliBangumiSelector({
  onSelectEpisode,
  open,
  onOpenChange,
}: BilibiliBangumiSelectorProps) {
  const isControlled = open !== undefined && onOpenChange !== undefined
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [internalOpen, setInternalOpen] = useState(false)
  const modalOpen = isControlled ? open : internalOpen
  const [bangumiList, setBangumiList] = useState<FollowingBangumi[]>([])
  const [loadingBangumi, setLoadingBangumi] = useState(false)
  const [expandedSeasonId, setExpandedSeasonId] = useState<number | null>(null)
  const [episodesMap, setEpisodesMap] = useState<
    Record<number, BangumiEpisode[]>
  >({})
  const [loadingEpisodes, setLoadingEpisodes] = useState<
    Record<number, boolean>
  >({})
  const [viewMode, setViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('bilibili-bangumi-view-mode')
    return saved === 'tile' ? 'tile' : 'list'
  })
  const [searchKeyword, setSearchKeyword] = useState('')

  useEffect(() => {
    getBilibiliLoginStatus()
      .then(setLoggedIn)
      .catch(() => setLoggedIn(false))
  }, [])

  const fetchBangumiList = useCallback(async () => {
    if (bangumiList.length > 0) return
    setLoadingBangumi(true)
    try {
      const list = await getFollowingBangumi()
      setBangumiList(list)
    } catch (err) {
      console.error('[BilibiliBangumiSelector] fetch bangumi error:', err)
      message.error(err instanceof Error ? err.message : '获取关注番剧失败')
    } finally {
      setLoadingBangumi(false)
    }
  }, [bangumiList])

  useEffect(() => {
    if (isControlled && open) {
      void fetchBangumiList()
    } else if (!isControlled && internalOpen) {
      void fetchBangumiList()
    }
  }, [isControlled, open, internalOpen, fetchBangumiList])

  const handleToggleBangumi = async (bangumi: FollowingBangumi) => {
    if (expandedSeasonId === bangumi.seasonId) {
      setExpandedSeasonId(null)
      return
    }

    setExpandedSeasonId(bangumi.seasonId)

    if (episodesMap[bangumi.seasonId]) return

    setLoadingEpisodes((prev) => ({ ...prev, [bangumi.seasonId]: true }))
    try {
      const episodes = await getBangumiEpisodes(bangumi.seasonId)
      setEpisodesMap((prev) => ({ ...prev, [bangumi.seasonId]: episodes }))
    } catch (err) {
      console.error('[BilibiliBangumiSelector] fetch episodes error:', err)
      message.error(err instanceof Error ? err.message : '获取集数失败')
    } finally {
      setLoadingEpisodes((prev) => ({ ...prev, [bangumi.seasonId]: false }))
    }
  }

  const handleSelectEpisode = (episode: BangumiEpisode) => {
    onSelectEpisode(episode.bvid, episode.cid, episode.title)
    if (isControlled) {
      onOpenChange(false)
    } else {
      setInternalOpen(false)
    }
    setExpandedSeasonId(null)
  }

  const handleCloseModal = () => {
    if (isControlled) {
      onOpenChange(false)
    } else {
      setInternalOpen(false)
    }
    setExpandedSeasonId(null)
  }

  const filteredBangumiList = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase()
    if (!keyword) return bangumiList
    return bangumiList.filter(
      (item) =>
        item.title.toLowerCase().includes(keyword) ||
        (item.progress && item.progress.toLowerCase().includes(keyword))
    )
  }, [bangumiList, searchKeyword])

  const isLoggedIn = loggedIn === true

  return (
    <FullscreenOverlay
      open={modalOpen}
      onClose={handleCloseModal}
      title="我的追番"
    >
      <div className="flex min-h-[200px] flex-col">
        {!isLoggedIn && !loadingBangumi && (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
            <Tv
              className="h-8 w-8 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
            <Paragraph type="secondary" className="m-0 text-xs">
              请先扫码登录 B站
            </Paragraph>
          </div>
        )}

        {loadingBangumi && bangumiList.length === 0 && (
          <div className="flex h-40 items-center justify-center">
            <Spinner tip="加载追番列表…" size={28} />
          </div>
        )}

        {!loadingBangumi && isLoggedIn && bangumiList.length === 0 && (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
            <Tv
              className="h-8 w-8 opacity-40"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            />
            <Paragraph type="secondary" className="m-0 text-xs">
              暂无关注的番剧
            </Paragraph>
          </div>
        )}

        {isLoggedIn && bangumiList.length > 0 && (
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative flex-1">
              <Search
                className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              />
              <input
                type="text"
                placeholder="搜索番剧名称…"
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] py-2 pl-9 pr-3 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
              />
            </div>
            <div
              className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5 shrink-0"
              style={{ borderColor: 'var(--md-sys-color-outline)' }}
            >
              <button
                type="button"
                onClick={() => {
                  setViewMode('list')
                  localStorage.setItem('bilibili-bangumi-view-mode', 'list')
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
                  localStorage.setItem('bilibili-bangumi-view-mode', 'tile')
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
        )}

        <div
          className={
            viewMode === 'tile'
              ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4'
              : 'flex flex-col gap-3'
          }
        >
          {filteredBangumiList.map((bangumi) => {
            const expanded = expandedSeasonId === bangumi.seasonId
            const episodes = episodesMap[bangumi.seasonId] ?? []
            const episodesLoading = loadingEpisodes[bangumi.seasonId] ?? false

            return (
              <div
                key={bangumi.seasonId}
                className={cn(
                  'bangumi-card overflow-hidden rounded-[var(--md-sys-shape-corner)] border transition-all',
                  expanded
                    ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-surface-container-high)]'
                    : 'border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container)] hover:border-[var(--md-sys-color-outline)]'
                )}
              >
                <button
                  type="button"
                  onClick={() => handleToggleBangumi(bangumi)}
                  className={cn(
                    'flex w-full gap-3 p-3 text-left sm:p-4',
                    viewMode === 'tile' ? 'flex-col' : 'flex-row gap-4'
                  )}
                >
                  {bangumi.cover ? (
                    <img
                      src={buildBilibiliImageProxyUrl(bangumi.cover)}
                      alt={bangumi.title}
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
                      title={bangumi.title}
                    >
                      {bangumi.title}
                    </Text>
                    <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                      {bangumi.progress ||
                        (bangumi.total ? `全 ${bangumi.total} 集` : '')}
                    </Paragraph>
                    {viewMode !== 'tile' && (
                      <Paragraph
                        type="secondary"
                        className="m-0 mt-2 line-clamp-2 text-xs"
                      >
                        点击展开选择集数
                      </Paragraph>
                    )}
                    <div className="mt-auto flex items-center gap-1 pt-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      <span>{expanded ? '收起' : '展开集数'}</span>
                      {expanded ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )}
                    </div>
                  </div>
                </button>

                {expanded && (
                  <div className="border-t border-[var(--md-sys-color-outline-variant)] px-3 pb-3 sm:px-4">
                    {episodesLoading && episodes.length === 0 && (
                      <div className="flex h-20 items-center justify-center">
                        <Spinner tip="加载集数…" size={20} />
                      </div>
                    )}

                    {!episodesLoading && episodes.length === 0 && (
                      <div className="flex h-20 items-center justify-center">
                        <Paragraph type="secondary" className="m-0 text-xs">
                          暂无集数信息
                        </Paragraph>
                      </div>
                    )}

                    <div className="mt-2 grid max-h-[220px] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                      {episodes.map((episode) => (
                        <button
                          key={`${episode.bvid}-${episode.cid}`}
                          type="button"
                          onClick={() => handleSelectEpisode(episode)}
                          className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] border border-transparent p-2 text-left transition-all hover:border-[var(--md-sys-color-primary)] hover:bg-[var(--md-sys-color-primary-container)]"
                        >
                          <div
                            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-medium"
                            style={{
                              backgroundColor:
                                'var(--md-sys-color-primary-container)',
                              color: 'var(--md-sys-color-primary)',
                            }}
                          >
                            {episode.index}
                          </div>
                          <span
                            className="min-w-0 flex-1 truncate text-xs"
                            title={episode.title}
                          >
                            {episode.title}
                          </span>
                          <Play
                            className="h-3 w-3 flex-shrink-0"
                            style={{
                              color: 'var(--md-sys-color-on-surface-variant)',
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {isLoggedIn &&
          bangumiList.length > 0 &&
          filteredBangumiList.length === 0 && (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-center">
              <Tv
                className="h-8 w-8 opacity-40"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              />
              <Paragraph type="secondary" className="m-0 text-xs">
                未找到匹配的番剧
              </Paragraph>
            </div>
          )}
      </div>
    </FullscreenOverlay>
  )
}
