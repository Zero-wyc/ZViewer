/**
 * B站视频下载 Popup。
 *
 * 交互流程：
 *   1. 输入视频链接或 BV 号
 *   2. 点击「解析视频」→ 调用 resolveBilibili 获取视频信息和支持清晰度
 *   3. 显示视频卡片（标题、时长、多 P 选择、清晰度按钮组）
 *   4. 选择清晰度后点击「开始下载」
 *
 * 仅 MP4 单文件直链模式（最高 720P）。高画质（需服务器端 FFmpeg 合并）已移除，
 * 请使用 CLI 模式下载高画质。
 *
 * 设计语言要点：
 * - 8x8 rounded icon container + 135° gradient header
 * - text-[10px] uppercase tracking-wide 字段标签
 * - 自定义清晰度按钮组，避免原生 select 直角边框
 * - surface-container-high 圆角 inset 承载进度区域
 * - 含 root 切换 + 目录浏览副面板
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Tv,
  X,
  Download,
  HardDrive,
  Folder,
  Check,
  Search,
  Film,
  Clock,
  ListVideo,
  Crown,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ModalShell } from '@/components/ui/ModalShell'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { formatDuration, formatFileSize } from '@/lib/utils'
import { resolveBilibili } from '@/modules/bilibili/bilibiliApi'
import type { QualityOption, ResolvedSource } from '@/modules/bilibili/types'
import {
  browseServerFiles,
  downloadBilibiliVideo,
  extractRootKey,
  listServerRoots,
} from './serverFilesApi'
import { DirPickerSidePanel } from './DirPickerSidePanel'
import { VIP_ONLY_QNS } from '@/modules/bilibili/quality'
import type { ServerFileEntry, ServerFileRoot } from './types'
import { t as translate } from '@/i18n'

/** MP4 模式最高 qn（B站 html5 MP4 接口实际最高仅 720P） */
const MP4_MAX_QN = 64

export interface BilibiliDownloadModalProps {
  open: boolean
  onClose: () => void
}

export function BilibiliDownloadModal({
  open,
  onClose,
}: BilibiliDownloadModalProps) {
  // 步骤状态
  // - 'input'：输入 URL 阶段
  // - 'resolved'：解析完成，选择清晰度阶段
  // - 'downloading'：下载中
  type Step = 'input' | 'resolved' | 'downloading'
  const [step, setStep] = useState<Step>('input')

  // 输入阶段
  const [url, setUrl] = useState('')
  const [parsing, setParsing] = useState(false)
  const [parseMessage, setParseMessage] = useState('')

  // 解析结果
  const [resolved, setResolved] = useState<ResolvedSource | null>(null)
  const [selectedPage, setSelectedPage] = useState(1)
  const [selectedQn, setSelectedQn] = useState<number>(MP4_MAX_QN)

  // 文件名
  const [filename, setFilename] = useState('')

  // 目标目录
  const [roots, setRoots] = useState<ServerFileRoot[]>([])
  const [targetPath, setTargetPath] = useState('uploads:/')
  const [rootsMenuOpen, setRootsMenuOpen] = useState(false)
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  const [dirEntries, setDirEntries] = useState<ServerFileEntry[]>([])
  const [dirLoading, setDirLoading] = useState(false)

  // 下载状态
  const [stage, setStage] = useState<'parsing' | 'downloading' | null>(null)
  const [stageMessage, setStageMessage] = useState('')
  const [percent, setPercent] = useState(0)
  const [received, setReceived] = useState(0)
  const [total, setTotal] = useState(0)

  const currentRootKey = extractRootKey(targetPath)
  const currentRoot = roots.find((r) => r.key === currentRootKey)
  const readonly = !!currentRoot?.readonly

  // 加载根列表
  const loadRoots = useCallback(async () => {
    try {
      const list = await listServerRoots()
      setRoots(list)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : translate('加载根目录失败')
      )
    }
  }, [])

  // React Compiler 严格规则误报：Modal 可见时一次性加载根目录。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      if (roots.length === 0) void loadRoots()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 关闭根目录下拉
  useEffect(() => {
    if (!rootsMenuOpen) return
    const onClick = () => setRootsMenuOpen(false)
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [rootsMenuOpen])

  // 加载目录
  const loadDir = useCallback(async (path: string) => {
    setDirLoading(true)
    try {
      const data = await browseServerFiles(path)
      setDirEntries(data.entries.filter((e) => e.type === 'directory'))
    } catch {
      setDirEntries([])
    } finally {
      setDirLoading(false)
    }
  }, [])

  // 打开目录选择副面板
  const openDirPicker = () => {
    if (!dirPickerOpen) {
      setDirPickerOpen(true)
      void loadDir(targetPath)
    } else {
      setDirPickerOpen(false)
    }
  }

  // 重置到输入阶段
  const resetToInput = useCallback(() => {
    setStep('input')
    setResolved(null)
    setParsing(false)
    setParseMessage('')
    setSelectedPage(1)
    setSelectedQn(MP4_MAX_QN)
    setFilename('')
    setStage(null)
    setStageMessage('')
    setPercent(0)
    setReceived(0)
    setTotal(0)
  }, [])

  // 完全关闭
  const handleClose = () => {
    if (stage === 'parsing' || stage === 'downloading') return
    resetToInput()
    setUrl('')
    setDirPickerOpen(false)
    setRootsMenuOpen(false)
    onClose()
  }

  // 解析视频
  const handleParse = async () => {
    const trimmedUrl = url.trim()
    if (!trimmedUrl) {
      message.warning(translate('请输入 B站视频链接或 BV 号'))
      return
    }
    setParsing(true)
    setParseMessage(translate('正在解析视频地址...'))
    try {
      const result = await resolveBilibili(
        trimmedUrl,
        undefined,
        (_step, msg) => {
          setParseMessage(msg)
        },
        { preferMp4: false }
      )
      setResolved(result)
      setSelectedPage(result.currentPage ?? 1)
      // 默认选中最高可用清晰度（优先 720P，无则取列表第一个）
      // 高于 720P 的画质需要服务器端 FFmpeg 合并（已移除），统一回退 720P
      const accept = result.acceptQuality ?? []
      const preferred = accept.find((q) => q.id === MP4_MAX_QN) ??
        accept.find((q) => q.id <= MP4_MAX_QN) ??
        accept[0] ?? { id: MP4_MAX_QN, label: '720P' }
      setSelectedQn(preferred.id)
      setStep('resolved')
    } catch (err) {
      message.error(err instanceof Error ? err.message : translate('解析失败'))
    } finally {
      setParsing(false)
      setParseMessage('')
    }
  }

  // 下载
  const handleDownload = async () => {
    if (!resolved) return
    if (readonly) {
      message.warning(translate('目标目录为只读，请选择其他目录'))
      return
    }
    setStep('downloading')
    setStage('parsing')
    setStageMessage(translate('正在请求下载...'))
    setPercent(0)
    setReceived(0)
    setTotal(0)
    try {
      const result = await downloadBilibiliVideo(
        {
          url: url.trim(),
          targetDir: targetPath,
          filename: filename.trim() || undefined,
          qn: selectedQn,
          page: selectedPage > 0 ? selectedPage : undefined,
        },
        {
          onParsing: (_step, msg) => {
            setStage('parsing')
            setStageMessage(msg)
          },
          onDownloading: (r, t, p) => {
            setStage('downloading')
            setReceived(r)
            setTotal(t)
            setPercent(p)
          },
        }
      )
      message.success(translate('已下载「{{name}}」', { name: result.name }))
      handleClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : translate('下载失败'))
      setStep('resolved')
    } finally {
      setStage(null)
    }
  }

  return (
    <ModalShell
      open={open}
      onClose={handleClose}
      align="top"
      backdrop="light"
      className="flex max-h-[calc(100vh-160px)]"
      style={{ contain: 'layout paint', backfaceVisibility: 'hidden' }}
    >
      {/* 主面板 */}
      <div className="glass flex w-[440px] flex-shrink-0 flex-col">
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between p-5 pb-3">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
              style={{
                background:
                  'linear-gradient(135deg, var(--md-sys-color-primary), var(--md-sys-color-tertiary))',
                color: 'var(--md-sys-color-on-primary)',
              }}
            >
              <Tv className="h-4 w-4" />
            </div>
            <div className="flex flex-col">
              <Text className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
                {translate('下载 B站视频')}
              </Text>
              <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                BILIBILI DOWNLOAD
              </Text>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={!!stage}
            className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 表单内容（滚动区） */}
        <div className="zen-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-2">
          {/* 步骤 1：输入 URL */}
          <div className="flex flex-col gap-1.5">
            <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
              {translate('视频链接或 BV 号')}
            </Text>
            <div className="flex gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://www.bilibili.com/video/BVxxxxx"
                autoFocus
                disabled={parsing || step !== 'input'}
                size="sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && step === 'input' && !parsing) {
                    void handleParse()
                  }
                }}
              />
              {step === 'input' && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={
                    parsing ? (
                      <Spinner size={14} />
                    ) : (
                      <Search className="h-3.5 w-3.5" />
                    )
                  }
                  onClick={() => void handleParse()}
                  disabled={parsing || !url.trim()}
                >
                  {translate('解析')}
                </Button>
              )}
              {step !== 'input' && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => resetToInput()}
                  disabled={!!stage}
                >
                  {translate('重新输入')}
                </Button>
              )}
            </div>
            {parsing && parseMessage && (
              <Text className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                {parseMessage}
              </Text>
            )}
          </div>

          {/* 步骤 2：解析结果 */}
          {step !== 'input' && resolved && (
            <>
              {/* 视频信息卡片 */}
              <VideoInfoCard
                resolved={resolved}
                duration={formatDuration(resolved.duration, '')}
              />

              {/* 多 P 选择 */}
              {resolved.pages && resolved.pages.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                    {translate('分集（共 {{length}} P）', {
                      length: resolved.pages.length,
                    })}
                  </Text>
                  <div className="zen-scroll max-h-32 overflow-y-auto rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] p-1.5">
                    <div className="grid grid-cols-1 gap-1">
                      {resolved.pages.map((p) => {
                        const active = selectedPage === p.page
                        return (
                          <button
                            key={p.page}
                            type="button"
                            disabled={!!stage}
                            onClick={() => setSelectedPage(p.page)}
                            className="flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors disabled:opacity-40"
                            style={{
                              backgroundColor: active
                                ? 'var(--md-sys-color-primary-container)'
                                : 'transparent',
                              color: active
                                ? 'var(--md-sys-color-on-primary-container)'
                                : 'var(--md-sys-color-on-surface-variant)',
                            }}
                          >
                            <span className="text-[10px] font-medium uppercase tracking-wide opacity-70">
                              P{p.page}
                            </span>
                            <span className="truncate text-xs">{p.part}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}

              {/* 清晰度按钮组（基于解析结果） */}
              <QualitySelector
                acceptQuality={resolved.acceptQuality}
                selectedQn={selectedQn}
                disabled={!!stage}
                vipStatus={resolved.vipStatus ?? 0}
                onSelect={setSelectedQn}
              />

              {/* 模式提示 */}
              <div className="flex items-center gap-1.5">
                <div
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary)',
                  }}
                />
                <Text className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                  {translate(
                    'MP4 直链模式 · 最高 720P（高画质请使用 CLI 模式下载）'
                  )}
                </Text>
              </div>

              {/* 文件名 */}
              <div className="flex flex-col gap-1.5">
                <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {translate('文件名（可选，留空使用视频标题）')}
                </Text>
                <Input
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder={resolved.title ?? translate('如：我的视频')}
                  disabled={!!stage}
                  size="sm"
                />
              </div>

              {/* 保存目录 */}
              <div className="flex flex-col gap-1.5">
                <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {translate('保存到')}
                </Text>
                <div className="flex gap-2">
                  <div className="relative">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<HardDrive className="h-3.5 w-3.5" />}
                      onClick={(e) => {
                        e.stopPropagation()
                        setRootsMenuOpen((v) => !v)
                      }}
                      disabled={!!stage}
                    >
                      {currentRoot?.name ?? translate('根目录')}
                    </Button>
                    {rootsMenuOpen && (
                      <div
                        className="glass absolute left-0 top-full z-30 mt-1 min-w-[220px] rounded-[var(--md-sys-shape-corner)] p-1 shadow-lg"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {roots.map((r) => (
                          <button
                            key={r.key}
                            type="button"
                            onClick={() => {
                              setTargetPath(`${r.key}:/`)
                              setRootsMenuOpen(false)
                              setDirPickerOpen(false)
                            }}
                            disabled={!r.exists}
                            className="flex w-full items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)] disabled:opacity-40"
                          >
                            <HardDrive
                              className="h-3.5 w-3.5 shrink-0"
                              style={{
                                color:
                                  r.key === currentRootKey
                                    ? 'var(--md-sys-color-primary)'
                                    : 'var(--md-sys-color-on-surface-variant)',
                              }}
                            />
                            <Text
                              className={
                                'truncate text-xs font-medium ' +
                                (r.key === currentRootKey
                                  ? 'text-[var(--md-sys-color-primary)]'
                                  : '')
                              }
                            >
                              {r.name}
                            </Text>
                            {r.key === currentRootKey && (
                              <Check className="h-3.5 w-3.5 shrink-0 text-[var(--md-sys-color-primary)]" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <Text
                    className="min-w-0 flex-1 truncate self-center rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-2.5 py-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]"
                    title={targetPath}
                  >
                    {targetPath}
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Folder className="h-3.5 w-3.5" />}
                    onClick={openDirPicker}
                    disabled={!!stage}
                  >
                    {dirPickerOpen ? translate('收起') : translate('浏览')}
                  </Button>
                </div>
                {readonly && (
                  <Text className="text-[10px] text-[var(--md-sys-color-error)]">
                    {translate('该根目录为只读，请选择其他目录')}
                  </Text>
                )}
              </div>

              {/* 下载进度 */}
              {step === 'downloading' && stage && (
                <div
                  className="flex flex-col gap-2 rounded-[var(--md-sys-shape-corner)] p-3"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      {stage === 'parsing' ? (
                        <Spinner size={16} />
                      ) : (
                        <Download className="h-3.5 w-3.5 text-[var(--md-sys-color-primary)]" />
                      )}
                      <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface)]">
                        {stage === 'parsing'
                          ? translate('解析中')
                          : translate('下载视频')}
                      </Text>
                    </div>
                    {stage === 'downloading' && (
                      <Text className="text-[10px] font-medium uppercase tracking-wide text-[var(--md-sys-color-primary)]">
                        {percent}%
                      </Text>
                    )}
                  </div>
                  <Text
                    className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]"
                    title={stageMessage}
                  >
                    {stageMessage || translate('处理中...')}
                  </Text>
                  {stage === 'downloading' && (
                    <>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container)]">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${percent}%`,
                            backgroundColor: 'var(--md-sys-color-primary)',
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                        <span>{formatFileSize(received)}</span>
                        <span>
                          {total > 0
                            ? translate('共 {{value}}', {
                                value: formatFileSize(total),
                              })
                            : translate('大小未知')}
                        </span>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex shrink-0 items-center justify-end gap-3 p-5 pt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={handleClose}
            disabled={!!stage}
          >
            {translate('取消')}
          </Button>
          {step === 'resolved' && (
            <Button
              variant="primary"
              size="sm"
              icon={<Download className="h-4 w-4" />}
              onClick={() => void handleDownload()}
              disabled={!!stage || readonly || selectedQn > MP4_MAX_QN}
            >
              {translate('开始下载')}
            </Button>
          )}
        </div>
      </div>

      {/* 副面板：目录浏览 */}
      <DirPickerSidePanel
        open={dirPickerOpen}
        loading={dirLoading}
        entries={dirEntries.map((e) => ({ key: e.path, name: e.name }))}
        currentPath={targetPath}
        isRoot={!!targetPath.match(/^(uploads|custom:\d+):\/?$/)}
        onEnter={(key) => {
          setTargetPath(key)
          void loadDir(key)
        }}
        onBack={() => {
          const match = targetPath.match(/^(uploads|custom:\d+):(.*)$/)
          if (!match) return
          const rootKey = match[1]
          const rel = match[2].replace(/^\/+/, '')
          if (!rel) return
          const parent = rel.split('/').slice(0, -1).join('/')
          const parentPath = `${rootKey}:/${parent}`
          setTargetPath(parentPath)
          void loadDir(parentPath)
        }}
        onSelect={() => setDirPickerOpen(false)}
        onClose={() => setDirPickerOpen(false)}
      />
    </ModalShell>
  )
}

// ============ 视频信息卡片 ============

interface VideoInfoCardProps {
  resolved: ResolvedSource
  duration: string
}

function VideoInfoCard({ resolved, duration }: VideoInfoCardProps) {
  const isVip = resolved.vipStatus === 1
  return (
    <div
      className="flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] p-3"
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container-high)',
      }}
    >
      <div
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
        style={{
          backgroundColor: 'var(--md-sys-color-primary-container)',
          color: 'var(--md-sys-color-on-primary-container)',
        }}
      >
        <Film className="h-5 w-5" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Text
          className="truncate text-xs font-medium text-[var(--md-sys-color-on-surface)]"
          title={resolved.title}
        >
          {resolved.title ?? translate('未知视频')}
        </Text>
        <div className="flex items-center gap-3 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
          {duration && (
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>{duration}</span>
            </div>
          )}
          {resolved.pages && resolved.pages.length > 1 && (
            <div className="flex items-center gap-1">
              <ListVideo className="h-3 w-3" />
              <span>
                {translate('共 {{length}} P', {
                  length: resolved.pages.length,
                })}
              </span>
            </div>
          )}
          <div
            className="flex items-center gap-1 rounded-full px-1.5 py-0.5"
            style={{
              backgroundColor: isVip
                ? 'var(--md-sys-color-tertiary-container)'
                : 'var(--md-sys-color-surface-container-highest)',
              color: isVip
                ? 'var(--md-sys-color-on-tertiary-container)'
                : 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            <Crown className="h-3 w-3" />
            <span>{isVip ? translate('大会员') : translate('非会员')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ 清晰度选择器 ============

interface QualitySelectorProps {
  acceptQuality: QualityOption[] | undefined
  selectedQn: number
  disabled: boolean
  vipStatus: number
  onSelect: (qn: number) => void
}

function QualitySelector({
  acceptQuality,
  selectedQn,
  disabled,
  vipStatus,
  onSelect,
}: QualitySelectorProps) {
  // 没有清晰度列表时，显示固定的 4 个 MP4 选项作为兜底
  const list =
    acceptQuality && acceptQuality.length > 0
      ? acceptQuality
      : ([
          { id: 16, label: '360P' },
          { id: 32, label: '480P' },
          { id: 64, label: '720P' },
          { id: 80, label: '1080P' },
        ] as QualityOption[])

  const isVip = vipStatus === 1

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
          {translate('清晰度（共 {{length}} 个可用）', { length: list.length })}
        </Text>
        <div className="flex items-center gap-1">
          <div
            className="h-1.5 w-1.5 rounded-full"
            style={{
              backgroundColor: isVip
                ? 'var(--md-sys-color-tertiary)'
                : 'var(--md-sys-color-outline)',
            }}
          />
          <Text
            className="text-[10px] uppercase tracking-wide"
            style={{
              color: isVip
                ? 'var(--md-sys-color-tertiary)'
                : 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            {isVip ? translate('大会员') : translate('非会员')}
          </Text>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {list.map((opt) => {
          const active = selectedQn === opt.id
          // 高于 720P 的画质需要服务器端 FFmpeg 合并（已移除），恒禁用
          const disabledByNoMerge = opt.id > MP4_MAX_QN
          const isVipOnly = VIP_ONLY_QNS.includes(opt.id)
          const disabledByVip = isVipOnly && !isVip
          const isDisabled = disabled || disabledByNoMerge || disabledByVip
          const title = disabledByVip
            ? translate('需要大会员账号才能下载此画质')
            : disabledByNoMerge
              ? translate('服务器端 FFmpeg 已移除，高画质请使用 CLI 模式下载')
              : undefined
          return (
            <button
              key={opt.id}
              type="button"
              disabled={isDisabled}
              onClick={() => onSelect(opt.id)}
              title={title}
              className="relative flex flex-col items-center gap-0.5 rounded-[var(--md-sys-shape-corner)] px-1 py-2 text-xs transition-all disabled:cursor-not-allowed"
              style={{
                backgroundColor: active
                  ? 'var(--md-sys-color-primary-container)'
                  : 'var(--md-sys-color-surface-container-high)',
                color: active
                  ? 'var(--md-sys-color-on-primary-container)'
                  : 'var(--md-sys-color-on-surface-variant)',
                border: active
                  ? '1px solid var(--md-sys-color-primary)'
                  : '1px solid transparent',
                opacity: isDisabled ? 0.35 : 1,
              }}
            >
              <span className="text-xs font-medium">{opt.label}</span>
              {opt.resolution && (
                <span className="text-[9px] uppercase tracking-wide opacity-70">
                  {opt.resolution}
                </span>
              )}
              {/* VIP 专属标识：右上角小圆点 */}
              {isVipOnly && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
                  style={{
                    backgroundColor: disabledByVip
                      ? 'var(--md-sys-color-error)'
                      : 'var(--md-sys-color-tertiary)',
                  }}
                  title={translate('大会员专属')}
                />
              )}
            </button>
          )
        })}
      </div>
      {!isVip && (
        <Text className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
          带
          <span
            className="mx-1 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{ backgroundColor: 'var(--md-sys-color-error)' }}
          />
          标识的清晰度需要大会员账号
        </Text>
      )}
    </div>
  )
}
