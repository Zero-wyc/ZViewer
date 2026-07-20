import { Radio, Loader2, AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import type { StreamStatus } from '../hooks/useStreamPush'

interface StreamStatusPanelProps {
  /** 推流状态 */
  streamStatus: StreamStatus
}

function getStatusText(status: StreamStatus): string {
  switch (status) {
    case 'live':
      return '直播中'
    case 'offline':
      return '未推流'
    case 'unknown':
    default:
      return '等待状态'
  }
}

function getStatusColor(
  status: StreamStatus
): 'default' | 'primary' | 'success' | 'danger' {
  switch (status) {
    case 'live':
      return 'success'
    case 'offline':
      return 'danger'
    case 'unknown':
    default:
      return 'primary'
  }
}

function getStatusIcon(status: StreamStatus) {
  switch (status) {
    case 'live':
      return (
        <Radio
          className="h-5 w-5"
          style={{ color: 'var(--md-sys-color-primary)' }}
        />
      )
    case 'offline':
      return (
        <AlertCircle
          className="h-5 w-5"
          style={{ color: 'var(--md-sys-color-error)' }}
        />
      )
    case 'unknown':
    default:
      return (
        <Loader2
          className="h-5 w-5 animate-spin"
          style={{ color: 'var(--md-sys-color-primary)' }}
        />
      )
  }
}

/**
 * 推流状态面板（stream-push 子模式使用）。
 *
 * 与 ConnectionStatsPanel 风格一致，但显示的是 OBS 推流状态而非 WebRTC 连接统计。
 * stream-push 模式下观众端通过 FlvPlayer 拉流，无 RTCPeerConnection，
 * 因此不能用 ConnectionStatsPanel，改用此面板显示推流状态。
 */
export function StreamStatusPanel({ streamStatus }: StreamStatusPanelProps) {
  return (
    <Card className="w-full p-6 text-left">
      <div className="mb-4 flex items-center gap-2">
        {getStatusIcon(streamStatus)}
        <Paragraph className="m-0 text-base font-medium">推流状态</Paragraph>
      </div>
      <Space wrap className="mb-4 gap-2 text-base">
        <Tag color="primary">OBS 推流模式</Tag>
        <Tag color={getStatusColor(streamStatus)}>
          {getStatusText(streamStatus)}
        </Tag>
      </Space>
      <div className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            播放方式
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            HTTP-FLV 拉流
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            当前状态
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {getStatusText(streamStatus)}
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            提示
          </Text>
          <Paragraph className="m-0 text-sm">
            {streamStatus === 'live'
              ? '房主正在推流，正常播放中'
              : streamStatus === 'offline'
                ? '等待房主开始 OBS 推流'
                : '正在获取推流状态...'}
          </Paragraph>
        </div>
      </div>
    </Card>
  )
}
