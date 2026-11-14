import { useState } from 'react'
import { Camera, EyeOff, Trash2, Upload, Users } from 'lucide-react'
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
  type RoomModelEntry,
} from '../core/room-models'
import type { Live2DModelKind, Live2DPolicy } from '../types'
import { Live2DModelPicker } from './Live2DModelPicker'

// 详细设置。分两页：
//   - 我的角色：每个人都能改，只影响自己看到的/别人看到的「我这一个」；
//   - 房间设置：房主才能改，作用于全房间（统一角色、动捕许可、对观众可见）。
//
// 为什么用弹窗而不是继续挂在右键菜单里：模型清单、房间模型库、动捕状态这些
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
  /** 能否上传/删除房间模型（服务端口径：root 或房间 owner） */
  canUploadModels: boolean
  builtins: Live2DModelEntry[]
  roomModels: RoomModelEntry[]
  expressions: ModelExpressionEntry[]
  myKind: Live2DModelKind
  myModelId: string
  myScale: number
  faceTracking: { on: boolean; busy: boolean; error: string }
  policy: Live2DPolicy
  uploading: boolean
  /* 我的角色 */
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  onScale: (scale: number) => void
  onExpression: (index: number) => void
  onToggleFaceTracking: () => void
  onHide: () => void
  /* 房间设置（房主） */
  onPolicy: (patch: Partial<Live2DPolicy>) => void
  onUpload: (file: File) => void
  onDeleteRoomModel: (modelId: string) => void
}

export function Live2DAdvancedSettings({
  open,
  onClose,
  container,
  isHost,
  canUploadModels,
  builtins,
  roomModels,
  expressions,
  myKind,
  myModelId,
  myScale,
  faceTracking,
  policy,
  uploading,
  onSelect,
  onScale,
  onExpression,
  onToggleFaceTracking,
  onHide,
  onPolicy,
  onUpload,
  onDeleteRoomModel,
}: Live2DAdvancedSettingsProps) {
  const [tab, setTab] = useState<Tab>('me')
  const [pendingDelete, setPendingDelete] = useState<string>('')

  // 观众没有房间页，也不该因为上次是房主就停在 'room'
  const activeTab: Tab = isHost ? tab : 'me'
  const unified = policy.unified && Boolean(policy.unifiedId)
  const canUseFace = policy.allowFace

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
                <Live2DModelPicker
                  builtins={builtins}
                  roomModels={roomModels}
                  value={{ kind: myKind, id: myModelId }}
                  onSelect={onSelect}
                  allowUrl={canUploadModels}
                />
              )}

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
                        title={t('所有人都会看到')}
                        className="max-w-full truncate rounded-md border px-2 py-1 text-[11px] transition-opacity hover:opacity-80"
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
                        : faceTracking.on
                          ? t('画面只在本机处理，不会上传')
                          : t('开启后角色会跟着你的头部转动')}
                  </span>
                </span>
                <Switch
                  checked={faceTracking.on}
                  disabled={!canUseFace || faceTracking.busy}
                  onChange={onToggleFaceTracking}
                  aria-label={t('摄像头动捕')}
                />
              </div>

              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<EyeOff size={13} />}
                  onClick={onHide}
                  disabled={unified || !myModelId}
                >
                  {t('隐藏角色')}
                </Button>
                <p className="mt-1 text-[10px] leading-snug opacity-45">
                  {t('隐藏后点右下角的角色按钮可以重新显示')}
                </p>
              </div>
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
                    const kind = policy.unifiedKind ?? myKind
                    const id = policy.unifiedId ?? myModelId
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
                    roomModels={roomModels}
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

              <Section label={t('房间模型库')}>
                {canUploadModels && (
                  <>
                    <p className="mb-1.5 text-[10px] leading-snug opacity-50">
                      {t('上传一个 zip，房间内所有人都会看到这个模型')}
                    </p>
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <UploadButton uploading={uploading} onUpload={onUpload} />
                      <span className="text-[10px] opacity-45">
                        {t('zip 内需包含 model3.json，不超过 {{size}}MB', {
                          size: LIVE2D_UPLOAD_MAX_BYTES >> 20,
                        })}
                      </span>
                    </div>
                  </>
                )}
                {roomModels.length === 0 ? (
                  <p className="text-[11px] opacity-55">
                    {t('房主还没有上传模型')}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {roomModels.map((item) => (
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
                        {canUploadModels && (
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
          if (id) onDeleteRoomModel(id)
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
