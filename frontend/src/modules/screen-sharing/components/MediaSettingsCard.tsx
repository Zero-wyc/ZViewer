import { Settings2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Switch } from '@/components/ui/Switch'
import { InputNumber } from '@/components/ui/InputNumber'
import { Select } from '@/components/ui/Select'
import { FRAME_RATE_OPTIONS } from '../constants'

interface MediaSettingsCardProps {
  frameRate: number
  maxBitrateMbps: number
  shareSystemAudio: boolean
  shareMicrophone: boolean
  isSharing: boolean
  onFrameRateChange: (value: number) => void
  onMaxBitrateChange: (value: number) => void
  onShareSystemAudioChange: (checked: boolean) => void
  onShareMicrophoneChange: (checked: boolean) => void
}

export function MediaSettingsCard(props: MediaSettingsCardProps): JSX.Element {
  const {
    frameRate,
    maxBitrateMbps,
    shareSystemAudio,
    shareMicrophone,
    isSharing,
    onFrameRateChange,
    onMaxBitrateChange,
    onShareSystemAudioChange,
    onShareMicrophoneChange,
  } = props

  return (
    <Card className="w-full max-w-md min-w-[280px] max-h-full !overflow-y-auto text-left">
      <Space direction="vertical" className="w-full" size="sm">
        <Space align="center" size="sm">
          <Settings2 className="h-4 w-4 text-[var(--md-sys-color-on-surface-variant)]" />
          <Text className="font-medium">媒体设置</Text>
        </Space>
        <div className="text-left">
          <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
            帧率
          </label>
          <Select
            options={FRAME_RATE_OPTIONS}
            value={String(frameRate)}
            onChange={(value) => onFrameRateChange(Number(value))}
            disabled={isSharing}
          />
        </div>
        <div className="text-left">
          <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
            最大码率（Mbps）
          </label>
          <InputNumber
            min={0.5}
            max={50}
            step={0.5}
            value={maxBitrateMbps}
            onChange={(value) =>
              onMaxBitrateChange(value === undefined ? 8 : value)
            }
            disabled={isSharing}
          />
        </div>
        <Switch
          label="共享系统音频"
          checked={shareSystemAudio}
          onChange={(e) => onShareSystemAudioChange(e.target.checked)}
          disabled={isSharing}
        />
        <Switch
          label="共享麦克风"
          checked={shareMicrophone}
          onChange={(e) => onShareMicrophoneChange(e.target.checked)}
          disabled={isSharing}
        />
        {isSharing && (
          <Paragraph type="secondary" className="m-0 text-xs">
            共享期间无法修改媒体设置，请先结束共享。
          </Paragraph>
        )}
      </Space>
    </Card>
  )
}
