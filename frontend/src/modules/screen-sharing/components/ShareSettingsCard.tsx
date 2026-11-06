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
import { InputNumber } from '@/components/ui/InputNumber'
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
import type {
  CaptureSource,
  WebrtcShareMediaSettings,
} from '../utils/mediaSettingsStorage'
import { t } from '@/i18n'

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
  onPresetChange: (id: QualityPresetId) => void
  onResolutionChange: (preset: ResolutionPreset) => void
  onFrameRateChange: (fps: number) => void
  onBitrateChange: (mbps: number) => void
  onDegradationChange: (preference: RTCDegradationPreference) => void
  onAudioBitrateChange: (bitrate: number) => void
  onSystemAudioChange: (enabled: boolean) => void
  onMicrophoneChange: (enabled: boolean) => void
  /** 切换采集源（屏幕 / 摄像头）。 */
  onCaptureSourceChange: (source: CaptureSource) => void
  /** 换摄像头设备。 */
  onCameraDeviceChange: (deviceId: string) => void
}

/** 组间分隔线：细分、低对比，只做分区不做强调。 */
function Divider(): JSX.Element {
  return (
    <div
      className="my-3 h-px shrink-0"
      style={{
        backgroundColor:
          'color-mix(in srgb, var(--md-sys-color-outline-variant) 55%, transparent)',
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
  onPresetChange,
  onResolutionChange,
  onFrameRateChange,
  onBitrateChange,
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
  const recommendedBitrate = Math.max(2, Math.round(settings.frameRate * 0.267))
  const isCamera = settings.captureSource === 'camera'
  const summary = `${settings.resolutionPreset.toUpperCase()} · ${settings.frameRate}fps · ${settings.maxBitrateMbps}Mbps`
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

  return (
    <div className="flex w-full min-w-0 flex-col">
      {/* ── 共享画面 ─────────────────────────────────────────────── */}
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

      <Divider />

      {/* ── 画质档位 ─────────────────────────────────────────────── */}
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
                onClick={() => onPresetChange(preset.id)}
                disabled={switchingResolution}
                aria-pressed={selected}
                title={t(preset.hintKey)}
                className={cn(
                  'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-2.5',
                  'transition-colors disabled:opacity-60',
                  selected
                    ? 'border-[var(--md-sys-color-primary)] bg-[color-mix(in_srgb,var(--md-sys-color-primary)_10%,transparent)]'
                    : 'border-[var(--md-sys-color-outline-variant)] hover:border-[var(--md-sys-color-outline)] hover:bg-[var(--md-sys-color-surface-container-high)]/60'
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
                  fps · {preset.maxBitrateMbps}M
                </span>
              </button>
            )
          })}
        </div>
        <Paragraph type="secondary" className="m-0 text-[10px] leading-tight">
          {activePreset
            ? t(
                QUALITY_PRESETS.find((item) => item.id === activePreset)!
                  .hintKey
              )
            : t('自定义参数：下面的细项不再对应任何一个档位')}
        </Paragraph>
      </div>

      <Divider />

      {/* ── 详细参数（折叠） ─────────────────────────────────────── */}
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
                  options={FRAME_RATE_OPTIONS.map((option) => ({
                    label: option.label,
                    value: String(option.value),
                  }))}
                  value={String(settings.frameRate)}
                  onChange={(value) => onFrameRateChange(Number(value))}
                  size="sm"
                />
              </label>
            </div>

            <label className="flex flex-col gap-1">
              <Text type="secondary" className="text-[10px] leading-none">
                {t('最大码率（Mbps）')}
              </Text>
              <InputNumber
                min={0.5}
                max={50}
                step={0.5}
                value={settings.maxBitrateMbps}
                onChange={(value) => onBitrateChange(value ?? 8)}
              />
              <Paragraph
                type="secondary"
                className="m-0 text-[10px] leading-tight"
              >
                {t('推荐')} {settings.frameRate}fps ≥ {recommendedBitrate} Mbps
                {settings.frameRate >= 45 && t('，码率不足将导致降帧')}
              </Paragraph>
            </label>

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

      <Divider />

      {/* ── 声音 ─────────────────────────────────────────────────── */}
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
    </div>
  )
}
