/**
 * 爬虫引擎「全网搜片」弹窗。
 *
 * 入口：添加影片面板 B站 来源输入框旁的「全网搜索」按钮。
 * 站点规则由桌面端爬虫引擎维护，后端只代理 search/sites；前端不做页面解析。
 * 支持一次搜索多个站点（并发 3 个），结果按站点分组，可切换站点只看某一个。
 * 规则返回可播放直链（play_url/m3u8 等）的结果可以直接加入一起看。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ExternalLink,
  Film,
  Globe,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react'
import { FullscreenOverlay } from '@/components/ui/FullscreenOverlay'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useRoomStore, type CrawlerSourceMeta } from '@/store/roomStore'
import { detectMediaFormat } from '@/lib/mediaFormat'
import { buildAntileechProxyUrl } from '@/lib/antileech-proxy-url'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import {
  CrawlerChallengeError,
  fetchCrawlerSites,
  pickPlayableUrl,
  resolveCrawlerPlay,
  searchCrawlerSite,
  verifyCrawlerChallenge,
  type CrawlerChallenge,
  type CrawlerSearchItem,
  type CrawlerSearchResult,
  type CrawlerSite,
} from '@/modules/crawler/api'

interface CrawlerSearchModalProps {
  open: boolean
  onClose: () => void
}

const SEARCH_CONCURRENCY = 3

interface ActiveChallenge {
  siteId: string
  name: string
  info: CrawlerChallenge
}

function siteLabel(site: CrawlerSite): string {
  return site.name || site.site || site.id
}

function itemKey(siteId: string, item: CrawlerSearchItem): string {
  return `${siteId}:${item.url}`
}

export function CrawlerSearchModal({ open, onClose }: CrawlerSearchModalProps) {
  const roomId = useRoomStore((state) => state.roomId)
  const addMovie = useRoomStore((state) => state.addMovie)

  const [sites, setSites] = useState<CrawlerSite[]>([])
  const [sitesLoading, setSitesLoading] = useState(false)
  const [sitesError, setSitesError] = useState('')
  const [activeSite, setActiveSite] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [results, setResults] = useState<Record<string, CrawlerSearchResult>>(
    {}
  )
  const [siteErrors, setSiteErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<string[]>([])
  const [searched, setSearched] = useState(false)
  const [adding, setAdding] = useState('')
  const [challenge, setChallenge] = useState<ActiveChallenge | null>(null)
  const [challengeError, setChallengeError] = useState('')
  const [verifying, setVerifying] = useState(false)
  const requestSeqRef = useRef(0)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const loadSites = useCallback(async () => {
    if (!roomId) return
    setSitesLoading(true)
    setSitesError('')
    try {
      const list = await fetchCrawlerSites(roomId)
      setSites(list)
    } catch (err) {
      setSitesError(err instanceof Error ? err.message : t('获取站点失败'))
      setSites([])
    } finally {
      setSitesLoading(false)
    }
  }, [roomId])

  useEffect(() => {
    if (!open) return
    setActiveSite('all')
    setResults({})
    setSiteErrors({})
    setPending([])
    setSearched(false)
    void loadSites()
  }, [open, loadSites])

  const siteNameMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const site of sites) map[site.id] = siteLabel(site)
    return map
  }, [sites])

  const runSearch = useCallback(async () => {
    const query = keyword.trim()
    if (!query || !roomId) return
    if (sites.length === 0) {
      message.info(t('还没有可用的站点规则，请先在桌面控制台生成'))
      return
    }
    const seq = ++requestSeqRef.current
    const targets =
      activeSite === 'all'
        ? sites.map((site) => site.id)
        : sites.filter((site) => site.id === activeSite).map((site) => site.id)
    if (targets.length === 0) return

    setSearched(true)
    setPending(targets)
    setResults((prev) => {
      const next = { ...prev }
      for (const id of targets) delete next[id]
      return next
    })
    setSiteErrors((prev) => {
      const next = { ...prev }
      for (const id of targets) delete next[id]
      return next
    })

    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const index = cursor
        cursor += 1
        const siteId = targets[index]
        try {
          const result = await searchCrawlerSite(roomId, siteId, query, 30)
          if (requestSeqRef.current !== seq) return
          setResults((prev) => ({ ...prev, [siteId]: result }))
        } catch (err) {
          if (requestSeqRef.current !== seq) return
          if (err instanceof CrawlerChallengeError) {
            const site = sites.find((item) => item.id === siteId)
            setChallenge({
              siteId,
              name:
                site?.name ||
                err.challenge.name ||
                err.challenge.site ||
                siteId,
              info: err.challenge,
            })
            setChallengeError('')
            setSiteErrors((prev) => ({
              ...prev,
              [siteId]: t('需要人工验证后才能搜索'),
            }))
            return
          }
          setSiteErrors((prev) => ({
            ...prev,
            [siteId]: err instanceof Error ? err.message : t('搜索失败'),
          }))
        } finally {
          if (requestSeqRef.current === seq) {
            setPending((prev) => prev.filter((id) => id !== siteId))
          }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SEARCH_CONCURRENCY, targets.length) }, () =>
        worker()
      )
    )
  }, [activeSite, keyword, roomId, sites])

  const applyChallengeResult = useCallback(
    (siteId: string, result: CrawlerSearchResult) => {
      setResults((prev) => ({ ...prev, [siteId]: result }))
      setSiteErrors((prev) => {
        const next = { ...prev }
        delete next[siteId]
        return next
      })
      setChallenge(null)
      setChallengeError('')
      message.success(t('验证完成，已获取搜索结果'))
    },
    []
  )

  const handleVerify = useCallback(async () => {
    if (!challenge || verifying) return
    setVerifying(true)
    setChallengeError('')
    try {
      const result = await verifyCrawlerChallenge(challenge.info.id)
      applyChallengeResult(challenge.siteId, result)
    } catch (err) {
      setChallengeError(
        err instanceof Error ? err.message : t('验证还没有完成，请继续')
      )
    } finally {
      setVerifying(false)
    }
  }, [applyChallengeResult, challenge, verifying])

  // 用户在验证页里操作时，后台每 8 秒试一次；只有验证通过才替换结果。
  useEffect(() => {
    if (!challenge) return
    const siteId = challenge.siteId
    const timer = window.setInterval(() => {
      void verifyCrawlerChallenge(challenge.info.id)
        .then((result) => applyChallengeResult(siteId, result))
        .catch(() => {})
    }, 8000)
    return () => window.clearInterval(timer)
  }, [applyChallengeResult, challenge])

  const handleAdd = useCallback(
    async (siteId: string, item: CrawlerSearchItem) => {
      if (!roomId) return
      setAdding(itemKey(siteId, item))
      try {
        let playUrl = pickPlayableUrl(item)
        let title = item.title || ''
        let headers: Record<string, string> | undefined
        let sourceMeta: CrawlerSourceMeta | undefined
        if (!playUrl) {
          // 详情页/播放页：交给引擎按规则解析成直链（解析逻辑全部在后端）。
          const resolved = await resolveCrawlerPlay(roomId, item.url)
          if (resolved.format === 'iframe') {
            message.info(
              resolved.note ||
                t('该站点正片需要会员或不允许直接播放，请打开原站查看')
            )
            return
          }
          if (!resolved.url) {
            message.info(t('没有解析到可播放地址，请打开原站查看'))
            return
          }
          playUrl = resolved.url
          headers = resolved.headers
          title = resolved.title || title
          // 站点规则给了多档清晰度时记下档位名，播放器据此出清晰度下拉；
          // 只有一档就不用记。
          const qualities = (resolved.qualities || []).filter(
            (quality) => quality && quality.url && quality.name
          )
          const qualityNames =
            qualities.length > 1 ? qualities.map((quality) => quality.name) : []
          sourceMeta = {
            kind: 'crawler',
            sourceId: item.url,
            pageUrl: item.url,
            site: resolved.site,
            ruleId: resolved.ruleId,
            title: resolved.title || item.title,
            headers,
            qualities: qualityNames.length > 0 ? qualityNames : undefined,
            quality:
              qualityNames.length > 0
                ? qualities.find((quality) => quality.url === resolved.url)
                    ?.name || qualityNames[0]
                : undefined,
          }
        }
        const format = detectMediaFormat(playUrl)
        const finalUrl = headers
          ? buildAntileechProxyUrl('cms', playUrl, headers, {
              force: true,
              relative: true,
            })
          : playUrl
        await addMovie(roomId, {
          url: finalUrl,
          title: title || playUrl,
          cover: item.cover || undefined,
          source: 'mp4',
          format: format !== 'unknown' ? format : undefined,
          directLink: true,
          // 落库的直链带时效签名，播放时要用详情页重新解析一遍规则。
          sourceMeta,
        })
        message.success(t('影片已添加'))
      } catch (err) {
        message.error(err instanceof Error ? err.message : t('添加影片失败'))
      } finally {
        setAdding('')
      }
    },
    [addMovie, roomId]
  )

  const orderedSites = useMemo(() => {
    const withResult: CrawlerSite[] = []
    const rest: CrawlerSite[] = []
    for (const site of sites) {
      if (
        results[site.id] ||
        siteErrors[site.id] ||
        pending.includes(site.id)
      ) {
        withResult.push(site)
      } else {
        rest.push(site)
      }
    }
    return [...withResult, ...rest]
  }, [pending, results, siteErrors, sites])

  const visibleSites = useMemo(() => {
    if (activeSite === 'all') return orderedSites
    const one = sites.find((site) => site.id === activeSite)
    return one ? [one] : []
  }, [activeSite, orderedSites, sites])

  const totalCount = useMemo(
    () =>
      Object.values(results).reduce(
        (sum, result) => sum + (result.items?.length || 0),
        0
      ),
    [results]
  )

  const resultCountFor = (siteId: string) => results[siteId]?.items?.length || 0

  return (
    <FullscreenOverlay
      open={open}
      onClose={onClose}
      className="h-[660px] max-w-5xl"
      title={
        <span className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          {t('全网搜片')}
        </span>
      }
    >
      <div className="relative flex h-full flex-col">
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void runSearch()
              }}
              placeholder={t('输入片名，在全部站点中搜索')}
              className="flex-1"
            />
            <Button
              variant="primary"
              onClick={() => void runSearch()}
              disabled={
                pending.length > 0 || !keyword.trim() || sites.length === 0
              }
            >
              {pending.length > 0 ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              <span className="ml-1.5">{t('搜索')}</span>
            </Button>
            <Button
              variant="secondary"
              title={t('刷新站点规则')}
              onClick={() => void loadSites()}
              disabled={sitesLoading}
            >
              <RefreshCw
                className={cn('h-4 w-4', sitesLoading && 'animate-spin')}
              />
            </Button>
          </div>

          {sitesLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs opacity-70">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('正在加载站点规则…')}
            </div>
          ) : sitesError ? (
            <div className="flex items-start gap-2 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-error-container)] px-3 py-2 text-xs text-[var(--md-sys-color-on-error-container)]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="flex-1">{sitesError}</div>
              <button
                type="button"
                className="underline"
                onClick={() => void loadSites()}
              >
                {t('重试')}
              </button>
            </div>
          ) : sites.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-3 text-xs">
              <Text type="secondary">
                {t(
                  '还没有可用的站点规则。先提交站点，再在桌面控制台用 Agent 生成规则。'
                )}
              </Text>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => setActiveSite('all')}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                  activeSite === 'all'
                    ? 'text-[var(--md-sys-color-on-primary)]'
                    : 'text-[var(--md-sys-color-on-surface-variant)]'
                )}
                style={{
                  backgroundColor:
                    activeSite === 'all'
                      ? 'var(--md-sys-color-primary)'
                      : 'var(--glass-bg)',
                }}
              >
                <Globe className="h-3.5 w-3.5" />
                {t('全部站点')}
                <span className="opacity-70">{sites.length}</span>
                {totalCount > 0 && (
                  <span className="rounded-full bg-black/10 px-1.5 text-[10px]">
                    {totalCount}
                  </span>
                )}
              </button>
              {orderedSites.map((site) => {
                const active = activeSite === site.id
                const count = resultCountFor(site.id)
                const loading = pending.includes(site.id)
                const failed = Boolean(siteErrors[site.id])
                return (
                  <button
                    key={site.id}
                    type="button"
                    onClick={() => setActiveSite(site.id)}
                    title={site.description || site.site}
                    className={cn(
                      'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                      active
                        ? 'text-[var(--md-sys-color-on-primary)]'
                        : 'text-[var(--md-sys-color-on-surface-variant)]'
                    )}
                    style={{
                      backgroundColor: active
                        ? 'var(--md-sys-color-primary)'
                        : 'var(--glass-bg)',
                    }}
                  >
                    {loading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : failed ? (
                      <AlertTriangle className="h-3.5 w-3.5" />
                    ) : (
                      <Globe className="h-3.5 w-3.5" />
                    )}
                    {siteLabel(site)}
                    {searched && !loading && (
                      <span className="opacity-70">{failed ? '!' : count}</span>
                    )}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
          {!searched ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <Search className="h-10 w-10 opacity-30" />
              <Text type="secondary" className="text-sm">
                {t('输入片名后，会同时在全部可用站点搜索')}
              </Text>
              <Text type="secondary" className="text-xs opacity-70">
                {t('结果解析在桌面端爬虫引擎完成，网页端只负责展示')}
              </Text>
            </div>
          ) : pending.length > 0 &&
            Object.keys(results).length === 0 &&
            Object.keys(siteErrors).length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin opacity-60" />
              <Text type="secondary" className="text-sm">
                {t('正在搜索 {{count}} 个站点…', { count: pending.length })}
              </Text>
            </div>
          ) : totalCount === 0 && pending.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <SearchX className="h-10 w-10 opacity-30" />
              <Text type="secondary" className="text-sm">
                {t('没有搜到结果')}
              </Text>
              {Object.entries(siteErrors).map(([siteId, error]) => (
                <Text
                  key={siteId}
                  type="secondary"
                  className="max-w-xl text-xs opacity-70"
                >
                  {siteNameMap[siteId] || siteId}: {error}
                </Text>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              {visibleSites.map((site) => {
                const result = results[site.id]
                const error = siteErrors[site.id]
                const loading = pending.includes(site.id)
                return (
                  <section key={site.id}>
                    <div className="mb-2 flex items-center gap-2">
                      <Globe className="h-4 w-4 opacity-60" />
                      <Text className="text-sm font-semibold">
                        {siteLabel(site)}
                      </Text>
                      {loading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin opacity-60" />
                      ) : error ? (
                        <span className="flex items-center gap-1 text-xs text-[var(--md-sys-color-error)]">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {error}
                        </span>
                      ) : (
                        <Text type="secondary" className="text-xs">
                          {t('{{count}} 条', {
                            count: result?.items?.length || 0,
                          })}
                          {result?.tookMs
                            ? ` · ${(result.tookMs / 1000).toFixed(1)}s`
                            : ''}
                          {result?.repaired ? ` · ${t('规则已自动修复')}` : ''}
                        </Text>
                      )}
                    </div>
                    {result?.warnings?.length ? (
                      <div className="mb-2 flex flex-col gap-1 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2">
                        {result.warnings.map((warning) => (
                          <Text
                            key={warning}
                            type="secondary"
                            className="text-[11px]"
                          >
                            {warning}
                          </Text>
                        ))}
                      </div>
                    ) : null}
                    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                      {(result?.items || []).map((item) => {
                        const key = itemKey(site.id, item)
                        const playable = pickPlayableUrl(item)
                        const busy = adding === key
                        return (
                          <div
                            key={key}
                            className="flex gap-2.5 rounded-[var(--md-sys-shape-corner)] bg-[var(--glass-bg)] p-2.5"
                          >
                            <div className="h-[68px] w-[48px] shrink-0 overflow-hidden rounded-md bg-[var(--md-sys-color-surface-container-highest)]">
                              {item.cover ? (
                                <img
                                  src={item.cover}
                                  alt=""
                                  referrerPolicy="no-referrer"
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <div className="flex h-full w-full items-center justify-center opacity-40">
                                  <Film className="h-5 w-5" />
                                </div>
                              )}
                            </div>
                            <div className="flex min-w-0 flex-1 flex-col">
                              <Text className="line-clamp-2 text-xs font-semibold leading-snug">
                                {item.title}
                              </Text>
                              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] opacity-65">
                                {item.author && <span>{item.author}</span>}
                                {item.duration && <span>{item.duration}</span>}
                                {playable ? (
                                  <span>{t('可播放直链')}</span>
                                ) : (
                                  <span>{t('需解析')}</span>
                                )}
                              </div>
                              {item.description && (
                                <Text
                                  type="secondary"
                                  className="mt-0.5 line-clamp-2 text-[10px] leading-snug"
                                >
                                  {item.description}
                                </Text>
                              )}
                              <div className="mt-auto flex items-center gap-1.5 pt-1.5">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={busy}
                                  title={
                                    playable
                                      ? t('加入一起看')
                                      : t('解析播放地址后加入一起看')
                                  }
                                  onClick={() => void handleAdd(site.id, item)}
                                >
                                  {busy ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Plus className="h-3.5 w-3.5" />
                                  )}
                                  <span className="ml-1">{t('加入')}</span>
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  title={t('打开原站')}
                                  onClick={() =>
                                    window.open(item.url, '_blank', 'noopener')
                                  }
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>
          )}
        </div>
        {challenge && (
          <div className="absolute inset-0 z-50 flex flex-col gap-2 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface)] p-3 shadow-2xl">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--md-sys-color-primary)]" />
              <div className="min-w-0 flex-1">
                <Text className="text-sm font-semibold">
                  {t('{{site}} 需要完成人机验证', { site: challenge.name })}
                </Text>
                <Text type="secondary" className="mt-0.5 line-clamp-2 text-xs">
                  {challenge.info.note ||
                    t(
                      '请在下方页面完成验证（如拖动滑块、输入验证码），完成后会自动继续搜索。'
                    )}
                </Text>
              </div>
              <button
                type="button"
                className="rounded-full p-1 opacity-60 transition-opacity hover:opacity-100"
                title={t('关闭')}
                onClick={() => {
                  setChallenge(null)
                  setChallengeError('')
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <iframe
              ref={iframeRef}
              title={t('人机验证')}
              src={challenge.info.proxyUrl}
              sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
              referrerPolicy="no-referrer"
              className="min-h-0 w-full flex-1 rounded-lg border-0 bg-white"
            />
            <div className="flex items-center gap-2">
              {challengeError ? (
                <Text className="line-clamp-2 flex-1 text-xs text-[var(--md-sys-color-error)]">
                  {challengeError}
                </Text>
              ) : (
                <Text type="secondary" className="flex-1 text-xs">
                  {t('验证通过后会自动刷新该站点的搜索结果')}
                </Text>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const frame = iframeRef.current
                  if (!frame) return
                  const joiner = challenge.info.proxyUrl.includes('?')
                    ? '&'
                    : '?'
                  frame.src = `${challenge.info.proxyUrl}${joiner}_r=${Date.now()}`
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="ml-1">{t('刷新验证页')}</span>
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={verifying}
                onClick={() => void handleVerify()}
              >
                {verifying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                <span className="ml-1">
                  {verifying ? t('验证中…') : t('我已完成')}
                </span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </FullscreenOverlay>
  )
}
