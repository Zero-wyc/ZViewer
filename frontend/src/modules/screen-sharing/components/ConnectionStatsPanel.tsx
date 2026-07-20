import { Activity } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import {
  useConnectionStats,
  type ConnectionMode,
} from '../hooks/useConnectionStats'

interface ConnectionStatsPanelProps {
  pc: RTCPeerConnection | null
  mode: ConnectionMode
}

function getConnectionStateColor(
  state: RTCPeerConnectionState
): 'default' | 'primary' | 'success' | 'danger' {
  switch (state) {
    case 'connected':
      return 'success'
    case 'connecting':
      return 'primary'
    case 'failed':
    case 'disconnected':
    case 'closed':
      return 'danger'
    default:
      return 'default'
  }
}

function getConnectionStateText(state: RTCPeerConnectionState): string {
  switch (state) {
    case 'new':
      return '等待连接'
    case 'connecting':
      return '连接中'
    case 'connected':
      return '已连接'
    case 'disconnected':
      return '已断开'
    case 'failed':
      return '连接失败'
    case 'closed':
      return '连接已关闭'
    default:
      return state
  }
}

function getModeText(mode: ConnectionMode): string {
  switch (mode) {
    case 'direct':
      return '直连模式'
    case 'server':
      return '服务器模式'
    default:
      return '未知模式'
  }
}

function getModeColor(
  mode: ConnectionMode
): 'default' | 'primary' | 'success' | 'purple' {
  switch (mode) {
    case 'direct':
      return 'success'
    case 'server':
      return 'primary'
    default:
      return 'default'
  }
}

export function ConnectionStatsPanel({ pc, mode }: ConnectionStatsPanelProps) {
  const { stats, formatBitrate, formatNumber, formatPacketLoss } =
    useConnectionStats(pc, mode)

  return (
    <Card className="w-full p-6 text-left">
      <div className="flex items-center gap-2 mb-4">
        <Activity
          className="h-5 w-5"
          style={{ color: 'var(--md-sys-color-primary)' }}
        />
        <Paragraph className="m-0 text-base font-medium">连接统计</Paragraph>
      </div>
      <Space wrap className="gap-2 mb-4 text-base">
        <Tag color={getModeColor(stats.mode)}>{getModeText(stats.mode)}</Tag>
        <Tag color={getConnectionStateColor(stats.connectionState)}>
          {getConnectionStateText(stats.connectionState)}
        </Tag>
      </Space>
      <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            视频分辨率
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {stats.resolution
              ? `${stats.resolution.width} x ${stats.resolution.height}`
              : '-'}
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            帧率
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {stats.frameRate === null ? '-' : `${stats.frameRate} fps`}
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            码率
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {formatBitrate(stats.bitrate)}
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            已收/已发数据包
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {stats.packetsReceived !== null
              ? formatNumber(stats.packetsReceived)
              : stats.packetsSent !== null
                ? formatNumber(stats.packetsSent)
                : '-'}
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            丢包数
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {formatNumber(stats.packetsLost)}
          </Paragraph>
        </div>
        <div className="rounded-lg bg-[var(--md-sys-color-surface-container-highest)] p-4">
          <Text type="secondary" className="text-sm">
            丢包率
          </Text>
          <Paragraph className="m-0 font-mono text-base font-semibold">
            {formatPacketLoss(stats.packetLossRate)}
          </Paragraph>
        </div>
      </div>
    </Card>
  )
}
