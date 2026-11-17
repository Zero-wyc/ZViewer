import { useState } from 'react'
import {
  Camera,
  Eye,
  Mic,
  RotateCcw,
  ScanFace,
  Trash2,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { t } from '@/i18n'
import type { Live2DModelEntry } from '../core/model-catalog'
import type { ModelExpressionEntry, ModelMotionGroup } from '../core/model-meta'
import {
  LIVE2D_UPLOAD_MAX_BYTES,
  libraryModelThumbUrl,
  type Live2DLibraryEntry,
} from '../core/model-library'
import type { Live2DFaceQuality } from '../core/face-tracker'
import { PEER_SCALE_MAX, PEER_SCALE_MIN } from '../core/peer-scale'
import type { Live2DModelKind, Live2DPolicy } from '../types'
import { Live2DModelPicker } from './Live2DModelPicker'
import { ModelThumb } from './ModelThumb'

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

/**
 * 模型大小的快捷档。
 *
 * 「半身像」取 2.2：模型高度按视口 42% 缩放（LIVE2D_MODEL_HEIGHT_RATIO），
 * 2.2 倍约等于 92%，而模型是**底部对齐**向上生长的——脚下那一截自然被画面
 * 裁掉，观感正好停在腰以上。想微调再用上面的滑杆。
 */
const SCALE_PRESETS = [
  { label: '小', value: 0.7 },
  { label: '标准', value: 1 },
  { label: '半身像', value: 2.2 },
] as const

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
  /** 当前模型可用的动作组（已排除待机）；右键菜单里也有一份同样的入口 */
  motions: ModelMotionGroup[]
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
  /** 动捕精度档位（本机偏好） */
  faceQuality: Live2DFaceQuality
  /** 3D 头部 + 6DOF 视差 */
  head3d: boolean
  /** 眼球跟随 */
  eyeTrack: boolean
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
  /** 模型库清单加载失败的原因（空串 = 正常取到） */
  libraryError: string
  /**
   * 我选的模型已经不在服务端模型库里。
   *
   * 三种来源都会造成这件事：被别人删了、服务端重启后 uploads 丢了、模型包
   * 损坏被清理。以前的表现是画面只剩一个占位卡，用户只能重新上传一遍——
   * 这里要明说"不是你选错了，是它不在了"。
   */
  missingModel: boolean
  /** 重新拉一次模型库清单 */
  onReloadLibrary: () => void
  uploading: boolean
  /* 我的角色 */
  onSelect: (kind: Live2DModelKind, modelId: string) => void
  onScale: (scale: number) => void
  /**
   * 把角色放回默认站位（清掉本机记住的所有站位）。
   *
   * 位置不再同步，所以这是角色被拖到画面外之后**唯一**的找回入口：
   * 那时候右键已经命不中它，右下角这个入口必须一直在。
   */
  onResetPosition: () => void
  onExpression: (index: number) => void
  onMotion: (group: string, index: number) => void
  onToggleFaceTracking: () => void
  onToggleVoiceLipSync: () => void
  onFaceQuality: (quality: Live2DFaceQuality) => void
  onHead3d: (enabled: boolean) => void
  onEyeTrack: (enabled: boolean) => void
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
  /**
   * 从链接导入模型包，返回新模型 id（失败返回空串）。
   *
   * 与上传一样，「导入之后干什么」由页面决定：个人页切过去、房间页设为统一，
   * 所以这里只负责入库，落地动作留在本组件的两个包装函数里。
   */
  onImportModel: (url: string) => Promise<string>
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
  motions,
  selectedKind,
  selectedModelId,
  removed,
  canRemove,
  myScale,
  faceTracking,
  voiceLipSync,
  faceQuality,
  head3d,
  eyeTrack,
  policy,
  unifiedLabel,
  hiddenByHost,
  libraryError,
  missingModel,
  onReloadLibrary,
  uploading,
  onSelect,
  onScale,
  onResetPosition,
  onExpression,
  onMotion,
  onToggleFaceTracking,
  onToggleVoiceLipSync,
  onFaceQuality,
  onHead3d,
  onEyeTrack,
  onRemove,
  onPolicy,
  onUpload,
  onUploadUnified,
  onImportModel,
  onDeleteModel,
}: Live2DSettingsModalProps) {
  const [tab, setTab] = useState<Tab>('me')
  const [pendingDelete, setPendingDelete] = useState<string>('')

  // 导入之后直接生效，和上传保持同一套手感：传完就切过去/设为统一，
  // 否则用户还要在刚变长的列表里再找一次自己刚导入的那个。
  const importForMe = async (url: string) => {
    const modelId = await onImportModel(url)
    if (!modelId) return false
    onSelect('room', modelId)
    return true
  }
  const importForRoom = async (url: string) => {
    const modelId = await onImportModel(url)
    if (!modelId) return false
    onPolicy({ unified: true, unifiedKind: 'room', unifiedId: modelId })
    return true
  }

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
  // 统一模型的缩略图：只有它确实来自模型库（kind=room）时才可能有图。
  // 内置模型是随部署包发的，服务端不管，也就没有缩略图。
  const unifiedEntry =
    policy.unifiedKind === 'room'
      ? libraryModels.find((item) => item.id === policy.unifiedId)
      : undefined
  const unifiedThumb =
    unifiedEntry && unifiedEntry.hasThumb
      ? libraryModelThumbUrl(unifiedEntry.id)
      : undefined

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
              {/* 「拉不到清单」与「库里确实没有模型」必须分开说：前者重试就好，
                  后者才需要重新上传。混在一起时用户唯一能做的就是重传一遍。 */}
              {libraryError && (
                <Note
                  action={
                    <Button
                      size="sm"
                      variant="ghost"
                      disableAnimation
                      onClick={onReloadLibrary}
                    >
                      {t('重试')}
                    </Button>
                  }
                >
                  {t('模型库没能加载：{{reason}}', { reason: libraryError })}
                </Note>
              )}
              {missingModel && (
                <Note>
                  {t(
                    '你选的模型已经不在服务器上了（可能被删除或服务端重置）。在下面重新选一个即可恢复，重新上传同一个模型包也可以'
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
                    <span className="flex min-w-0 items-center gap-2">
                      <ModelThumb label={unifiedLabel} src={unifiedThumb} />
                      <span className="truncate text-xs opacity-80">
                        {unifiedLabel || t('未知模型')}
                      </span>
                    </span>
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
                    urlImport={
                      canUploadModels ? { onImport: importForMe } : undefined
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

              {/* 大小是**本机**的：不写名册、也不上行。自己的这一档存在本机
                  偏好里，别人的在右键他的角色时单独调。以前大小跟着房间走，
                  房主定个模型就顺带决定了别人屏幕上该多大——而每个人的窗口
                  尺寸、观看距离根本不同。 */}
              <Section label={t('大小')}>
                <Slider
                  min={PEER_SCALE_MIN}
                  max={PEER_SCALE_MAX}
                  step={0.05}
                  value={myScale}
                  onChange={onScale}
                  size="sm"
                  valueFormatter={(value) => `${Math.round(value * 100)}%`}
                  aria-label={t('模型大小')}
                />
                {/* 快捷档：滑杆要精确停在"半身像"那一档不太现实，而这是绝大多数
                    人想一次性要到的效果（放大到下半身被画面裁掉）。
                    样式与模型选择器的小按钮同源，避免在一个面板里出现两套 chip。 */}
                <div className="mt-1.5 flex items-center gap-1.5">
                  {SCALE_PRESETS.map((preset) => {
                    const active = Math.abs(myScale - preset.value) < 0.03
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => onScale(preset.value)}
                        aria-pressed={active}
                        className="rounded-md border px-2 py-0.5 text-[10px] transition-opacity hover:opacity-80"
                        style={{
                          background: active
                            ? 'color-mix(in srgb, var(--md-sys-color-primary) 14%, var(--md-sys-color-surface))'
                            : 'var(--md-sys-color-surface)',
                          borderColor: active
                            ? 'var(--md-sys-color-primary)'
                            : 'var(--md-sys-color-outline-variant)',
                          color: active
                            ? 'var(--md-sys-color-primary)'
                            : 'var(--md-sys-color-on-surface)',
                        }}
                      >
                        {t(preset.label)}
                      </button>
                    )
                  })}
                </div>
              </Section>

              {/* 位置也是本机的。这里必须有一个「放回去」的出口：角色可以
                  被拖到完全看不见的地方（位置不同步，各端互不影响），那时
                  右键命不中它，右下角这个入口就是唯一的路。 */}
              <Section label={t('位置')}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[10px] leading-snug opacity-50">
                    {t('位置和大小只保存在本机，不会同步给别人')}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disableAnimation
                    icon={<RotateCcw size={13} />}
                    onClick={onResetPosition}
                  >
                    {t('重置模型位置')}
                  </Button>
                </div>
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

              {motions.length > 0 && (
                <Section label={t('动作')}>
                  <div className="flex flex-wrap gap-1">
                    {motions.map((item) => (
                      <button
                        key={item.group}
                        type="button"
                        onClick={() => onMotion(item.group, 0)}
                        disabled={removed && !unified}
                        // 组名是 Cubism 里的原始名字，不翻译：翻错了反而对不上
                        // 模型作者文档里的说法。
                        title={t('所有人都会看到')}
                        className="max-w-full truncate rounded-md border px-2 py-1 text-[11px] transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
                        style={{
                          background: 'var(--md-sys-color-surface)',
                          borderColor: 'var(--md-sys-color-outline-variant)',
                        }}
                      >
                        {item.group}
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

              {/* 动捕精度：改变的是「检测多快、看多清、要不要用 3D」。
                  做成三档而不是四个滑杆，是因为帧率和分辨率必须匹配——单独
                  拉高帧率只会更抖，单独拉高分辨率只会更卡。
                  两个开关放进同一个 Section：它们只在这一档之下才有意义，
                  散在页面里会让人以为是和「大小」同级的独立设置。 */}
              <Section label={t('动捕精度')}>
                <SegmentedToggle
                  options={[
                    { value: 'smooth', label: t('流畅') },
                    { value: 'standard', label: t('标准') },
                    { value: 'precise', label: t('高精度') },
                  ]}
                  value={faceQuality}
                  onChange={(value) =>
                    onFaceQuality(value as Live2DFaceQuality)
                  }
                />
                <p className="mt-2 text-[10px] leading-snug opacity-50">
                  {faceQuality === 'precise'
                    ? t('30fps / 640×480：跟手最好，核显笔记本可能掉帧')
                    : faceQuality === 'smooth'
                      ? t('10fps / 320×240：省电优先，快速转头会有点滞后')
                      : t('15fps / 480×360：精度与占用均衡')}
                  {!faceTracking.on && t('，下次开启动捕时生效')}
                </p>
                <div className="mt-2.5 flex flex-col gap-2">
                  <Row
                    icon={<ScanFace size={14} />}
                    label={t('3D 头部（6DOF）')}
                    hint={t('三轴旋转 + 前后左右视差；关掉退回 2D 近似')}
                  >
                    <Switch
                      checked={head3d}
                      disabled={removed && !unified}
                      onChange={(event) => onHead3d(event.target.checked)}
                      aria-label={t('3D 头部（6DOF）')}
                    />
                  </Row>

                  <Row
                    icon={<Eye size={14} />}
                    label={t('眼球跟随')}
                    hint={t('瞳孔跟着你转；有的模型眼球位移很夸张，可以关掉')}
                  >
                    <Switch
                      checked={eyeTrack}
                      disabled={removed && !unified}
                      onChange={(event) => onEyeTrack(event.target.checked)}
                      aria-label={t('眼球跟随')}
                    />
                  </Row>
                </div>
              </Section>

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
                    urlImport={
                      canUploadModels && isHost
                        ? { onImport: importForRoom }
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

function Note({
  children,
  action,
}: {
  children: React.ReactNode
  /** 右侧的动作（例如「重试」）：用 div 而不是 p，按钮才不会被浏览器强制闭合 */
  action?: React.ReactNode
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed"
      style={{
        background: 'var(--md-sys-color-surface-container)',
        color: 'var(--md-sys-color-on-surface-variant)',
      }}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  )
}
