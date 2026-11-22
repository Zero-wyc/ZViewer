import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, RefreshCw, Save } from 'lucide-react'
import { AniSubsGithubBrowser } from '@/modules/admin/components/AniSubsGithubBrowser'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Input } from '@/components/ui/Input'
import { apiFetch } from '@/lib/api'
import { t } from '@/i18n'
import { CMS_SOURCE_PRESETS } from './shared'

/**
 * 来源库卡片：本地规则与 ani-subs / Kazumi / TVBox 三个内置库的配置入口。
 *
 * 数据和写入都走后端 `/api/crawler/libraries*`（与桌面控制台同一套接口），
 * 配置最终落在 system_settings.dataSourceConfig，不另建存储。
 */
interface CrawlerLibrary {
  id: string
  name: string
  kind: string
  description: string
  available: boolean
  error?: string
  count: number
  configKey?: string
  editable: boolean
  urls?: string[]
  sources?: { id: string; name: string }[]
  note?: string
}

interface LibraryListResponse {
  success?: boolean
  libraries?: CrawlerLibrary[]
  message?: string
}

/** 每个库的配置区提示：留空语义各不相同。 */
function configHint(library: CrawlerLibrary): string {
  if (library.id === 'anisubs') return t('留空使用内置订阅；每行一个订阅地址')
  if (library.id === 'kazumi') return t('每行一个规则、索引或仓库地址')
  if (library.id === 'cms') return t('每行一个 TVBox 配置地址')
  return library.note ?? ''
}

export function CrawlerLibrariesCard() {
  const [libraries, setLibraries] = useState<CrawlerLibrary[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState('')
  const [inspectUrl, setInspectUrl] = useState('')
  const [inspecting, setInspecting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await apiFetch('/api/crawler/libraries')
      const data = (await res.json()) as LibraryListResponse
      if (!res.ok || !data.success || !data.libraries) {
        setError(data.message ?? t('读取来源库失败'))
        return
      }
      setLibraries(data.libraries)
      setDrafts(
        Object.fromEntries(
          data.libraries.map((item) => [item.id, (item.urls ?? []).join('\n')])
        )
      )
      setError('')
    } catch {
      setError(t('读取来源库失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    // 进页面即拉一次；置位在 load 内部，这里不需要同步 setState。
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- 首屏加载 */
    void load()
  }, [load])

  const saveUrls = useCallback(
    async (library: CrawlerLibrary, urls: string[]) => {
      setSavingId(library.id)
      try {
        const res = await apiFetch(
          `/api/crawler/libraries/${encodeURIComponent(library.id)}/config`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls }),
          }
        )
        const data = (await res.json()) as {
          success?: boolean
          message?: string
        }
        if (!res.ok || !data.success) {
          message.error(data.message ?? t('保存失败'))
          return false
        }
        message.success(t('已保存'))
        return true
      } catch {
        message.error(t('保存失败'))
        return false
      } finally {
        setSavingId('')
      }
    },
    []
  )

  const handleSave = useCallback(
    async (library: CrawlerLibrary) => {
      const raw = drafts[library.id] ?? ''
      const urls = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      if (await saveUrls(library, urls)) await load()
    },
    [drafts, load, saveUrls]
  )

  /** 拉一次 TVBox 配置，识别到采集站就把这个配置地址追加进列表。 */
  const handleInspect = useCallback(async () => {
    const url = inspectUrl.trim()
    if (!url) {
      message.error(t('请输入 TVBox 配置接口地址'))
      return
    }
    if (!/^https?:\/\//i.test(url)) {
      message.error(t('配置地址必须是 http(s) URL'))
      return
    }
    const library = libraries.find((item) => item.id === 'cms')
    if (!library) return
    setInspecting(true)
    try {
      const res = await apiFetch(
        `/api/stream/cms/inspect?url=${encodeURIComponent(url)}&refresh=1`
      )
      const data = (await res.json()) as {
        success?: boolean
        sites?: { key: string; name: string }[]
        message?: string
      }
      if (!data.success || !data.sites) {
        message.error(data.message ?? t('拉取配置失败'))
        return
      }
      if (data.sites.length === 0) {
        message.warning(t('没有识别到 CMS 采集源'))
        return
      }
      const existing = library.urls ?? []
      const next = existing.includes(url) ? existing : [...existing, url]
      if (await saveUrls(library, next)) {
        message.success(
          t('识别到 {{length}} 个采集源，已加入列表', {
            length: data.sites.length,
          })
        )
        setInspectUrl('')
        await load()
      }
    } catch {
      message.error(t('拉取配置失败'))
    } finally {
      setInspecting(false)
    }
  }, [inspectUrl, libraries, load, saveUrls])

  const sourceTags = useCallback((library: CrawlerLibrary) => {
    const sources = library.sources ?? []
    const shown = sources.slice(0, 8)
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {shown.map((source) => (
          <Tag key={source.id}>{source.name}</Tag>
        ))}
        {sources.length > shown.length && (
          <Text type="secondary" className="text-xs">
            {t('等 {{count}} 个', { count: sources.length })}
          </Text>
        )}
      </div>
    )
  }, [])

  const rows = useMemo(
    () =>
      libraries.map((library) => (
        <div
          key={library.id}
          className="rounded-[var(--md-sys-shape-corner)] border p-3"
          style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Text className="text-sm font-medium">{library.name}</Text>
            <Tag color={library.available ? 'success' : 'default'}>
              {library.available ? t('可用') : t('未启用')}
            </Tag>
            <Text type="secondary" className="text-xs">
              {t('{{count}} 个源', { count: library.count })}
            </Text>
            <div className="ml-auto flex items-center gap-2">
              {library.editable ? (
                <Button
                  size="sm"
                  icon={<Save className="h-4 w-4" />}
                  loading={savingId === library.id}
                  onClick={() => void handleSave(library)}
                >
                  {t('保存')}
                </Button>
              ) : null}
            </div>
          </div>
          <Text type="secondary" className="mt-1 block text-xs">
            {library.description}
          </Text>
          {library.error ? (
            <Text
              className="mt-1 block text-xs"
              style={{ color: 'var(--md-sys-color-error)' }}
            >
              {library.error}
            </Text>
          ) : null}
          {library.id === 'local' ? null : sourceTags(library)}
          {library.editable ? (
            <>
              <textarea
                rows={3}
                className="mt-2 w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                placeholder={configHint(library)}
                value={drafts[library.id] ?? ''}
                onChange={(event) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [library.id]: event.target.value,
                  }))
                }
              />
              <p className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                {configHint(library)}
              </p>
            </>
          ) : null}
          {library.id === 'kazumi' ? (
            <div className="mt-2">
              <AniSubsGithubBrowser
                repoUrl="https://github.com/Predidit/KazumiRules"
                defaultPath=""
                title={t('从 KazumiRules 仓库选择规则')}
                allowAddAll={false}
                existingUrls={library.urls ?? []}
                onAddUrls={(urls) =>
                  setDrafts((prev) => ({
                    ...prev,
                    kazumi: [
                      ...(prev.kazumi ?? '').split('\n').filter(Boolean),
                      ...urls,
                    ].join('\n'),
                  }))
                }
              />
            </div>
          ) : null}
          {library.id === 'cms' ? (
            <div className="mt-2">
              <div className="flex gap-2">
                <Input
                  value={inspectUrl}
                  onChange={(event) => setInspectUrl(event.target.value)}
                  placeholder="https://example.com/jsm.json"
                  className="flex-1"
                />
                <Button
                  onClick={() => void handleInspect()}
                  loading={inspecting}
                  disabled={inspecting}
                >
                  {t('检测并添加')}
                </Button>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Text type="secondary" className="text-xs">
                  {t('常用接口')}
                </Text>
                {CMS_SOURCE_PRESETS.map((preset) => (
                  <button
                    key={preset.url}
                    type="button"
                    onClick={() => setInspectUrl(preset.url)}
                    disabled={inspecting}
                    className="rounded-full border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-2.5 py-1 text-xs text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:border-[var(--md-sys-color-primary)] hover:text-[var(--md-sys-color-on-surface)] disabled:opacity-40"
                  >
                    {t(preset.label)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )),
    [
      libraries,
      drafts,
      savingId,
      inspectUrl,
      inspecting,
      handleSave,
      handleInspect,
      sourceTags,
    ]
  )

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <SectionHeader
          icon={<Database className="h-4 w-4" />}
          title={t('来源库')}
          subtitle={t('本地规则与三个内置库的配置入口；点片时按库搜索')}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={
            <RefreshCw
              className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'}
            />
          }
          onClick={() => void load()}
          disabled={loading}
        >
          {t('刷新')}
        </Button>
      </div>
      {error ? (
        <Text
          className="mt-3 block text-xs"
          style={{ color: 'var(--md-sys-color-error)' }}
        >
          {error}
        </Text>
      ) : null}
      <div className="mt-3 flex flex-col gap-3">{rows}</div>
    </Card>
  )
}
