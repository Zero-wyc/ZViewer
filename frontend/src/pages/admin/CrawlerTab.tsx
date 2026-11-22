import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  Download,
  FileJson,
  Globe2,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { Tag } from '@/components/ui/Tag'
import { Text, Title } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { t } from '@/i18n'
import {
  CrawlerLibrariesCard,
  type CrawlerLibrary,
} from './CrawlerLibrariesCard'

/** 规则列表项（后端 PublicView 的字段子集，只取这一页要显示的） */
interface CrawlerRuleRow {
  id: string
  name: string
  site: string
  enabled: boolean
  visibility: string
  version: number
  updatedAt: string
  stats?: { searches?: number; last_error?: string }
}

interface CrawlerRuntimeStatus {
  root: string
  rules: number
  accounts: number
  scriptRules: number
  llmConfigured: boolean
  browser: { available: boolean; running: boolean; error?: string }
}

interface ImportReportItem {
  name: string
  action: 'create' | 'update' | 'failed'
  ruleId?: string | null
  error?: string
  notes?: string[]
  warnings?: string[]
}

interface ImportReport {
  success: boolean
  mode: string
  dryRun: boolean
  total: number
  imported: number
  updated: number
  failed: number
  warnings?: string[]
  backupFile?: string
  items?: ImportReportItem[]
}

/** 全网搜片 Tab：单文件包 / Docker 部署时手动导入 GUI 生成的规则包。 */
export function CrawlerTab() {
  const [status, setStatus] = useState<CrawlerRuntimeStatus | null>(null)
  const [rules, setRules] = useState<CrawlerRuleRow[]>([])
  const [libraries, setLibraries] = useState<CrawlerLibrary[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // 单条导入的忙碌键：`kind:source`
  const [importingSource, setImportingSource] = useState('')
  // 导入会改来源库的条目数，卡片要靠它刷新
  const [libraryToken, setLibraryToken] = useState(0)

  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [mode, setMode] = useState<'merge' | 'replace'>('merge')
  const [clearAccounts, setClearAccounts] = useState(false)
  const [clearRooms, setClearRooms] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [replaceConfirm, setReplaceConfirm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CrawlerRuleRow | null>(null)
  // 批量删除：选中集合按 id 存，刷新列表时把已消失的 id 剔掉。
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(
    () => new Set()
  )
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const fetchRules = useCallback(async () => {
    const res = await apiFetch('/api/crawler/rules')
    const data = (await res.json()) as {
      success?: boolean
      rules?: CrawlerRuleRow[]
      message?: string
    }
    if (data.success && data.rules) {
      setRules(data.rules)
      const alive = new Set(data.rules.map((item) => item.id))
      setSelectedRuleIds((prev) => {
        if (prev.size === 0) return prev
        const next = new Set([...prev].filter((id) => alive.has(id)))
        return next.size === prev.size ? prev : next
      })
    }
  }, [])

  const fetchLibraries = useCallback(async () => {
    try {
      const res = await apiFetch('/api/crawler/libraries')
      const data = (await res.json()) as {
        success?: boolean
        libraries?: CrawlerLibrary[]
      }
      if (data.success && data.libraries) setLibraries(data.libraries)
    } catch {
      // 来源库读不到不影响规则列表，静默即可
    }
  }, [])

  /** 把来源库的一条源编译成本地规则。 */
  const handleImportSource = useCallback(
    async (libraryId: string, source: string) => {
      setImportingSource(`${libraryId}:${source}`)
      try {
        const res = await apiFetch('/api/crawler/libraries/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: libraryId, source, dryRun: false }),
        })
        const data = (await res.json()) as {
          success?: boolean
          saved?: number
          items?: { skipped?: string }[]
          message?: string
        }
        if (!res.ok || !data.success) {
          message.error(
            data.message ?? data.items?.[0]?.skipped ?? t('导入失败')
          )
          return
        }
        message.success(
          t('已导入 {{count}} 条规则', { count: data.saved ?? 0 })
        )
        await fetchRules()
        await fetchLibraries()
        setLibraryToken((value) => value + 1)
      } catch {
        message.error(t('导入失败'))
      } finally {
        setImportingSource('')
      }
    },
    [fetchLibraries, fetchRules]
  )

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [statusRes] = await Promise.all([
        apiFetch('/api/crawler/status'),
        fetchRules(),
        fetchLibraries(),
      ])
      const data = (await statusRes.json()) as {
        success?: boolean
        message?: string
      } & Partial<CrawlerRuntimeStatus>
      if (data.success) {
        setStatus({
          root: data.root ?? '',
          rules: data.rules ?? 0,
          accounts: data.accounts ?? 0,
          scriptRules: data.scriptRules ?? 0,
          llmConfigured: data.llmConfigured ?? false,
          browser: data.browser ?? { available: false, running: false },
        })
        setLoadError('')
      } else {
        setLoadError(data.message ?? t('读取规则引擎状态失败'))
      }
    } catch {
      setLoadError(t('读取规则引擎状态失败'))
    } finally {
      setLoading(false)
    }
  }, [fetchLibraries, fetchRules])

  useEffect(() => {
    // 进标签即拉一次数据：这里 loading 必须同步置位，否则首帧会闪空列表。
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- 首屏加载 */
    void loadAll()
  }, [loadAll])

  const handlePickFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > 8 * 1024 * 1024) {
      message.error(t('规则文件不能超过 8 MB'))
      return
    }
    const content = await file.text()
    setText(content)
    setFileName(file.name)
    setReport(null)
  }

  const runImport = async (dryRun: boolean) => {
    const raw = text.trim()
    if (!raw) {
      message.error(t('请先选择 JSON 文件或粘贴规则内容'))
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      message.error(t('规则内容不是有效 JSON'))
      return
    }
    if (dryRun) {
      setPreviewing(true)
    } else {
      setImporting(true)
    }
    try {
      const res = await apiFetch('/api/crawler/rules/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundle: payload,
          mode,
          dryRun,
          clearAccounts,
          clearRooms,
        }),
      })
      const data = (await res.json()) as ImportReport & { message?: string }
      if (!res.ok || data.success === undefined) {
        message.error(data.message ?? t('导入失败'))
        return
      }
      setReport(data)
      if (!dryRun) {
        if (data.failed > 0) {
          message.error(t('部分规则未能导入，请看下方报告'))
        } else {
          message.success(t('导入完成'))
        }
        await loadAll()
      }
    } catch {
      message.error(t('导入失败'))
    } finally {
      setPreviewing(false)
      setImporting(false)
    }
  }

  const handleImportClick = () => {
    if (!text.trim()) {
      message.error(t('请先选择 JSON 文件或粘贴规则内容'))
      return
    }
    if (mode === 'replace') {
      setReplaceConfirm(true)
      return
    }
    void runImport(false)
  }

  const handleToggleRule = async (rule: CrawlerRuleRow, enabled: boolean) => {
    // 先本地乐观更新：开关手感比等一次往返重要。
    setRules((prev) =>
      prev.map((item) => (item.id === rule.id ? { ...item, enabled } : item))
    )
    const res = await apiFetch(
      `/api/crawler/rules/${encodeURIComponent(rule.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: { enabled } }),
      }
    )
    if (!res.ok) {
      setRules((prev) =>
        prev.map((item) =>
          item.id === rule.id ? { ...item, enabled: rule.enabled } : item
        )
      )
      message.error(t('更新规则失败'))
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    const res = await apiFetch(
      `/api/crawler/rules/${encodeURIComponent(deleteTarget.id)}`,
      { method: 'DELETE' }
    )
    setDeleteTarget(null)
    if (res.ok) {
      message.success(t('已删除规则'))
      setRules((prev) => prev.filter((item) => item.id !== deleteTarget.id))
      return
    }
    message.error(t('删除规则失败'))
  }

  const handleBatchDelete = async () => {
    if (selectedRuleIds.size === 0) return
    setBatchDeleting(true)
    try {
      const res = await apiFetch('/api/crawler/rules/batch-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...selectedRuleIds] }),
      })
      const data = (await res.json()) as {
        success?: boolean
        deleted?: number
        failed?: Record<string, string>
        message?: string
      }
      if (!res.ok || !data.success) {
        message.error(data.message ?? t('批量删除失败'))
        return
      }
      const deleted = data.deleted ?? 0
      const failed = Object.keys(data.failed ?? {}).length
      if (deleted > 0) {
        message.success(t('已删除 {{count}} 条规则', { count: deleted }))
      }
      if (failed > 0) {
        message.error(t('{{count}} 条规则删除失败', { count: failed }))
      }
      setSelectedRuleIds(new Set())
      setBatchDeleteConfirm(false)
      await loadAll()
    } catch {
      message.error(t('批量删除失败'))
    } finally {
      setBatchDeleting(false)
    }
  }

  const handleExport = async () => {
    const res = await apiFetch('/api/crawler/rules/export')
    if (!res.ok) {
      message.error(t('导出失败'))
      return
    }
    const payload = await res.json()
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'crawler-rules.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  if (loading) {
    return (
      <div className="py-12">
        <Spinner tip={t('加载中...')} size={32} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {loadError && (
        <div
          className="flex items-start gap-2 rounded-[var(--md-sys-shape-corner)] border p-3 text-sm"
          style={{
            borderColor: 'var(--md-sys-color-error)',
            backgroundColor: 'var(--md-sys-color-error-container)',
            color: 'var(--md-sys-color-on-error-container)',
          }}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      <CrawlerLibrariesCard
        refreshToken={libraryToken}
        onChanged={() => {
          void fetchRules()
          void fetchLibraries()
        }}
      />

      {status?.root && (
        <Text type="secondary" className="break-all text-xs">
          {t('规则目录：{{root}}', { root: status.root })}
        </Text>
      )}

      <Card className="p-4 sm:p-5">
        <SectionHeader
          icon={<Upload className="h-4 w-4" />}
          title={t('导入规则包')}
          subtitle={t(
            '在 GUI 里生成规则后导出 JSON，在这里导入即可让本机具备全网搜片能力；导入立即生效，无需重启'
          )}
        />

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                void handlePickFile(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            <Button
              size="sm"
              icon={<FileJson className="h-4 w-4" />}
              onClick={() => fileInputRef.current?.click()}
            >
              {fileName || t('选择 JSON 文件')}
            </Button>
            <div
              className="inline-flex shrink-0 rounded-[var(--md-sys-shape-corner)] border p-0.5"
              style={{ borderColor: 'var(--md-sys-color-outline)' }}
            >
              {(['merge', 'replace'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMode(value)}
                  className="rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1 text-xs font-medium transition-all"
                  style={{
                    backgroundColor:
                      mode === value
                        ? 'var(--md-sys-color-primary-container)'
                        : 'transparent',
                    color:
                      mode === value
                        ? 'var(--md-sys-color-on-primary-container)'
                        : 'var(--md-sys-color-on-surface)',
                  }}
                >
                  {value === 'merge' ? t('合并') : t('替换')}
                </button>
              ))}
            </div>
            <Switch
              label={t('清空账号绑定')}
              checked={clearAccounts}
              onChange={(event) => setClearAccounts(event.target.checked)}
            />
            <Switch
              label={t('清空房间限制')}
              checked={clearRooms}
              onChange={(event) => setClearRooms(event.target.checked)}
            />
          </div>

          <textarea
            value={text}
            onChange={(event) => {
              setText(event.target.value)
              setFileName('')
              setReport(null)
            }}
            placeholder={t('或直接粘贴规则包 JSON 内容')}
            spellCheck={false}
            className="min-h-[120px] w-full resize-y rounded-[var(--md-sys-shape-corner)] border p-3 font-mono text-xs outline-none transition-colors focus:border-[var(--md-sys-color-primary)]"
            style={{
              borderColor: 'var(--md-sys-color-outline)',
              backgroundColor: 'var(--md-sys-color-surface-container-lowest)',
              color: 'var(--md-sys-color-on-surface)',
            }}
          />

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => void runImport(true)}
              loading={previewing}
              disabled={importing}
            >
              {t('预检')}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={handleImportClick}
              loading={importing}
              disabled={previewing}
            >
              {t('确认导入')}
            </Button>
            {text && (
              <Text type="secondary" className="text-xs">
                {t('共 {{count}} 个字符', { count: text.length })}
              </Text>
            )}
          </div>
        </div>

        {report && <ImportReportView report={report} />}
      </Card>

      <Card className="p-4 sm:p-5">
        <SectionHeader
          icon={<Globe2 className="h-4 w-4" />}
          title={t('站点规则')}
          subtitle={t('导入后即刻参与全网搜片；停用的规则不会被搜索')}
          extra={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                icon={<Download className="h-4 w-4" />}
                onClick={() => void handleExport()}
                disabled={rules.length === 0}
              >
                {t('导出全部')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                onClick={() => setBatchDeleteConfirm(true)}
                disabled={selectedRuleIds.size === 0}
                title={t('删除选中的规则')}
              >
                {t('批量删除')}
              </Button>
              <Button
                size="sm"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={() => void loadAll()}
                title={t('刷新')}
              />
            </div>
          }
        />

        {rules.length > 0 && (
          <div
            className="mt-3 flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] border px-3 py-2"
            style={{
              borderColor: 'var(--md-sys-color-outline)',
              backgroundColor: 'var(--glass-bg)',
            }}
          >
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
              checked={
                rules.length > 0 &&
                rules.every((rule) => selectedRuleIds.has(rule.id))
              }
              onChange={(event) =>
                setSelectedRuleIds(
                  event.target.checked
                    ? new Set(rules.map((rule) => rule.id))
                    : new Set()
                )
              }
            />
            <Text type="secondary" className="text-sm">
              {t('全选 ({{size}} / {{length}})', {
                size: selectedRuleIds.size,
                length: rules.length,
              })}
            </Text>
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2">
          {rules.length === 0 ? (
            <EmptyState
              icon={<Globe2 className="h-8 w-8" />}
              text={t('还没有站点规则，先在上方导入一个规则包')}
            />
          ) : (
            rules.map((rule) => (
              <div
                key={rule.id}
                data-rule-id={rule.id}
                className={cn(
                  'flex flex-wrap items-center gap-3 rounded-[var(--md-sys-shape-corner)] border p-3',
                  selectedRuleIds.has(rule.id) &&
                    'bg-[var(--md-sys-color-primary-container)]'
                )}
                style={{
                  borderColor: selectedRuleIds.has(rule.id)
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline-variant)',
                }}
              >
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
                  aria-label={t('选择该规则')}
                  checked={selectedRuleIds.has(rule.id)}
                  onChange={(event) => {
                    const next = new Set(selectedRuleIds)
                    if (event.target.checked) {
                      next.add(rule.id)
                    } else {
                      next.delete(rule.id)
                    }
                    setSelectedRuleIds(next)
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Title level={5} className="m-0 truncate text-sm">
                      {rule.name}
                    </Title>
                    {rule.visibility === 'root' && (
                      <Tag color="warning" tinted>
                        {t('仅管理员')}
                      </Tag>
                    )}
                    <Tag tinted>
                      {t('v{{version}}', { version: rule.version })}
                    </Tag>
                  </div>
                  <Text
                    type="secondary"
                    className="mt-0.5 block truncate text-xs"
                  >
                    {rule.site}
                    {' · '}
                    {t('搜索 {{count}} 次', {
                      count: rule.stats?.searches ?? 0,
                    })}
                  </Text>
                  {rule.stats?.last_error && (
                    <Text
                      className="mt-0.5 block truncate text-xs"
                      style={{ color: 'var(--md-sys-color-error)' }}
                    >
                      {t('最近错误：{{error}}', {
                        error: rule.stats.last_error,
                      })}
                    </Text>
                  )}
                </div>
                <Switch
                  checked={rule.enabled}
                  onChange={(event) =>
                    void handleToggleRule(rule, event.target.checked)
                  }
                  aria-label={t('启用该规则')}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => setDeleteTarget(rule)}
                  title={t('删除')}
                />
              </div>
            ))
          )}
        </div>
      </Card>

      <Card className="p-4 sm:p-5">
        <SectionHeader
          icon={<Globe2 className="h-4 w-4" />}
          title={t('内置库来源')}
          subtitle={t(
            '这些条目在各自的库里执行；导入后编译成本地规则，可以在这里编辑'
          )}
          extra={
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => void fetchLibraries()}
              title={t('刷新')}
            />
          }
        />
        <div className="mt-3 flex flex-col gap-2">
          {(() => {
            const rows = libraries
              .filter((library) => library.id !== 'local')
              .flatMap((library) =>
                (library.sources ?? []).map((source) => ({ library, source }))
              )
            if (rows.length === 0) {
              return (
                <EmptyState
                  icon={<Globe2 className="h-8 w-8" />}
                  text={t('三个内置库暂无来源，先在「来源库」里配置地址')}
                />
              )
            }
            return rows.map(({ library, source }) => {
              const imported = rules.some((rule) => rule.name === source.name)
              const busy = importingSource === `${library.id}:${source.name}`
              return (
                <div
                  key={`${library.id}:${source.id}`}
                  className="flex flex-wrap items-center gap-3 rounded-[var(--md-sys-shape-corner)] border p-3"
                  style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Title level={5} className="m-0 truncate text-sm">
                        {source.name}
                      </Title>
                      <Tag tinted>{library.name}</Tag>
                      {imported && <Tag color="success">{t('已导入')}</Tag>}
                    </div>
                    <Text type="secondary" className="mt-0.5 block text-xs">
                      {library.description}
                    </Text>
                  </div>
                  {!imported && (
                    <Button
                      size="sm"
                      loading={busy}
                      onClick={() =>
                        void handleImportSource(library.id, source.name)
                      }
                    >
                      {t('导入')}
                    </Button>
                  )}
                </div>
              )
            })
          })()}
        </div>
      </Card>

      {/* 破坏性操作不用 ConfirmModal：它的确认键是 primary 蓝，看不出危险 */}
      <Modal
        open={replaceConfirm}
        onClose={() => setReplaceConfirm(false)}
        title={t('确认替换全部规则？')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setReplaceConfirm(false)}
              disabled={importing}
            >
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={importing}
              onClick={() => {
                setReplaceConfirm(false)
                void runImport(false)
              }}
            >
              {t('替换并导入')}
            </Button>
          </>
        }
      >
        <Text>
          {t(
            '替换会先清空当前 {{count}} 条规则，再导入包内规则。清空前会自动备份到规则目录，仍建议确认包内容无误。',
            { count: rules.length }
          )}
        </Text>
      </Modal>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('删除规则')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" onClick={() => void handleDelete()}>
              {t('删除')}
            </Button>
          </>
        }
      >
        <Text>
          {t('确定删除「{{name}}」？删除后该站点将不再参与全网搜片。', {
            name: deleteTarget?.name ?? '',
          })}
        </Text>
      </Modal>

      <Modal
        open={batchDeleteConfirm}
        onClose={() => setBatchDeleteConfirm(false)}
        title={t('批量删除规则')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setBatchDeleteConfirm(false)}
              disabled={batchDeleting}
            >
              {t('取消')}
            </Button>
            <Button
              variant="danger"
              loading={batchDeleting}
              disabled={batchDeleting}
              onClick={() => void handleBatchDelete()}
            >
              {t('删除')}
            </Button>
          </>
        }
      >
        <Text>
          {t('确定要删除选中的 {{count}} 条规则吗？此操作不可撤销。', {
            count: selectedRuleIds.size,
          })}
        </Text>
      </Modal>
    </div>
  )
}

function ImportReportView({ report }: { report: ImportReport }) {
  const items = report.items ?? []
  const problems = items.filter((item) => item.action === 'failed')
  const warnings = report.warnings ?? []
  return (
    <div
      className="mt-4 rounded-[var(--md-sys-shape-corner)] border p-3"
      style={{
        borderColor: problems.length
          ? 'var(--md-sys-color-error)'
          : 'var(--md-sys-color-outline-variant)',
        backgroundColor: 'var(--glass-bg)',
      }}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="font-medium">
          {report.dryRun ? t('预检结果') : t('导入结果')}
        </span>
        <span className="text-[var(--md-sys-color-on-surface-variant)]">
          {t(
            '共 {{total}} 条：新增 {{imported}}，更新 {{updated}}，失败 {{failed}}',
            {
              total: report.total,
              imported: report.imported,
              updated: report.updated,
              failed: report.failed,
            }
          )}
        </span>
        {report.dryRun && problems.length === 0 && (
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {t('可以直接导入')}
          </span>
        )}
      </div>

      {report.backupFile && (
        <div className="mt-1 break-all text-xs text-[var(--md-sys-color-on-surface-variant)]">
          {t('替换前已备份到 {{path}}', { path: report.backupFile })}
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {warnings.map((warning) => (
            <li
              key={warning}
              className="flex items-start gap-1.5 text-xs"
              style={{ color: 'var(--md-sys-color-tertiary)' }}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="mt-2 max-h-56 overflow-y-auto">
          <ul className="flex flex-col gap-1">
            {items.map((item, index) => (
              <li key={`${item.name}-${index}`} className="text-xs">
                <span
                  className={cn(
                    'mr-1.5 inline-block rounded px-1.5 py-0.5 text-[11px]',
                    item.action === 'failed'
                      ? 'text-[var(--md-sys-color-on-error-container)]'
                      : 'text-[var(--md-sys-color-on-secondary-container)]'
                  )}
                  style={{
                    backgroundColor:
                      item.action === 'failed'
                        ? 'var(--md-sys-color-error-container)'
                        : 'var(--md-sys-color-secondary-container)',
                  }}
                >
                  {item.action === 'create'
                    ? t('新增')
                    : item.action === 'update'
                      ? t('更新')
                      : t('失败')}
                </span>
                <span className="font-medium">
                  {item.name || t('未命名规则')}
                </span>
                {item.error && (
                  <span style={{ color: 'var(--md-sys-color-error)' }}>
                    {' · '}
                    {item.error}
                  </span>
                )}
                {(item.warnings ?? []).map((warning) => (
                  <div
                    key={warning}
                    className="ml-1 mt-0.5 flex items-start gap-1 text-[11px]"
                    style={{ color: 'var(--md-sys-color-tertiary)' }}
                  >
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{warning}</span>
                  </div>
                ))}
                {(item.notes ?? []).map((note) => (
                  <div
                    key={note}
                    className="ml-1 mt-0.5 text-[11px] text-[var(--md-sys-color-on-surface-variant)]"
                  >
                    {note}
                  </div>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
