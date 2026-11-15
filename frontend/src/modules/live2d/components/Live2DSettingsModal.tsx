import { useState } from 'react'
import { Camera, Mic, Trash2, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/i18n'
import type { Live2DModelEntry } from '../core/model-catalog'
import type { ModelExpressionEntry } from '../core/model-meta'
import {
  LIVE2D_UPLOAD_MAX_BYTES,
  type Live2DLibraryEntry,
} from '../core/model-library'
import type { Live2DModelKind, Live2DPolicy } from '../types'
import { Live2DModelPicker } from './Live2DModelPicker'

// 角色设置：**唯一**的设置入口（右键菜单只留快捷动作，模型选择都指到这里）。
//
// 分两页，两页对所有人可见——区别只在于能不能改：
//   - 我的角色：每个人都能改，只影响「我这一个」；
//   - 房间设置：房主可改，作用于全房间；成员只读，但能看到房间现在是什么规矩。
//
// 以前房间页签只给房主渲染，结果"为什么我不能换模型""为什么动捕开关是灰的"
// 只能靠猜：限制发生了，但被限制的人看不到规则本身。只读展示比隐藏更省事。
//
// 为什么用弹窗而不是全塞进右键菜单：模型清单展开后有两三百像素，贴在光标上
// 会盖住画面且容易误触。

type Tab = 'me' | 'room'

export interface Live2DSettingsModalProps {
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
  /** 我有权删除的模型 id（服务端下发的 deletable） */
  removableIds: string[]
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
  /** 语音口型：说话时用麦克风响度推动嘴型（本机偏好） */
  voiceLipSync: boolean
  policy: Live2DPolicy
  /** 统一角色当前用的模型显示名（解析不到时给 id） */
  unifiedLabel: string
  /**
   * 房主关掉了「对观众显示角色」，此刻我看不到任何角色。
   *
   * 这一层被关掉时入口仍然保留（不然被关的人连状态都看不到），但只给一个
   * 空设置面板等于让人以为功能坏了——必须有一句话解释「你看不到是因为什么」。
   */
  hiddenByHost: boolean
  uploading: boolean
  /* 我的角色 */
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  onScale: (scale: number) => void
  onExpression: (index: number) => void
  onToggleFaceTracking: () => void
  onToggleVoiceLipSync: () => void
  onRemove: () => void
  /* 房间设置（房主） */
  onPolicy: (patch: Partial<Live2DPolicy>) => void
  onUpload: (file: File) => void
  /**
   * 在房间页上传：传完直接设为统一模型。
   *
   * 和 onUpload 分开是因为"传完干什么"不同——个人页是切到自己身上，房间页
   * 是写进策略。两个回调共用同一段上传逻辑，只有落地动作不一样。
   */
  onUploadUnified: (file: File) => void
  onDeleteModel: (modelId: string) => void
}

export function Live2DSettingsModal({
  open,
  onClose,
  container,
  isHost,
  canUploadModels,
  builtins,
  libraryModels,
  removableIds,
  expressions,
  selectedKind,
  selectedModelId,
  removed,
  canRemove,
  myScale,
  faceTracking,
  voiceLipSync,
  policy,
  unifiedLabel,
  hiddenByHost,
  uploading,
  onSelect,
  onScale,
  onExpression,
  onToggleFaceTracking,
  onToggleVoiceLipSync,
  onRemove,
  onPolicy,
  onUpload,
  onUploadUnified,
  onDeleteModel,
}: Live2DSettingsModalProps) {
  const [tab, setTab] = useState<Tab>('me')
  const [pendingDelete, setPendingDelete] = useState<string>('')

  const unified = policy.unified && Boolean(policy.unifiedId)
  const canUseFace = policy.allowFace
  // 打开「统一角色」必须指定一个模型。优先级：当前统一模型 → 我选的那个 →
  // 库里第一个。一个都没有时开关直接禁用——以前是点了发请求、被 `if (!id)`
  // 静默挡回来，看着像开关坏了。
  const fallbackModel: { kind: Live2DModelKind; id: string } | null =
    builtins[0]
      ? { kind: 'builtin', id: builtins[0].id }
      : libraryModels[0]
        ? { kind: 'room', id: libraryModels[0].id }
        : null
  const canUnify = Boolean(policy.unifiedId || selectedModelId || fallbackModel)

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
        <div className="mb-3 mt-1">
          <SegmentedToggle
            options={[
              { value: 'me', label: t('我的角色') },
              { value: 'room', label: t('房间设置') },
            ]}
            value={tab}
            onChange={(value) => setTab(value as Tab)}
          />
        </div>

        <div className="max-h-[62vh] overflow-y-auto pr-1 hide-scrollbar">
          {tab === 'me' ? (
            <div className="flex flex-col gap-4">
              {hiddenByHost && (
                <Note>
                  {t(
                    '房主关闭了角色显示，你现在看不到任何角色；重新打开后你选的模型会立刻出现'
                  )}
                </Note>
              )}
              {unified ? (
                <>
                  <Note>
                    {t(
                      '房主统一了角色：模型由房主决定，大小、表情和动捕仍然是你自己的'
                    )}
                  </Note>
                  <Section label={t('统一使用的模型')}>
                    <p className="truncate text-xs opacity-80">
                      {unifiedLabel || t('未知模型')}
                    </p>
                  </Section>
                </>
              ) : (
                <>
                  {removed && (
                    <Note>
                      {t(
                        '角色已删除，房间里所有人（包括你）都看不到它。在下面重新选一个模型即可恢复'
                      )}
                    </Note>
                  )}
                  <Live2DModelPicker
                    builtins={builtins}
                    libraryModels={libraryModels}
                    value={{ kind: selectedKind, id: selectedModelId }}
                    onSelect={onSelect}
                    // 与后端同口径：kind=url 只开给房主（它会让房间里每个人
                    // 的浏览器都去拉第三方资源）。
                    allowUrl={isHost}
                    upload={
                      canUploadModels ? { uploading, onUpload } : undefined
                    }
                    removableIds={removableIds}
                    onDeleteModel={(modelId) => setPendingDelete(modelId)}
                  />
                  {canUploadModels && (
                    <p className="-mt-2 text-[10px] leading-snug opacity-45">
                      {t(
                        '模型包是 zip，需含 model3.json（贴图/动作一并保留），不超过 {{size}}MB；上传后所有房间都能选',
                        { size: LIVE2D_UPLOAD_MAX_BYTES >> 20 }
                      )}
                    </p>
                  )}
                </>
              )}

              {/* 大小是**个人**的：服务端名册按成员各存一份 scale，统一角色
                  只统一模型。以前这里跟着统一一起禁用，等于房主定了个模型就
                  顺带决定了别人屏幕上该多大——而每个人的画面尺寸根本不同。 */}
              <Section label={t('大小')}>
                <Slider
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={myScale}
                  onChange={onScale}
                  size="sm"
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
                        disabled={removed && !unified}
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
                        : removed && !unified
                          ? t('重新选一个模型之后动捕才有作用')
                          : faceTracking.on
                            ? t('画面只在本机处理，不会上传')
                            : t('开启后角色会跟着你的头部转动')}
                  </span>
                </span>
                <Switch
                  checked={faceTracking.on}
                  // 删除角色后开动捕没有任何可驱动的对象（指针上报也跟着
                  // 停了），让开关能点却毫无反应比直接置灰更让人怀疑坏了
                  disabled={
                    !canUseFace || (removed && !unified) || faceTracking.busy
                  }
                  onChange={onToggleFaceTracking}
                  aria-label={t('摄像头动捕')}
                />
              </div>

              {/* 语音口型：不需要摄像头也能有嘴型。刻意**不做**成房间策略——
                  它读的是本机麦克风电平（不上传音频），只影响"我的嘴怎么动"，
                  和房主管不管摄像头没有关系。 */}
              <div className="flex items-center gap-2">
                <Mic size={14} className="shrink-0 opacity-70" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs">{t('语音口型')}</span>
                  <span className="block text-[10px] leading-snug opacity-50">
                    {removed && !unified
                      ? t('重新选一个模型之后口型才有作用')
                      : faceTracking.on
                        ? t('动捕开着时以动捕为准')
                        : t('加入语音后说话会动嘴，不需要摄像头')}
                  </span>
                </span>
                <Switch
                  checked={voiceLipSync}
                  // 和动捕开关同一个理由：删除角色后没有可驱动的对象
                  disabled={removed && !unified}
                  onChange={onToggleVoiceLipSync}
                  aria-label={t('语音口型')}
                />
              </div>

              {/* 删除角色是**单向**动作，这里不再有「显示角色」的反向按钮。
                  以前那一对按钮就是紊乱的源头：删除后模型选择器仍然可选，
                  点任意一个模型都会恢复，所以"恢复"的正确入口一直是列表本身，
                  而不是一个只在特定状态下才出现的按钮。 */}
              {!removed &&
                (unified ? (
                  <p className="text-[10px] leading-snug opacity-45">
                    {t('统一角色期间不能删除自己的角色')}
                  </p>
                ) : (
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
                ))}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Note>
                {isHost
                  ? t('这些设置对房间里所有人生效')
                  : t('这些设置由房主决定，你只能看')}
              </Note>

              <Row
                icon={<Users size={14} />}
                label={t('对观众显示角色')}
                hint={t('关闭后观众看不到任何角色，你自己仍然看得到')}
              >
                <Switch
                  checked={policy.showToViewers}
                  disabled={!isHost}
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
                  disabled={!isHost}
                  onChange={(event) =>
                    onPolicy({ allowFace: event.target.checked })
                  }
                  aria-label={t('允许成员开启摄像头动捕')}
                />
              </Row>

              <Row
                label={t('统一角色')}
                hint={
                  canUnify
                    ? t('全房间都显示同一个模型，成员不能再自己换')
                    : t('房间里还没有模型，先上传一个')
                }
              >
                <Switch
                  checked={policy.unified}
                  disabled={!isHost || !canUnify}
                  onChange={(event) => {
                    // 打开时必须给一个模型：拿当前统一模型，退而用**我自己的
                    // 选择**（不是生效模型——隐藏时它是空串、统一时它本来就
                    // 是统一模型，两种都不该作为"统一哪个"的来源）
                    const next = event.target.checked
                    if (!next) {
                      onPolicy({ unified: false })
                      return
                    }
                    const kind =
                      policy.unifiedKind ??
                      (selectedModelId
                        ? selectedKind
                        : (fallbackModel?.kind ?? 'builtin'))
                    const id =
                      policy.unifiedId ?? selectedModelId ?? fallbackModel?.id
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
                    allowUrl={isHost}
                    disabled={!isHost}
                    // 统一角色期间「我的角色」页不渲染选择器，上传与删除只能
                    // 在这里做：传完直接设为统一模型，否则传了也不知道去哪选。
                    upload={
                      canUploadModels && isHost
                        ? { uploading, onUpload: onUploadUnified }
                        : undefined
                    }
                    removableIds={isHost ? removableIds : undefined}
                    onDeleteModel={
                      isHost
                        ? (modelId) => setPendingDelete(modelId)
                        : undefined
                    }
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
