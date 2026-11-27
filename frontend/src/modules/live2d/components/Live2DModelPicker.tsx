import { useState } from 'react'
import { Check, Link2, Pencil, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { t } from '@/i18n'
import { cn, formatFileSize } from '@/lib/utils'
import type { Live2DModelEntry } from '../core/model-catalog'
import { validateModelUrl } from '../core/model-url'
import {
  LIVE2D_LIBRARY_MAX_PER_OWNER,
  LIVE2D_LIBRARY_MAX_TOTAL,
  LIVE2D_UPLOAD_MAX_BYTES,
  libraryModelThumbUrl,
  type Live2DLibraryEntry,
} from '../core/model-library'
import type { Live2DModelKind } from '../types'
import { Panel } from './Panel'

// 模型来源选择：本服模型（随包 + 服务端上传库）、自定义地址，两段平铺。
//
// 为什么把「内置模型」和「模型库」合成一段：从用户角度看，这两者都是"这个
// 服务器上能选的角色"，区别只在于谁把文件放进来的（部署时随包 vs 有人上传）。
// 分成两个列表会让人以为它们是两种东西，而实际上选哪个效果完全一样——协议里
// 的 kind 仍然分成 builtin/room，那只是数据出处，不该漏到界面上。
//
// 为什么是立绘卡片而不是一行行 chip：模型认得出来靠的是画面，不是名字。
// 26px 的小方块只够看出配色，选模型还得逐个点开试。卡片给到 4:5 的竖幅，
// 名字压在底部渐变上，五六个模型一屏放得下，扫一眼就挑完了。
//
// 上传/导入/管理放在标题右侧的图标按钮里：它们是低频动作，用文字会和"选哪个
// 模型"这件正事抢注意力；配额之类的一次性说明放 title，不占版面。

export interface ModelPickerValue {
  kind: Live2DModelKind
  id: string
}

export interface Live2DModelPickerProps {
  builtins: Live2DModelEntry[]
  libraryModels: Live2DLibraryEntry[]
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  /** 房主才能填自定义地址（外链会让每个人的浏览器都去拉第三方资源） */
  allowUrl: boolean
  disabled?: boolean
  /** 卡片标题；缺省是「本服模型」 */
  title?: string
  /** 上传入口：只有登录用户能传，不传这个 prop 就不显示按钮 */
  upload?: { uploading: boolean; onUpload: (file: File) => void }
  /**
   * 从链接导入：由服务端去下载，成功后模型进库（不是直接切过去）。
   * 返回 true 表示已入库，行会收起来。
   */
  urlImport?: { onImport: (url: string) => Promise<boolean> }
  /** 当前用户有权删除的模型 id（服务端下发的 deletable）；为空则没有管理入口 */
  removableIds?: string[]
  onDeleteModel?: (modelId: string) => void
}

export function Live2DModelPicker({
  builtins,
  libraryModels,
  value,
  onSelect,
  allowUrl,
  disabled = false,
  title,
  upload,
  urlImport,
  removableIds,
  onDeleteModel,
}: Live2DModelPickerProps) {
  // 管理态是纯本机的临时视图，不进任何 store：它只决定"能不能删"，与选了
  // 哪个模型无关。
  const [managing, setManaging] = useState(false)
  // 导入行同理，展开与否不影响房间里的任何状态。
  const [importOpen, setImportOpen] = useState(false)
  const removable = new Set(removableIds ?? [])
  const canManage = removable.size > 0 && Boolean(onDeleteModel)
  const activeManaging = managing && canManage

  const items: TileItem[] = [
    ...builtins.map((item) => ({
      kind: 'builtin' as Live2DModelKind,
      id: item.id,
      label: item.label,
      removable: false,
      bytes: 0,
      // 内置模型是随部署包发的静态资源，服务端不接管它们，缩略图只能由
      // 部署方在清单里登记（可选），没有就画首字。
      thumb: item.thumb,
    })),
    ...libraryModels.map((item) => ({
      kind: 'room' as Live2DModelKind,
      id: item.id,
      label: item.label,
      removable: removable.has(item.id),
      bytes: item.bytes,
      thumb: item.hasThumb ? libraryModelThumbUrl(item.id) : undefined,
    })),
  ]

  return (
    <Panel
      title={title ?? t('本服模型')}
      action={
        <>
          {canManage && (
            <ToolButton
              onClick={() => setManaging((prev) => !prev)}
              title={activeManaging ? t('结束管理') : t('管理')}
              active={activeManaging}
              label={activeManaging ? t('结束管理') : t('管理')}
            >
              <Pencil size={13} />
            </ToolButton>
          )}
          {upload && (
            <UploadButton
              uploading={upload.uploading}
              onUpload={upload.onUpload}
              // 配额只在 title 里说：真正超了由服务端拒绝并给出具体原因，
              // 界面上常驻一行"每人 8 个"只会占地方。
              // 配额与模型包要求只在这里说：真正超了/包不对由服务端拒绝并给出
              // 具体原因，界面上常驻两行说明只会把左列撑出可视高度。
              title={`${t('每人最多 {{perOwner}} 个，全库最多 {{total}} 个', {
                perOwner: LIVE2D_LIBRARY_MAX_PER_OWNER,
                total: LIVE2D_LIBRARY_MAX_TOTAL,
              })} · ${t(
                '模型包是 zip，需含 model3.json（贴图/动作一并保留），不超过 {{size}}MB；上传后所有房间都能选',
                { size: LIVE2D_UPLOAD_MAX_BYTES >> 20 }
              )}`}
            />
          )}
          {urlImport && (
            <ToolButton
              onClick={() => setImportOpen((prev) => !prev)}
              title={t('从链接导入 zip 模型包')}
              active={importOpen}
              label={t('从链接导入 zip 模型包')}
            >
              <Link2 size={13} />
            </ToolButton>
          )}
        </>
      }
    >
      {/* 列数跟着容器宽度自适应：宽屏是两列布局（左列 ~500px），房间页是
          通栏（~640px），固定 3 列会让后者每张卡大得离谱。 */}
      {items.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-2">
          {items.map((item) => (
            <ModelTile
              key={`${item.kind}:${item.id}`}
              item={item}
              active={value.kind === item.kind && value.id === item.id}
              disabled={disabled}
              deleting={activeManaging && item.removable}
              onSelect={() => onSelect(item.kind, item.id)}
              onDelete={
                activeManaging && item.removable
                  ? () => onDeleteModel?.(item.id)
                  : undefined
              }
            />
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-[11px] leading-relaxed opacity-50">
          {/* 只说现状，不给做不到的承诺：游客不能上传，能不能传由传不传
              upload 这个 prop 决定（真的能传时按钮就在标题右边）。 */}
          {upload
            ? t('还没有可用的模型，上传一个模型包就能开始')
            : t('还没有可用的模型，等房主或别人上传一个')}
        </p>
      )}

      {urlImport && importOpen && (
        <ImportRow
          onImport={urlImport.onImport}
          onClose={() => setImportOpen(false)}
        />
      )}

      {allowUrl && (
        <UrlRow value={value} onSelect={onSelect} disabled={disabled} />
      )}
    </Panel>
  )
}

function UrlRow({
  value,
  onSelect,
  disabled,
}: {
  value: ModelPickerValue
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  disabled: boolean
}) {
  const [url, setUrl] = useState(value.kind === 'url' ? value.id : '')
  const [error, setError] = useState('')

  const apply = () => {
    const problem = validateModelUrl(url)
    if (problem) {
      setError(problem)
      return
    }
    setError('')
    onSelect('url', url.trim())
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') apply()
          }}
          placeholder="https://…/model3.json"
          disabled={disabled}
          size="sm"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          onClick={apply}
          disabled={disabled}
          aria-label={t('应用地址')}
          title={t('应用地址')}
          className="shrink-0"
        >
          <Link2 size={13} />
        </Button>
      </div>
      {error && (
        <p
          className="mt-1 text-[10px]"
          style={{ color: 'var(--md-sys-color-error)' }}
        >
          {error}
        </p>
      )}
    </div>
  )
}

function UploadButton({
  uploading,
  onUpload,
  title,
}: {
  uploading: boolean
  onUpload: (file: File) => void
  title?: string
}) {
  // input 无法美化，藏起来由 label 触发；value 每次都要清空，否则同一个文件
  // 连选两次不会触发 change。
  return (
    <label
      title={title}
      aria-label={t('上传模型包')}
      className={cn(
        'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_6%,transparent)] text-[var(--md-sys-color-on-surface-variant)] transition-colors',
        uploading
          ? 'cursor-not-allowed opacity-50'
          : 'hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_12%,transparent)]'
      )}
    >
      <Upload size={13} />
      <input
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onUpload(file)
        }}
      />
    </label>
  )
}

function ToolButton({
  onClick,
  children,
  title,
  label,
  active = false,
}: {
  onClick: () => void
  children: React.ReactNode
  title?: string
  label?: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label ?? title}
      aria-pressed={active}
      className={cn(
        'inline-flex h-6 w-6 items-center justify-center rounded-lg transition-colors',
        active
          ? 'bg-[color-mix(in_srgb,var(--md-sys-color-primary)_16%,transparent)] text-[var(--md-sys-color-primary)]'
          : 'bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_6%,transparent)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[color-mix(in_srgb,var(--md-sys-color-on-surface)_12%,transparent)]'
      )}
    >
      {children}
    </button>
  )
}

// 从链接导入：填一个 zip 直链，服务端去下。
//
// 这里不校验 URL 形态：能下不能下、是不是 zip、包全不全，全在服务端判，
// 前端提前拦一遍只会出现「前端说可以、后端说不行」和相反的假承诺。
function ImportRow({
  onImport,
  onClose,
}: {
  onImport: (url: string) => Promise<boolean>
  onClose: () => void
}) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    if (busy) return
    const trimmed = url.trim()
    if (!trimmed) {
      setError(t('请填写模型包的下载链接'))
      return
    }
    setError('')
    setBusy(true)
    const ok = await onImport(trimmed)
    setBusy(false)
    if (!ok) return
    setUrl('')
    onClose()
  }

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          placeholder="https://…/model.zip"
          disabled={busy}
          size="sm"
          className="min-w-0 flex-1"
        />
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={busy}
          className="shrink-0"
        >
          {busy ? t('导入中…') : t('导入')}
        </Button>
      </div>
      {error && (
        <p
          className="mt-1 text-[10px]"
          style={{ color: 'var(--md-sys-color-error)' }}
        >
          {error}
        </p>
      )}
    </div>
  )
}

interface TileItem {
  kind: Live2DModelKind
  id: string
  label: string
  /** 这个条目在管理态下能不能删（只有服务端说 deletable 的才行） */
  removable: boolean
  /** 大小（服务端已下发），管理态下显示，便于挑出占地方的那个 */
  bytes: number
  /** 缩略图地址；没有就画首字 */
  thumb?: string
}

/**
 * 一张立绘卡。
 *
 * 名字压在底部渐变上而不是排在卡片下面：卡片是 4:5 竖幅，图说完一切，
 * 多一行文字只会把网格撑高。渐变同时保证任何底色上白字都读得清。
 */
function ModelTile({
  item,
  active,
  disabled,
  deleting,
  onSelect,
  onDelete,
}: {
  item: TileItem
  active: boolean
  disabled: boolean
  deleting: boolean
  onSelect: () => void
  onDelete?: () => void
}) {
  // 清单可能比磁盘旧（模型刚被删、缩略图生成失败），加载失败就退回首字。
  const [broken, setBroken] = useState(false)
  const initial = Array.from(item.label)[0] ?? '?'
  const showThumb = Boolean(item.thumb) && !broken

  return (
    <div className="group relative">
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        aria-pressed={active}
        title={item.label}
        className={cn(
          'relative block aspect-square w-full overflow-hidden rounded-xl text-left transition-[filter,box-shadow]',
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:brightness-105',
          active && 'ring-2 ring-[var(--md-sys-color-primary)]'
        )}
        style={{
          background: 'var(--md-sys-color-surface-container-high)',
        }}
      >
        {showThumb ? (
          <img
            src={item.thumb}
            alt=""
            draggable={false}
            onError={() => setBroken(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <span
            className="absolute inset-0 flex items-center justify-center opacity-25"
            style={{ fontSize: 28 }}
          >
            {initial}
          </span>
        )}

        <span className="absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-black/70 via-black/35 to-transparent px-2 pb-1.5 pt-5">
          {/* 管理态多一行体积：这一段就是为「哪个模型占地方、要不要删」服务的，
              和名字挤在同一行会把名字截成三四个字。 */}
          {deleting && item.bytes > 0 && (
            <span className="text-[9px] leading-tight tabular-nums text-white/60">
              {formatFileSize(item.bytes)}
            </span>
          )}
          <span className="min-w-0 truncate text-[11px] leading-tight text-white">
            {item.label}
          </span>
        </span>

        {active && (
          <span className="absolute left-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
      </button>

      {deleting && onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('删除该模型')}
          title={t('删除该模型')}
          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-[var(--md-sys-color-error)]"
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}
