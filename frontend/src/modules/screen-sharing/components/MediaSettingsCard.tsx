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
    <Card className="w-full border-0 bg-transparent p-0 text-left shadow-none">
      <Space direction="vertical" className="w-full py-2" size="lg">
        <Space align="center" size="sm" className="mb-1">
          <Settings2 className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
          <Text className="font-medium">媒体设置</Text>
        </Space>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
              帧率
            </label>
            <Select
              options={FRAME_RATE_OPTIONS}
              value={String(frameRate)}
              onChange={(value) => onFrameRateChange(Number(value))}
            />
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
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
            />
            <Paragraph
              type="secondary"
              className="m-0 mt-1 text-[10px] leading-tight"
            >
              推荐 {frameRate}fps ≥ {Math.max(2, Math.round(frameRate * 0.267))}{' '}
              Mbps
              {frameRate >= 45 && '，码率不足将导致降帧'}
            </Paragraph>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
        </div>

        {isSharing && (
          <Paragraph type="secondary" className="m-0 text-xs">
            共享期间修改帧率/码率即时生效，无需重启共享；系统音频与麦克风仍需先结束共享。
          </Paragraph>
        )}
      </Space>
    </Card>
  )
}
