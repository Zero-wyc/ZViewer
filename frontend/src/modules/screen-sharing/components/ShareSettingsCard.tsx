/**
 * 共享参数卡片（房主侧）。
 *
 * 结构借鉴 Piik 的「分享设置」面板：一键画质档位在最上层，细项收进可折叠的
 * 「详细参数」，声音单独一组。两块 UI 共用同一个组件——开始共享前的卡片，
 * 以及共享中从控制栏拉起的浮层，参数完全一致（共享中改的是同一份设置）。
 *
 * 一切都是受控的：组件不持有时长/档位状态，也不碰会话，避免两处 UI 各存一份
 * 真相（那正是「界面显示 1080P、实际发 720P」的来源）。
 */
import { useState } from 'react'
import { ChevronDown, Gauge, MonitorPlay, Volume2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InputNumber } from '@/components/ui/InputNumber'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { Select } from '@/components/ui/Select'
import { Space } from '@/components/ui/Space'
import { Switch } from '@/components/ui/Switch'
import { Paragraph, Text } from '@/components/ui/Typography'
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
import type { WebrtcShareMediaSettings } from '../utils/mediaSettingsStorage'
import { t } from '@/i18n'

export interface ShareSettingsCardProps {
  settings: WebrtcShareMediaSettings
  /** 是否正在共享：决定哪些项可以热改。 */
  isSharing: boolean
  /** 正在热切换分辨率（重新采集中，禁用档位选择防重入）。 */
  switchingResolution?: boolean
  /** 紧凑模式：共享中的浮层，默认收起详细参数。 */
  compact?: boolean
  onPresetChange: (id: QualityPresetId) => void
  onResolutionChange: (preset: ResolutionPreset) => void
  onFrameRateChange: (fps: number) => void
  onBitrateChange: (mbps: number) => void
  onDegradationChange: (preference: RTCDegradationPreference) => void
  onAudioBitrateChange: (bitrate: number) => void
  onSystemAudioChange: (enabled: boolean) => void
  onMicrophoneChange: (enabled: boolean) => void
}

/** 一行小标题：图标 + 文案 + 右侧可选说明。 */
function SectionTitle({
  icon,
  label,
}: {
  icon: React.ReactNode
  label: string
}): JSX.Element {
  return (
    <Space align="center" size="sm" className="mb-2">
      <span className="text-[var(--md-sys-color-primary)]">{icon}</span>
      <Text className="text-xs font-medium">{label}</Text>
    </Space>
  )
}

export function ShareSettingsCard({
  settings,
  isSharing,
  switchingResolution = false,
  compact = false,
  onPresetChange,
  onResolutionChange,
  onFrameRateChange,
  onBitrateChange,
  onDegradationChange,
  onAudioBitrateChange,
  onSystemAudioChange,
  onMicrophoneChange,
}: ShareSettingsCardProps): JSX.Element {
  // 细项默认收起：房间里的共享区高度有限，一上来摊开五组控件会把「开始共享」
  // 挤出可视区。收起时仍显示一行当前参数摘要，信息不丢（Piik 同样是这个做法）。
  const [advanced, setAdvanced] = useState(false)
  const activePreset = matchQualityPreset(settings)
  const recommendedBitrate = Math.max(2, Math.round(settings.frameRate * 0.267))

  return (
    <Space
      direction="vertical"
      className="w-full"
      // 浮层里空间更紧，组间距收一档。
      size={compact ? 'sm' : 'md'}
    >
      {/* 一键档位 */}
      <div>
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
                  'rounded-xl border px-2 py-2 text-left transition disabled:opacity-60',
                  selected
                    ? 'border-[var(--md-sys-color-primary)] bg-[color-mix(in_srgb,var(--md-sys-color-primary)_12%,transparent)]'
                    : 'border-[var(--md-sys-color-outline-variant)] hover:border-[var(--md-sys-color-primary)]'
                )}
              >
                <div className="text-xs font-medium">{t(preset.labelKey)}</div>
                <div className="mt-0.5 text-[10px] leading-tight text-[var(--md-sys-color-on-surface-variant)]">
                  {preset.resolutionPreset.toUpperCase()} · {preset.frameRate}
                  fps · {preset.maxBitrateMbps}Mbps
                </div>
              </button>
            )
          })}
        </div>
        <Paragraph
          type="secondary"
          className="m-0 mt-1.5 text-[10px] leading-tight"
        >
          {activePreset
            ? t(
                QUALITY_PRESETS.find((item) => item.id === activePreset)!
                  .hintKey
              )
            : t('自定义参数：下面的细项不再对应任何一个档位')}
        </Paragraph>
      </div>

      {/* 细项：默认展开（开始前），紧凑模式默认收起 */}
      <div>
        <button
          type="button"
          onClick={() => setAdvanced((value) => !value)}
          aria-expanded={advanced}
          className="flex w-full items-center justify-between rounded-lg px-1 py-1 text-xs font-medium text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)]"
        >
          <Space align="center" size="sm">
            <Gauge className="h-3.5 w-3.5" />
            {t('详细参数')}
          </Space>
          <Space align="center" size="sm">
            <span className="text-[10px] font-normal text-[var(--md-sys-color-on-surface-variant)]">
              {settings.resolutionPreset.toUpperCase()} · {settings.frameRate}
              fps · {settings.maxBitrateMbps}Mbps
            </span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition', advanced && 'rotate-180')}
            />
          </Space>
        </button>

        {advanced && (
          <Space direction="vertical" className="mt-2 w-full" size="md">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[10px] font-medium text-[var(--md-sys-color-on-surface-variant)]">
                  {t('分辨率')}
                </label>
                <Select
                  options={RESOLUTION_OPTIONS}
                  value={settings.resolutionPreset}
                  onChange={(value) =>
                    onResolutionChange(value as ResolutionPreset)
                  }
                  disabled={switchingResolution}
                  size="sm"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-medium text-[var(--md-sys-color-on-surface-variant)]">
                  {t('帧率')}
                </label>
                <Select
                  options={FRAME_RATE_OPTIONS.map((option) => ({
                    label: option.label,
                    value: String(option.value),
                  }))}
                  value={String(settings.frameRate)}
                  onChange={(value) => onFrameRateChange(Number(value))}
                  size="sm"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[10px] font-medium text-[var(--md-sys-color-on-surface-variant)]">
                {t('最大码率（Mbps）')}
              </label>
              <InputNumber
                min={0.5}
                max={50}
                step={0.5}
                value={settings.maxBitrateMbps}
                onChange={(value) => onBitrateChange(value ?? 8)}
              />
              <Paragraph
                type="secondary"
                className="m-0 mt-1 text-[10px] leading-tight"
              >
                {t('推荐')} {settings.frameRate}fps ≥ {recommendedBitrate} Mbps
                {settings.frameRate >= 45 && t('，码率不足将导致降帧')}
              </Paragraph>
            </div>

            <div>
              <label className="mb-1 block text-[10px] font-medium text-[var(--md-sys-color-on-surface-variant)]">
                {t('画面偏好')}
              </label>
              <SegmentedToggle
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
                className="m-0 mt-1 text-[10px] leading-tight"
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
              className="m-0 text-[10px] leading-tight"
            >
              {switchingResolution
                ? t('正在重新采集...')
                : isSharing
                  ? t('共享中改这些项即时生效，观众无感')
                  : t('共享中也可随时调整')}
            </Paragraph>
          </Space>
        )}
      </div>

      {/* 声音 */}
      <div>
        <SectionTitle
          icon={<Volume2 className="h-3.5 w-3.5" />}
          label={t('声音')}
        />
        <Space direction="vertical" className="w-full" size="sm">
          <Switch
            label={t('共享系统音频')}
            checked={settings.shareSystemAudio}
            onChange={(e) => onSystemAudioChange(e.target.checked)}
            disabled={isSharing}
          />
          {isSharing && (
            <Paragraph
              type="secondary"
              className="m-0 text-[10px] leading-tight"
            >
              {t('系统音频需要先结束共享才能改；麦克风与音频码率可以随时调')}
            </Paragraph>
          )}
          <div>
            <label className="mb-1 block text-[10px] font-medium text-[var(--md-sys-color-on-surface-variant)]">
              {t('音频码率')}
            </label>
            <SegmentedToggle
              options={AUDIO_BITRATE_OPTIONS.map((option) => ({
                value: String(option.value),
                label: `${t(option.labelKey)} ${option.value / 1000}k`,
              }))}
              value={String(settings.maxAudioBitrate)}
              onChange={(value) => onAudioBitrateChange(Number(value))}
            />
          </div>
          <Switch
            label={t('共享麦克风')}
            checked={settings.shareMicrophone}
            onChange={(e) => onMicrophoneChange(e.target.checked)}
          />
        </Space>
      </div>
    </Space>
  )
}
