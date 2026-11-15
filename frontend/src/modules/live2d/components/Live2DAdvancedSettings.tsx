import { useState } from 'react'
import { Camera, Trash2, Upload, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/i18n'
import { cn } from '@/lib/utils'
import type { Live2DModelEntry } from '../core/model-catalog'
import type { ModelExpressionEntry } from '../core/model-meta'
import {
  LIVE2D_UPLOAD_MAX_BYTES,
  type Live2DLibraryEntry,
} from '../core/model-library'
import type { Live2DModelKind, Live2DPolicy } from '../types'
import { Live2DModelPicker } from './Live2DModelPicker'

// 详细设置。分两页：
//   - 我的角色：每个人都能改，只影响自己看到的/别人看到的「我这一个」；
//   - 房间设置：房主才能改，作用于全房间（统一角色、动捕许可、对观众可见）。
//
// 为什么用弹窗而不是继续挂在右键菜单里：模型清单、模型库、动捕状态这些
// 东西展开后有两三百像素，贴在光标上会盖住画面且容易误触。

type Tab = 'me' | 'room'

export interface Live2DAdvancedSettingsProps {
  open: boolean
  onClose: () => void
  /**
   * 挂载容器。原生全屏时只有全屏子树会被渲染，所以这里传的是宿主里的
   * canvas 容器（它总在全屏子树里），而不是默认的 document.body。
   */
  container?: HTMLElement | null
  /**
   * 当前会话的房主（socket 会话角色 = sharer）。房间级策略由服务端的
   * requireHost 判定，所以这里必须用「会话身份」而不是「房间 owner」——
   * 否则房间所有者以观众身份进房时会看到一堆点了就被拒的开关。
   */
  isHost: boolean
  /** 能否往服务端公共模型库里上传（任何登录用户；游客不行） */
  canUploadModels: boolean
  builtins: Live2DModelEntry[]
  libraryModels: Live2DLibraryEntry[]
  expressions: ModelExpressionEntry[]
  /**
   * 我自己的选择（不受统一角色/删除影响）。
   *
   * 刻意不传「生效模型」：删除时它是空串、统一时它是房间的模型，两种情况下
   * 拿它给选择器做高亮都会高亮错——一个像"从没选过"，一个像"我选了房间的
   * 那个模型"。
   */
  selectedKind: Live2DModelKind
  selectedModelId: string
  /** 我已删除自己的角色 */
  removed: boolean
  /** 能否删除（统一角色时不行；已经删除了就不用再删） */
  canRemove: boolean
  myScale: number
  faceTracking: { on: boolean; busy: boolean; error: string }
  policy: Live2DPolicy
  uploading: boolean
  /* 我的角色 */
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  onScale: (scale: number) => void
  onExpression: (index: number) => void
  onToggleFaceTracking: () => void
  onRemove: () => void
  /* 房间设置（房主） */
  onPolicy: (patch: Partial<Live2DPolicy>) => void
  onUpload: (file: File) => void
  onDeleteModel: (modelId: string) => void
}

export function Live2DAdvancedSettings({
  open,
  onClose,
  container,
  isHost,
  canUploadModels,
  builtins,
  libraryModels,
  expressions,
  selectedKind,
  selectedModelId,
  removed,
  canRemove,
  myScale,
  faceTracking,
  policy,
  uploading,
  onSelect,
  onScale,
  onExpression,
  onToggleFaceTracking,
  onRemove,
  onPolicy,
  onUpload,
  onDeleteModel,
}: Live2DAdvancedSettingsProps) {
  const [tab, setTab] = useState<Tab>('me')
  const [pendingDelete, setPendingDelete] = useState<string>('')

  // 观众没有房间页，也不该因为上次是房主就停在 'room'
  const activeTab: Tab = isHost ? tab : 'me'
  const unified = policy.unified && Boolean(policy.unifiedId)
  const canUseFace = policy.allowFace

  // 模型库是**服务端公共**的素材，不属于房间设置，所以放在「我的角色」页：
  // 观众也要能传自己的、删自己传错的，不能只给房主开。不可上传且库为空时
  // 整块不渲染，免得给游客看一个空壳。
  const librarySection =
    canUploadModels || libraryModels.length > 0 ? (
      <Section label={t('模型库')}>
        {canUploadModels && (
          <>
            <p className="mb-1.5 text-[10px] leading-snug opacity-50">
              {t('上传到服务端模型库，所有房间都能选')}
            </p>
            <div className="mb-1.5 flex items-center gap-1.5">
              <UploadButton uploading={uploading} onUpload={onUpload} />
              <span className="text-[10px] opacity-45">
                {t(
                  'zip 需含 model3.json（贴图/动作一并保留），不超过 {{size}}MB',
                  {
                    size: LIVE2D_UPLOAD_MAX_BYTES >> 20,
                  }
                )}
              </span>
            </div>
          </>
        )}
        {libraryModels.length === 0 ? (
          <p className="text-[11px] opacity-55">{t('模型库还是空的')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {libraryModels.map((item) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-lg border px-2 py-1.5"
                style={{
                  borderColor: 'var(--md-sys-color-outline-variant)',
                }}
              >
                <span className="min-w-0 flex-1 truncate text-[11px]">
                  {item.label}
                </span>
                {item.deletable && (
                  <button
                    type="button"
                    onClick={() => setPendingDelete(item.id)}
                    aria-label={t('删除该模型')}
                    title={t('删除该模型')}
                    className="shrink-0 rounded-md p-1 opacity-55 transition-opacity hover:opacity-100"
                    style={{ color: 'var(--md-sys-color-error)' }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    ) : null

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        container={container}
        title={t('角色设置')}
        className="w-full max-w-lg"
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('完成')}
          </Button>
        }
      >
        {isHost && (
          <div className="mb-3 mt-1">
            <SegmentedToggle
              options={[
                { value: 'me', label: t('我的角色') },
                { value: 'room', label: t('房间设置') },
              ]}
              value={activeTab}
              onChange={(value) => setTab(value as Tab)}
            />
          </div>
        )}

        <div className="max-h-[62vh] overflow-y-auto pr-1 hide-scrollbar">
          {activeTab === 'me' ? (
            <div className="flex flex-col gap-4">
              {unified ? (
                <Note>{t('房主已统一角色，全房间使用同一个模型')}</Note>
              ) : (
                <>
                  {removed && (
                    <Note>
                      {t(
                        '角色已删除，房间里所有人（包括你）都看不到它。在下面重新选一个模型即可恢复'
                      )}
                    </Note>
                  )}
                  {/* 高亮用「我的选择」而不是「生效模型」：删除时生效模型是
                      空串，用它当 value 会让选择器整片都不选中，看起来像"我从
                      来没选过模型"——而实际上只是删掉了。 */}
                  <Live2DModelPicker
                    builtins={builtins}
                    libraryModels={libraryModels}
                    value={{ kind: selectedKind, id: selectedModelId }}
                    onSelect={onSelect}
                    allowUrl={canUploadModels}
                  />
                </>
              )}

              {librarySection}

              <Section label={t('大小')}>
                <Slider
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={myScale}
                  onChange={onScale}
                  size="sm"
                  disabled={unified}
                  valueFormatter={(value) => `${Math.round(value * 100)}%`}
                  aria-label={t('模型大小')}
                />
              </Section>

              {expressions.length > 0 && (
                <Section label={t('表情')}>
                  <div className="flex flex-wrap gap-1">
                    {expressions.map((item) => (
                      <button
                        key={item.index}
                        type="button"
                        onClick={() => onExpression(item.index)}
                        // 删除角色后服务端名册里没有我，动作会被直接丢掉：
                        // 能点却没有任何反应比置灰更容易被当成 bug
                        disabled={removed}
                        title={t('所有人都会看到')}
                        className="max-w-full truncate rounded-md border px-2 py-1 text-[11px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                        style={{
                          background: 'var(--md-sys-color-surface)',
                          borderColor: 'var(--md-sys-color-outline-variant)',
                        }}
                      >
                        {item.name ||
                          t('表情 {{index}}', { index: item.index + 1 })}
                      </button>
                    ))}
                  </div>
                </Section>
              )}

              <div className="flex items-center gap-2">
                <Camera size={14} className="shrink-0 opacity-70" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs">{t('摄像头动捕')}</span>
                  <span className="block text-[10px] leading-snug opacity-50">
                    {faceTracking.error
                      ? faceTracking.error
                      : !canUseFace
                        ? t('房主已关闭成员动捕')
                        : removed
                          ? t('重新选一个模型之后动捕才有作用')
                          : faceTracking.on
                            ? t('画面只在本机处理，不会上传')
                            : t('开启后角色会跟着你的头部转动')}
                  </span>
                </span>
                <Switch
                  checked={faceTracking.on}
                  // 删除角色后开动捕没有任何可驱动的对象（指针上报也跟着停了），
                  // 让开关能点却毫无反应比直接置灰更让人怀疑坏了
                  disabled={!canUseFace || removed || faceTracking.busy}
                  onChange={onToggleFaceTracking}
                  aria-label={t('摄像头动捕')}
                />
              </div>

              {/* 删除角色是**单向**动作，这里不再有「显示角色」的反向按钮。
                  以前那一对按钮就是紊乱的源头：删除后模型选择器仍然可选，
                  点任意一个模型都会恢复，所以"恢复"的正确入口一直是列表本身，
                  而不是一个只在特定状态下才出现的按钮。 */}
              {!removed && (
                <div>
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 size={13} />}
                    onClick={onRemove}
                    disabled={!canRemove}
                  >
                    {t('删除角色')}
                  </Button>
                  <p className="mt-1 text-[10px] leading-snug opacity-45">
                    {t('删除后房间里所有人（包括你）都看不到你的角色')}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Note>{t('这些设置作用于整个房间，服务重启后恢复默认')}</Note>

              <Row
                icon={<Users size={14} />}
                label={t('对观众显示角色')}
                hint={t('关闭后观众看不到任何角色，你自己仍然看得到')}
              >
                <Switch
                  checked={policy.showToViewers}
                  onChange={(event) =>
                    onPolicy({ showToViewers: event.target.checked })
                  }
                  aria-label={t('对观众显示角色')}
                />
              </Row>

              <Row
                icon={<Camera size={14} />}
                label={t('允许成员开启摄像头动捕')}
                hint={t('关闭后成员的动捕开关会被禁用')}
              >
                <Switch
                  checked={policy.allowFace}
                  onChange={(event) =>
                    onPolicy({ allowFace: event.target.checked })
                  }
                  aria-label={t('允许成员开启摄像头动捕')}
                />
              </Row>

              <Row
                label={t('统一角色')}
                hint={t('全房间都显示同一个模型，成员不能再自己换')}
              >
                <Switch
                  checked={policy.unified}
                  onChange={(event) => {
                    // 打开时必须给一个模型：拿当前统一模型，退而用我自己的
                    const next = event.target.checked
                    if (!next) {
                      onPolicy({ unified: false })
                      return
                    }
                    // 打开时必须给一个模型：拿当前统一模型，退而用**我自己的
                    // 选择**（不是生效模型——隐藏时它是空串、统一时它本来就
                    // 是统一模型，两种都不该作为"统一哪个"的来源）
                    const kind = policy.unifiedKind ?? selectedKind
                    const id = policy.unifiedId ?? selectedModelId
                    if (!id) return
                    onPolicy({
                      unified: true,
                      unifiedKind: kind,
                      unifiedId: id,
                    })
                  }}
                  aria-label={t('统一角色')}
                />
              </Row>

              {policy.unified && (
                <div
                  className="rounded-xl border p-2.5"
                  style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
                >
                  <p className="mb-1.5 text-[10px] uppercase tracking-wide opacity-55">
                    {t('统一使用的模型')}
                  </p>
                  <Live2DModelPicker
                    builtins={builtins}
                    libraryModels={libraryModels}
                    value={{
                      kind: policy.unifiedKind ?? 'builtin',
                      id: policy.unifiedId ?? '',
                    }}
                    onSelect={(kind, modelId) =>
                      onPolicy({
                        unified: true,
                        unifiedKind: kind,
                        unifiedId: modelId,
                      })
                    }
                    allowUrl
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete('')}
        container={container}
        onCancel={() => setPendingDelete('')}
        title={t('删除该模型')}
        okText={t('删除')}
        cancelText={t('取消')}
        onOk={() => {
          const id = pendingDelete
          setPendingDelete('')
          if (id) onDeleteModel(id)
        }}
      >
        <p className="text-sm leading-relaxed opacity-70">
          {t('删除后正在使用它的人会退回默认角色，且无法恢复')}
        </p>
      </ConfirmModal>
    </>
  )
}

function UploadButton({
  uploading,
  onUpload,
}: {
  uploading: boolean
  onUpload: (file: File) => void
}) {
  // input 无法美化，藏起来由按钮触发；value 每次都要清空，否则同一个文件
  // 连选两次不会触发 change。
  return (
    <label
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] transition-opacity',
        uploading ? 'cursor-not-allowed opacity-55' : 'hover:opacity-80'
      )}
      style={{
        background: 'var(--md-sys-color-surface)',
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <Upload size={13} />
      {uploading ? t('上传中…') : t('上传')}
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

function Section({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wide opacity-55">
        {label}
      </p>
      {children}
    </div>
  )
}

function Row({
  icon,
  label,
  hint,
  children,
}: {
  icon?: React.ReactNode
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      {icon && (
        <span className="shrink-0 opacity-70" aria-hidden>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs">{label}</span>
        {hint && (
          <span className="block text-[10px] leading-snug opacity-50">
            {hint}
          </span>
        )}
      </span>
      {children}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed"
      style={{
        background: 'var(--md-sys-color-surface-container)',
        color: 'var(--md-sys-color-on-surface-variant)',
      }}
    >
      {children}
    </p>
  )
}
