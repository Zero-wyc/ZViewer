import { useCallback, useEffect, useMemo, useState } from 'react'
import { Database, Download, RefreshCw, Save, Settings } from 'lucide-react'
import { AniSubsGithubBrowser } from '@/modules/admin/components/AniSubsGithubBrowser'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Tag } from '@/components/ui/Tag'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { apiFetch } from '@/lib/api'
import { t } from '@/i18n'
import { CMS_SOURCE_PRESETS } from './shared'

/**
 * 来源库卡片：本地规则与 ani-subs / Kazumi / TVBox 三个内置库的入口。
 *
 * 卡片只放状态与条目数，自定义地址收进「设置」弹窗——地址列表可以很长，
 * 摊在页面上会把整块撑得比规则列表还高。
 * 数据和写入都走后端 `/api/crawler/libraries*`（与桌面控制台同一套接口），
 * 配置最终落在 system_settings.dataSourceConfig，不另建存储。
 */
export interface CrawlerLibrary {
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

/** 导入结果：每条源要么编译成一条规则，要么给出跳过原因。 */
interface ImportItem {
  name: string
  ruleId?: string
  warnings?: string[]
  skipped?: string
}

interface ImportResponse {
  success?: boolean
  count?: number
  saved?: number
  items?: ImportItem[]
  message?: string
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

/** 地址框共用的样式：两个弹窗和卡片保持一致。 */
const textareaClass =
  'w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] ' +
  'bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm ' +
  'text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] ' +
  'focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]'

interface CrawlerLibrariesCardProps {
  /** 外部（例如单条导入）改了来源后，靠它触发重新读取。 */
  refreshToken?: number
  /** 卡片内导入成功后通知外部刷新规则列表。 */
  onChanged?: () => void
}

export function CrawlerLibrariesCard({
  refreshToken,
  onChanged,
}: CrawlerLibrariesCardProps = {}) {
  const [libraries, setLibraries] = useState<CrawlerLibrary[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState('')
  const [inspectUrl, setInspectUrl] = useState('')
  const [inspecting, setInspecting] = useState(false)
  // 地址编辑在二级弹窗里：同一时刻只开一个库。
  const [editingId, setEditingId] = useState('')
  // 导入是两段式：先编译一份预告（弹窗里看），确认后才落库。
  const [importingId, setImportingId] = useState('')
  const [previews, setPreviews] = useState<
    Record<string, ImportResponse | undefined>
  >({})
  const [previewId, setPreviewId] = useState('')

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
    // 进页面即拉一次；refreshToken 变了说明外面导入过，也要重拉。
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- 首屏加载 */
    void load()
  }, [load, refreshToken])

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
      if (await saveUrls(library, urls)) {
        await load()
        setEditingId('')
      }
    },
    [drafts, load, saveUrls]
  )

  /**
   * 拉一次 TVBox 配置，识别到采集站就把地址填进输入框。
   *
   * 只改草稿不直接落库：设置弹窗里应以「保存」为准，否则关掉弹窗不保存
   * 也会留下一条地址。
   */
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
      setDrafts((prev) => {
        const lines = (prev.cms ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        if (lines.includes(url)) return prev
        return { ...prev, cms: [...lines, url].join('\n') }
      })
      message.success(
        t('识别到 {{length}} 个采集源，已加入地址', {
          length: data.sites.length,
        })
      )
      setInspectUrl('')
    } catch {
      message.error(t('拉取配置失败'))
    } finally {
      setInspecting(false)
    }
  }, [inspectUrl])

  const runImport = useCallback(
    async (library: CrawlerLibrary, dryRun: boolean) => {
      const urls = (drafts[library.id] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      setImportingId(library.id)
      try {
        const res = await apiFetch('/api/crawler/libraries/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: library.id, urls, dryRun }),
        })
        const data = (await res.json()) as ImportResponse
        if (!res.ok || !data.success) {
          message.error(data.message ?? t('导入失败'))
          return
        }
        if (dryRun) {
          // 一条都编译不出来时不必弹空白预览，直接说明原因。
          if ((data.saved ?? 0) === 0 && (data.items ?? []).length === 0) {
            message.info(t('没有可编译的源'))
            return
          }
          setPreviews((prev) => ({ ...prev, [library.id]: data }))
          setPreviewId(library.id)
          return
        }
        setPreviews((prev) => ({ ...prev, [library.id]: undefined }))
        setPreviewId('')
        message.success(
          t('已导入 {{count}} 条规则', { count: data.saved ?? 0 })
        )
        await load()
        onChanged?.()
      } catch {
        message.error(t('导入失败'))
      } finally {
        setImportingId('')
      }
    },
    [drafts, load, onChanged]
  )

  const builtins = useMemo(
    () => libraries.filter((library) => library.id !== 'local'),
    [libraries]
  )

  const editing = useMemo(
    () => libraries.find((library) => library.id === editingId) ?? null,
    [libraries, editingId]
  )
  const editingHint = useMemo(
    () => (editing ? configHint(editing) : ''),
    [editing]
  )
  const preview = useMemo(
    () => libraries.find((library) => library.id === previewId) ?? null,
    [libraries, previewId]
  )

  const libraryCards = builtins.map((library) => (
    <div
      key={library.id}
      className="flex flex-col gap-2 rounded-[var(--md-sys-shape-corner)] border p-3"
      style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Text className="truncate text-sm font-medium">{library.name}</Text>
            <Tag tinted color={library.available ? 'success' : 'default'}>
              {library.available ? t('可用') : t('未启用')}
            </Tag>
          </div>
          {/* 只报条目数，不铺源清单：清单要看就去「内置库来源」或设置弹窗 */}
          <Text type="secondary" className="mt-0.5 block text-xs">
            {t('{{count}} 个源', { count: library.count })}
          </Text>
        </div>
        {library.editable ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Settings className="h-4 w-4" />}
            title={t('设置')}
            aria-label={t('设置')}
            onClick={() => setEditingId(library.id)}
          />
        ) : null}
      </div>
      <Text type="secondary" className="line-clamp-2 block text-xs">
        {library.description}
      </Text>
      {library.error ? (
        <Text
          className="block text-xs"
          style={{ color: 'var(--md-sys-color-error)' }}
        >
          {library.error}
        </Text>
      ) : null}
      {library.editable ? (
        <div className="mt-auto flex items-center">
          <Button
            size="sm"
            variant="ghost"
            icon={<Download className="h-4 w-4" />}
            loading={importingId === library.id}
            disabled={importingId === library.id}
            title={t('把该库的源编译成本地规则，导入后可在站点规则里编辑')}
            onClick={() => void runImport(library, true)}
          >
            {t('导入为本地规则')}
          </Button>
        </div>
      ) : null}
    </div>
  ))

  return (
    <>
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
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {libraryCards}
        </div>
      </Card>

      {/* 二级弹窗：编辑一个库的自定义地址 */}
      <Modal
        open={Boolean(editing)}
        onClose={() => setEditingId('')}
        title={editing ? `${editing.name} · ${t('设置')}` : ''}
        className="max-w-2xl"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setEditingId('')}
              disabled={savingId === editing?.id}
            >
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              icon={<Save className="h-4 w-4" />}
              loading={savingId === editing?.id}
              disabled={savingId === editing?.id}
              onClick={() => {
                if (editing) void handleSave(editing)
              }}
            >
              {t('保存')}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tinted color={editing.available ? 'success' : 'default'}>
                {editing.available ? t('可用') : t('未启用')}
              </Tag>
              <Text type="secondary" className="text-xs">
                {t('{{count}} 个源', { count: editing.count })}
              </Text>
            </div>
            <Text type="secondary" className="block text-xs">
              {editing.description}
            </Text>
            {editing.error ? (
              <Text
                className="block text-xs"
                style={{ color: 'var(--md-sys-color-error)' }}
              >
                {editing.error}
              </Text>
            ) : null}
            <textarea
              rows={6}
              className={textareaClass}
              placeholder={editingHint}
              value={drafts[editing.id] ?? ''}
              onChange={(event) =>
                setDrafts((prev) => ({
                  ...prev,
                  [editing.id]: event.target.value,
                }))
              }
            />
            <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {editingHint}
            </p>
            {editing.id === 'kazumi' ? (
              <AniSubsGithubBrowser
                repoUrl="https://github.com/Predidit/KazumiRules"
                defaultPath=""
                title={t('从 KazumiRules 仓库选择规则')}
                allowAddAll={false}
                existingUrls={editing.urls ?? []}
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
            ) : null}
            {editing.id === 'cms' ? (
              <div className="flex flex-col gap-2">
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
                <div className="flex flex-wrap items-center gap-1.5">
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
        ) : null}
      </Modal>

      {/* 导入预告：卡片保持紧凑，预览放弹窗里 */}
      <Modal
        open={Boolean(preview)}
        onClose={() => setPreviewId('')}
        title={preview ? t('导入为本地规则') : ''}
        className="max-w-xl"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPreviewId('')}
              disabled={importingId === preview?.id}
            >
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              loading={importingId === preview?.id}
              disabled={importingId === preview?.id}
              onClick={() => {
                if (preview) void runImport(preview, false)
              }}
            >
              {t('确认导入')}
            </Button>
          </>
        }
      >
        {preview ? (
          <div className="flex flex-col gap-1.5">
            {(previews[preview.id]?.items ?? []).map((item, index) => (
              <div
                key={`${item.name}-${index}`}
                className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-xs"
              >
                <Text className="font-medium">{item.name}</Text>
                {item.skipped ? (
                  <Text
                    type="secondary"
                    className="text-[11px]"
                    style={{ color: 'var(--md-sys-color-error)' }}
                  >
                    {item.skipped}
                  </Text>
                ) : (
                  <Text type="secondary" className="text-[11px]">
                    {t('将导入为规则')}
                  </Text>
                )}
                {(item.warnings ?? []).map((warning) => (
                  <Text
                    key={warning}
                    type="secondary"
                    className="text-[11px] opacity-75"
                  >
                    {warning}
                  </Text>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </Modal>
    </>
  )
}
