/**
 * 共享参数卡片（房主侧）。
 *
 * 两处 UI 共用：开始共享前的卡片，以及共享中常驻在下方卡片区的「共享设置」，
 * 参数完全一致（改的是同一份设置）。一切都是受控的：组件不持有设置状态，
 * 也不碰会话，避免两处 UI 各存一份真相（那正是「界面显示 1080P、实际发 720P」
 * 的来源）。
 *
 * 视觉规范与「房间状态」卡一致：小组件用 `glass` 内嵌块，组与组之间用一条
 * 细分隔线（不是各自为政的间距），行式设置项统一「左标签、右控件」。
 * 刻意不用 `SegmentedToggle`：它自带阴影 + 描边 + 光晕，是给工具条用的强调
 * 控件，塞进卡片里会跟其他行打架（之前那版错乱的根因之一）。
 */
import { useState } from 'react'
import {
  Camera,
  Check,
  ChevronDown,
  Gauge,
  Monitor,
  MonitorPlay,
  Video,
  Volume2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Paragraph, Text } from '@/components/ui/Typography'
import type { CaptureDevice } from '../core/capture-devices'
import {
  AUDIO_BITRATE_OPTIONS,
  DEGRADATION_OPTIONS,
  FRAME_RATE_OPTIONS,
  QUALITY_PRESETS,
  RESOLUTION_OPTIONS,
  matchQualityPreset,
  type QualityPresetId,
  type ResolutionPreset,
} from '../constants'
import {
  MIN_CUSTOM_FRAMERATE,
  isPresetFramerate,
  maxFramerateForResolution,
  normalizeFramerateInput,
} from '../utils/frame-rate'
import type {
  CaptureSource,
  WebrtcShareMediaSettings,
} from '../utils/mediaSettingsStorage'
import { t } from '@/i18n'

/** 帧率下拉里「自定义」这一项的哨兵值（真实帧率永远是数字）。 */
const FRAME_RATE_CUSTOM = 'custom'

export interface ShareSettingsCardProps {
  settings: WebrtcShareMediaSettings
  /** 是否正在共享：决定哪些项可以热改。 */
  isSharing: boolean
  /** 正在热切换分辨率（重新采集中，禁用档位选择防重入）。 */
  switchingResolution?: boolean
  /** 正在热切换采集源（屏幕 ↔ 摄像头）。 */
  switchingSource?: boolean
  /** 可选摄像头（`enumerateDevices` 的结果，未授权时 label 为空）。 */
  cameras?: CaptureDevice[]
  /** 紧凑间距：放进行高受限的控制卡片区时用，组间留白收一档。 */
  compact?: boolean
  /**
   * 分两栏：左「画面」右「声音」。
   *
   * 只给开始共享前的中区卡片用——那里的宽度够摊开，竖排会把整块拉得很长，
   * 一眼看不到「声音」那组。下方控制卡片区的「共享设置」宽度有限，仍走竖排。
   */
  split?: boolean
  onPresetChange: (id: QualityPresetId) => void
  onResolutionChange: (preset: ResolutionPreset) => void
  onFrameRateChange: (fps: number) => void
  onDegradationChange: (preference: RTCDegradationPreference) => void
  onAudioBitrateChange: (bitrate: number) => void
  onSystemAudioChange: (enabled: boolean) => void
  onMicrophoneChange: (enabled: boolean) => void
  /** 切换采集源（屏幕 / 摄像头）。 */
  onCaptureSourceChange: (source: CaptureSource) => void
  /** 换摄像头设备。 */
  onCameraDeviceChange: (deviceId: string) => void
}

/**
 * 分组用的低对比描边色。
 *
 * 分隔线（横/竖）共用一条：卡片里全是 10–12px 的小字，线条一抢戏就散。
 */
const HAIRLINE =
  'color-mix(in srgb, var(--md-sys-color-outline-variant) 55%, transparent)'

/** 组间分隔线：细分、低对比，只做分区不做强调。 */
function Divider(): JSX.Element {
  return (
    <div
      className="my-3 h-px shrink-0"
      style={{
        backgroundColor: HAIRLINE,
      }}
    />
  )
}

/** 一行小标题：primary 色图标 + 文案。 */
function SectionTitle({
  icon,
  label,
}: {
  icon: React.ReactNode
  label: string
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[var(--md-sys-color-primary)]">{icon}</span>
      <Text className="text-xs font-medium">{label}</Text>
    </div>
  )
}

/**
 * 轻量分段控件（M3 segmented 风格）。
 *
 * 与 `SegmentedToggle` 的区别：无阴影/光晕/粗描边，选中项只是「浮起一档」的
 * 表面色，适合卡片内部的密集行。选项 label 允许带图标。
 */
function MiniSegmented({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: { value: string; label: React.ReactNode }[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <div
      role="group"
      aria-disabled={disabled}
      className={cn(
        'flex w-full items-center gap-0.5 rounded-lg p-0.5',
        'bg-[var(--md-sys-color-surface-container-high)]',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      {options.map((option) => {
        const active = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            disabled={disabled || active}
            aria-pressed={active}
            className={cn(
              'flex min-w-0 flex-1 items-center justify-center gap-1 rounded-[7px] px-1.5 py-1',
              'text-xs font-medium transition-colors',
              active
                ? 'bg-[var(--md-sys-color-surface)] text-[var(--md-sys-color-on-surface)] shadow-sm ring-1 ring-[var(--md-sys-color-outline-variant)]'
                : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** 行式设置项：左标签（可带辅助说明）、右控件；children 省略时是纯文本行。 */
function SettingRow({
  label,
  hint,
  children,
}: {
  label: string
  hint?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <Text className="text-xs leading-tight">{label}</Text>
        {hint && (
          <Paragraph
            type="secondary"
            className="m-0 mt-0.5 text-[10px] leading-tight"
          >
            {hint}
          </Paragraph>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function ShareSettingsCard({
  settings,
  isSharing,
  switchingResolution = false,
  switchingSource = false,
  cameras = [],
  compact = false,
  split = false,
  onPresetChange,
  onResolutionChange,
  onFrameRateChange,
  onDegradationChange,
  onAudioBitrateChange,
  onSystemAudioChange,
  onMicrophoneChange,
  onCaptureSourceChange,
  onCameraDeviceChange,
}: ShareSettingsCardProps): JSX.Element {
  // 细项默认收起：房间里的共享区高度有限，一上来摊开五组控件会把「开始共享」
  // 挤出可视区。收起时仍显示一行当前参数摘要，信息不丢。
  const [advanced, setAdvanced] = useState(false)
  const activePreset = matchQualityPreset(settings)
  const isCamera = settings.captureSource === 'camera'
  const summary = `${settings.resolutionPreset.toUpperCase()} · ${settings.frameRate}fps`
  const audioOption = AUDIO_BITRATE_OPTIONS.find(
    (option) => option.value === settings.maxAudioBitrate
  )
  // 未授权时 enumerateDevices 的 label 是空串：用序号占位，别显示成空白项。
  const cameraOptions = [
    { label: t('默认摄像头'), value: '' },
    ...cameras.map((device, index) => ({
      label: device.label || t('摄像头 {{index}}', { index: index + 1 }),
      value: device.id,
    })),
  ]
  const gap = compact ? 'gap-2' : 'gap-2.5'

  // 自定义帧率：下拉里选了「自定义」、或当前值本来就不在预设档里（上次填的
  // 144 之类）都算。
  //
  // 输入框刻意**非受控**：受控就得靠 effect 把 props 同步进草稿，那是级联渲染
  // （react-hooks 的 set-state-in-effect 也会拦）。改用 key 重挂表达「已提交的
  // 帧率或提交次数变了 → 草稿作废」，失焦/回车一次性提交，边打字边下发会把
  // 采集约束按 1→14→144 连改三次。
  const [customFrameRateOpen, setCustomFrameRateOpen] = useState(false)
  const [frameRateInputNonce, setFrameRateInputNonce] = useState(0)
  const maxFrameRate = maxFramerateForResolution(settings.resolutionPreset)
  const showCustomFrameRate =
    customFrameRateOpen || !isPresetFramerate(settings.frameRate)

  const handleFrameRateSelect = (value: string) => {
    if (value === FRAME_RATE_CUSTOM) {
      setCustomFrameRateOpen(true)
      return
    }
    setCustomFrameRateOpen(false)
    onFrameRateChange(Number(value))
  }

  const commitFrameRate = (raw: string) => {
    const next = normalizeFramerateInput(raw, maxFrameRate)
    // 每次提交都重挂输入框：非受控输入只有重挂才能把「夹到边界的值」和
    // 「非法草稿」干净地写回显示。
    setFrameRateInputNonce((nonce) => nonce + 1)
    if (next === null) return
    // 填了个刚好是预设的值（30/60…）就退回预设，下拉不该继续显示「自定义」。
    setCustomFrameRateOpen(!isPresetFramerate(next))
    if (next !== settings.frameRate) onFrameRateChange(next)
  }

  const frameRateOptions = [
    ...FRAME_RATE_OPTIONS.map((option) => ({
      label: option.label,
      value: String(option.value),
    })),
    { label: t('自定义'), value: FRAME_RATE_CUSTOM },
  ]

  // 四个区块拆成变量：竖排（控制卡片区）与两栏（中区开始前）共用同一份结构，
  // 复制一份 JSX 早晚会漂移。
  const screenGroup = (
    <div className={cn('flex flex-col', gap)}>
      <SectionTitle
        icon={<Video className="h-3.5 w-3.5" />}
        label={t('共享画面')}
      />
      <MiniSegmented
        options={[
          {
            value: 'screen',
            label: (
              <>
                <Monitor className="h-3.5 w-3.5" />
                {t('屏幕')}
              </>
            ),
          },
          {
            value: 'camera',
            label: (
              <>
                <Camera className="h-3.5 w-3.5" />
                {t('摄像头')}
              </>
            ),
          },
        ]}
        value={settings.captureSource}
        onChange={(value) => onCaptureSourceChange(value as CaptureSource)}
        disabled={switchingSource}
      />
      {isCamera && (
        <Select
          options={cameraOptions}
          value={settings.cameraDeviceId}
          onChange={(value) => onCameraDeviceChange(value)}
          size="sm"
          disabled={switchingSource}
        />
      )}
      {switchingSource && (
        <Paragraph type="secondary" className="m-0 text-[10px] leading-tight">
          {t('正在切换采集源...')}
        </Paragraph>
      )}
    </div>
  )

  const qualityGroup = (
    <div className={cn('flex flex-col', gap)}>
      <SectionTitle
        icon={<MonitorPlay className="h-3.5 w-3.5" />}
        label={t('画质档位')}
      />
      <div className="grid grid-cols-3 gap-2">
        {QUALITY_PRESETS.map((preset) => {
          const selected = activePreset === preset.id
          return (
            <button
              key={preset.id}
              type="button"
              onClick={() => {
                // 点档位等于回到预设帧率：自定义输入框跟着收起，
                // 否则下拉会一直显示「自定义」而实际已经是 30fps。
                setCustomFrameRateOpen(false)
                onPresetChange(preset.id)
              }}
              disabled={switchingResolution}
              aria-pressed={selected}
              title={t(preset.hintKey)}
              className={cn(
                'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5',
                'transition-colors disabled:opacity-60',
                // 三档统一白底：卡片本身是半透明玻璃，只有选中项填色时另外两档
                // 像「画在玻璃上的字」，一排按钮不成形。底色取 surface（与同卡
                // MiniSegmented 的选中块一致），选中再叠主色描边 + 阴影 + 勾号。
                'bg-[var(--md-sys-color-surface)]',
                // 未选中时的 hover 只动描边：底色本来就是最浅的 surface，再加一层
                // 容器色反而比选中项还重，鼠标一划过就像被选上了。
                selected
                  ? 'border-[var(--md-sys-color-primary)] shadow-sm'
                  : 'border-[var(--md-sys-color-outline-variant)] hover:border-[var(--md-sys-color-outline)]'
              )}
            >
              {selected && (
                <Check className="absolute right-1.5 top-1.5 h-3 w-3 text-[var(--md-sys-color-primary)]" />
              )}
              <span className="text-xs font-medium leading-none">
                {t(preset.labelKey)}
              </span>
              <span className="whitespace-nowrap text-[10px] leading-none tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                {preset.resolutionPreset.toUpperCase()} · {preset.frameRate}
                fps
              </span>
            </button>
          )
        })}
      </div>
      <Paragraph type="secondary" className="m-0 text-[10px] leading-tight">
        {activePreset
          ? t(QUALITY_PRESETS.find((item) => item.id === activePreset)!.hintKey)
          : t('自定义参数：下面的细项不再对应任何一个档位')}
      </Paragraph>
    </div>
  )

  const advancedGroup = (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setAdvanced((value) => !value)}
        aria-expanded={advanced}
        className="-mx-1 flex w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]/60"
      >
        <span className="flex items-center gap-1.5 text-[var(--md-sys-color-primary)]">
          <Gauge className="h-3.5 w-3.5" />
          <Text className="text-xs font-medium">{t('详细参数')}</Text>
        </span>
        <span className="flex items-center gap-1.5">
          {!advanced && (
            <span className="text-[10px] tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
              {summary}
            </span>
          )}
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-[var(--md-sys-color-on-surface-variant)] transition-transform',
              advanced && 'rotate-180'
            )}
          />
        </span>
      </button>

      {advanced && (
        <div
          className="glass mt-2 flex flex-col gap-3 rounded-xl border p-3"
          style={{
            borderColor:
              'color-mix(in srgb, var(--md-sys-color-outline-variant) 45%, transparent)',
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <label className="flex min-w-0 flex-col gap-1">
              <Text type="secondary" className="text-[10px] leading-none">
                {t('分辨率')}
              </Text>
              <Select
                options={RESOLUTION_OPTIONS}
                value={settings.resolutionPreset}
                onChange={(value) =>
                  onResolutionChange(value as ResolutionPreset)
                }
                disabled={switchingResolution}
                size="sm"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1">
              <Text type="secondary" className="text-[10px] leading-none">
                {t('帧率')}
              </Text>
              <Select
                options={frameRateOptions}
                value={
                  showCustomFrameRate
                    ? FRAME_RATE_CUSTOM
                    : String(settings.frameRate)
                }
                onChange={handleFrameRateSelect}
                size="sm"
              />
            </label>
          </div>

          {showCustomFrameRate && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input
                  key={`${settings.frameRate}-${frameRateInputNonce}`}
                  className="w-[4.5rem]"
                  size="sm"
                  type="number"
                  inputMode="numeric"
                  min={MIN_CUSTOM_FRAMERATE}
                  max={maxFrameRate}
                  step={1}
                  defaultValue={String(settings.frameRate)}
                  onBlur={(event) => commitFrameRate(event.target.value)}
                  onKeyDown={(event) => {
                    // 回车即提交：number 输入框失焦才会触发 onBlur，
                    // 这里主动收焦点，避免用户以为「回车没反应」。
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  aria-label={t('自定义帧率')}
                />
                <Text type="secondary" className="text-[10px] leading-none">
                  fps
                </Text>
                <Text
                  type="secondary"
                  className="ml-auto text-[10px] leading-none tabular-nums"
                >
                  {`${MIN_CUSTOM_FRAMERATE}–${maxFrameRate}`}
                </Text>
              </div>
              <Paragraph
                type="secondary"
                className="m-0 text-[10px] leading-tight"
              >
                {t('按此帧率采集与发送，实测值见「房间状态」的采集帧率')}
              </Paragraph>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Text type="secondary" className="text-[10px] leading-none">
              {t('画面偏好')}
            </Text>
            <MiniSegmented
              options={DEGRADATION_OPTIONS.map((option) => ({
                value: option.value,
                label: t(option.labelKey),
              }))}
              value={settings.degradationPreference}
              onChange={(value) =>
                onDegradationChange(value as RTCDegradationPreference)
              }
            />
            <Paragraph
              type="secondary"
              className="m-0 text-[10px] leading-tight"
            >
              {t(
                DEGRADATION_OPTIONS.find(
                  (option) => option.value === settings.degradationPreference
                )?.hintKey ?? '带宽不足时牺牲什么'
              )}
            </Paragraph>
          </div>

          <Paragraph
            type="secondary"
            className="m-0 border-t pt-2 text-[10px] leading-tight"
            style={{
              borderColor:
                'color-mix(in srgb, var(--md-sys-color-outline-variant) 55%, transparent)',
            }}
          >
            {switchingResolution
              ? t('正在重新采集...')
              : isSharing
                ? t('共享中改这些项即时生效，观众无感')
                : t('共享中也可随时调整')}
          </Paragraph>
        </div>
      )}
    </div>
  )

  const audioGroup = (
    <div className={cn('flex flex-col', gap)}>
      <SectionTitle
        icon={<Volume2 className="h-3.5 w-3.5" />}
        label={t('声音')}
      />
      <SettingRow
        label={t('共享系统音频')}
        hint={
          isCamera
            ? t('摄像头没有系统声；观众听到的声音来自麦克风')
            : isSharing
              ? t('系统音频需要先结束共享才能改；麦克风与音频码率可以随时调')
              : undefined
        }
      >
        <Switch
          checked={settings.shareSystemAudio}
          onChange={(e) => onSystemAudioChange(e.target.checked)}
          disabled={isSharing || isCamera}
          aria-label={t('共享系统音频')}
        />
      </SettingRow>
      <div className="flex flex-col gap-1.5">
        <SettingRow
          label={t('音频码率')}
          hint={
            audioOption
              ? `${audioOption.value / 1000} kbps · ${t(audioOption.hintKey)}`
              : undefined
          }
        />
        <MiniSegmented
          options={AUDIO_BITRATE_OPTIONS.map((option) => ({
            value: String(option.value),
            label: t(option.labelKey),
          }))}
          value={String(settings.maxAudioBitrate)}
          onChange={(value) => onAudioBitrateChange(Number(value))}
        />
      </div>
      <SettingRow label={t('共享麦克风')}>
        <Switch
          checked={settings.shareMicrophone}
          onChange={(e) => onMicrophoneChange(e.target.checked)}
          aria-label={t('共享麦克风')}
        />
      </SettingRow>
    </div>
  )

  // 两栏：左「画面」右「声音」，中间一条竖细线分区。窄屏（sm 以下）退回单栏，
  // 竖线换成一条横线，避免两列被压成谁也看不清的宽度。
  if (split) {
    return (
      <div className="grid w-full min-w-0 grid-cols-1 gap-x-6 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col">
          {screenGroup}
          <Divider />
          {qualityGroup}
          <Divider />
          {advancedGroup}
        </div>
        <div
          className="mt-3 flex min-w-0 flex-col border-t pt-3 sm:mt-0 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0"
          style={{ borderColor: HAIRLINE }}
        >
          {audioGroup}
        </div>
      </div>
    )
  }

  return (
    <div className="flex w-full min-w-0 flex-col">
      {screenGroup}
      <Divider />
      {qualityGroup}
      <Divider />
      {advancedGroup}
      <Divider />
      {audioGroup}
    </div>
  )
}
