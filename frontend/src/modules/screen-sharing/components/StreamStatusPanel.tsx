import { memo } from 'react'
import {
  Radio,
  Loader2,
  AlertCircle,
  Gauge,
  MonitorPlay,
  Activity,
  Zap,
  Wifi,
  Film,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Tag } from '@/components/ui/Tag'
import type { StreamStatus } from '@/store/roomStore'
import type { FlvStatistics } from './FlvPlayer'

interface StreamStatusPanelProps {
  /** 推流状态 */
  streamStatus: StreamStatus
  /** flv.js 拉流统计信息 */
  statistics?: FlvStatistics | null
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

/** 计算丢帧率百分比 */
function calcDropRate(stats: FlvStatistics | null | undefined): string {
  if (!stats || stats.totalVideoFrames === 0) return '0.0%'
  return ((stats.droppedVideoFrames / stats.totalVideoFrames) * 100).toFixed(1) + '%'
}

/** 统计卡片 */
function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub?: string
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-[var(--md-sys-color-surface-container-highest)] p-3">
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--md-sys-color-surface-container-high)]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
          {label}
        </div>
        <div className="truncate font-mono text-sm font-semibold">
          {value}
        </div>
        {sub && (
          <div className="truncate text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            {sub}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * 推流状态面板（stream-push 子模式使用）。
 *
 * 显示 OBS 推流状态和 flv.js 拉流实时统计（码率、帧率、丢帧等）。
 * 使用 React.memo 优化：statistics 每秒更新时仅重渲染本组件，不影响父组件。
 */
export const StreamStatusPanel = memo(function StreamStatusPanel({
  streamStatus,
  statistics,
}: StreamStatusPanelProps) {
  const isLive = streamStatus === 'live'
  const hasStats = isLive && !!statistics

  return (
    <Card className="w-full p-4 text-left">
      {/* 卡片头部 */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[var(--md-sys-color-primary)] to-[var(--md-sys-color-tertiary)]">
          <MonitorPlay className="h-4.5 w-4.5 text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold">推流状态</div>
          <div className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
            Stream Push Monitor
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {getStatusIcon(streamStatus)}
          <Tag color={getStatusColor(streamStatus)}>
            {getStatusText(streamStatus)}
          </Tag>
        </div>
      </div>

      {/* 统计网格 */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 lg:grid-cols-4">
        <StatCard
          icon={
            <Zap
              className="h-4.5 w-4.5"
              style={{ color: 'var(--md-sys-color-primary)' }}
            />
          }
          label="总码率"
          value={hasStats ? `${statistics!.videoDataRate + statistics!.audioDataRate} kbps` : '--'}
          sub={
            hasStats
              ? `视频 ${statistics!.videoDataRate} / 音频 ${statistics!.audioDataRate}`
              : '等待推流'
          }
        />
        <StatCard
          icon={
            <Film
              className="h-4.5 w-4.5"
              style={{ color: 'var(--md-sys-color-tertiary)' }}
            />
          }
          label="帧率"
          value={hasStats ? `${statistics!.fps} fps` : '--'}
          sub="实时帧率"
        />
        <StatCard
          icon={
            <Wifi
              className="h-4.5 w-4.5"
              style={{ color: 'var(--md-sys-color-secondary)' }}
            />
          }
          label="下载速度"
          value={hasStats ? `${statistics!.speed} KB/s` : '--'}
          sub="网络拉流速度"
        />
        <StatCard
          icon={
            <Activity
              className="h-4.5 w-4.5"
              style={{
                color: hasStats && statistics!.droppedVideoFrames > 0
                  ? 'var(--md-sys-color-error)'
                  : 'var(--md-sys-color-primary)'
              }}
            />
          }
          label="丢帧率"
          value={hasStats ? calcDropRate(statistics) : '--'}
          sub={
            hasStats
              ? `${statistics!.droppedVideoFrames} / ${statistics!.totalVideoFrames} 帧`
              : '丢帧 / 总帧'
          }
        />
      </div>

      {/* 提示信息 */}
      <div className="mt-3 rounded-lg bg-[var(--md-sys-color-surface-container-high)] px-3 py-2">
        <div className="flex items-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
          <Gauge className="h-3.5 w-3.5 flex-shrink-0" />
          <span>
            {isLive
              ? '房主正在推流，HTTP-FLV 拉流播放中'
              : streamStatus === 'offline'
                ? '等待房主开始 OBS 推流'
                : '正在获取推流状态...'}
          </span>
        </div>
      </div>
    </Card>
  )
})
