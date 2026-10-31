import {
  Activity,
  Cpu,
  Gauge,
  Layers,
  Radio,
  Signal,
  Waypoints,
} from 'lucide-react'
import { Tag } from '@/components/ui/Tag'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Switch } from '@/components/ui/Switch'
import { cn } from '@/lib/utils'
import {
  useConnectionStats,
  type SharingMode,
} from '@/modules/screen-sharing/hooks/useConnectionStats'
import type { P2PStatus } from '@/modules/p2p/types'
import { t } from '@/i18n'

export interface SharingStatusPanelProps {
  /** 服务器中转 PC（P2P 未启用时使用） */
  pc: RTCPeerConnection | null
  /**
   * 采集实测帧率（发送端专属，来自 MediaStreamTrackProcessor 帧率计）。
   * 与下方「帧率」（发送/接收帧率，来自 outbound/inbound-rtp）分离展示：
   * 采集高而发送低 = 编码丢帧；码率上不去 = 网络不足。
   */
  captureFps?: number | null
  /** 当前角色：发送端 / 接收端 */
  mode: 'sender' | 'receiver'
  /** 基础共享模式标签：服务器中转 / P2P 直连 */
  sharingMode: SharingMode
  /** P2P 直连是否已启用（来自外部 useP2PTunnel） */
  p2pEnabled: boolean
  /** P2P 隧道 PC（P2P 启用时切换展示） */
  p2pPC: RTCPeerConnection | null
  /** P2P 协商状态 */
  p2pStatus: P2PStatus
  /** 是否已触发回退到服务器中转 */
  fallbackNotice: boolean
  /** P2P 直连开关回调 */
  onToggleP2P: (enabled: boolean) => void
}

interface StatRowProps {
  icon: React.ReactNode
  label: string
  value: string
  hint?: string
}

function StatRow({ icon, label, value, hint }: StatRowProps) {
  return (
    <div
      className={cn(
        'glass flex items-center justify-between gap-3 rounded-xl px-3 py-2',
        'transition-colors duration-300'
      )}
      style={{
        borderColor: 'var(--md-sys-color-outline-variant)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-primary) 14%, transparent)',
            color: 'var(--md-sys-color-primary)',
          }}
        >
          {icon}
        </span>
        <div className="min-w-0">
          <Text
            type="secondary"
            className="block truncate text-xs leading-tight"
          >
            {label}
          </Text>
          {hint && (
            <Text
              type="secondary"
              className="block text-[10px] leading-tight opacity-70"
            >
              {hint}
            </Text>
          )}
        </div>
      </div>
      <Paragraph
        className="m-0 flex-shrink-0 font-mono text-sm tabular-nums"
        style={{ color: 'var(--md-sys-color-on-surface)' }}
      >
        {value}
      </Paragraph>
    </div>
  )
}

function getSharingModeLabel(mode: SharingMode): string {
  return mode === 'p2p' ? t('P2P 直连') : t('服务器中转')
}

function getSharingModeColor(): 'success' | 'primary' {
  return 'primary'
}

function getRoleLabel(role: 'sender' | 'receiver'): string {
  return role === 'sender' ? t('发送端') : t('接收端')
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
      return t('等待连接')
    case 'connecting':
      return t('连接中')
    case 'connected':
      return t('已连接')
    case 'disconnected':
      return t('已断开')
    case 'failed':
      return t('连接失败')
    case 'closed':
      return t('连接已关闭')
    default:
      return state
  }
}

function getP2PStatusLabel(status: P2PStatus): string {
  switch (status) {
    case 'idle':
      return t('未启用')
    case 'connecting':
      return t('P2P 协商中')
    case 'connected':
      return t('P2P 直连')
    case 'failed':
      return t('已回退到服务器中转')
  }
}

function getP2PStatusColor(
  status: P2PStatus
): 'default' | 'primary' | 'success' | 'danger' {
  switch (status) {
    case 'idle':
      return 'default'
    case 'connecting':
      return 'primary'
    case 'connected':
      return 'success'
    case 'failed':
      return 'danger'
  }
}

export function SharingStatusPanel({
  pc,
  captureFps,
  mode,
  sharingMode,
  p2pEnabled,
  p2pPC,
  p2pStatus,
  fallbackNotice,
  onToggleP2P,
}: SharingStatusPanelProps) {
  // P2P 启用时切换为 p2pPC，否则使用服务器中转 PC
  const displayPC = p2pEnabled ? p2pPC : pc
  const displaySharingMode: SharingMode = p2pEnabled ? 'p2p' : sharingMode
  const legacyMode = displaySharingMode === 'p2p' ? 'direct' : 'server'

  const { stats, formatBitrate, formatPacketLoss } = useConnectionStats(
    displayPC,
    legacyMode,
    displaySharingMode
  )

  const fpsText =
    stats.frameRate === null ? '-' : `${stats.frameRate.toFixed(1)} fps`
  const lossText = formatPacketLoss(stats.packetLossRate)
  const bitrateText = formatBitrate(stats.bitrate)
  const resolutionText = stats.resolution
    ? `${stats.resolution.width} × ${stats.resolution.height}`
    : '-'
  const codecText = stats.codec ?? '-'
  const rttText = stats.rtt === null ? '-' : `${stats.rtt} ms`
  const jitterText = stats.jitter === null ? '-' : `${stats.jitter} ms`
  const bitrateHint = mode === 'sender' ? t('上行码率') : t('下行码率')

  return (
    <div className="glass-card flex h-full w-full flex-col gap-3 rounded-2xl p-4">
      {/* 标题栏 */}
      <div className="flex items-center gap-2">
        <span
          className="flex h-8 w-8 items-center justify-center rounded-lg"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
            color: 'var(--md-sys-color-on-primary-container)',
          }}
        >
          <Activity className="h-4 w-4" />
        </span>
        <Paragraph className="m-0 text-sm font-semibold">
          {t('共享情况')}
        </Paragraph>
      </div>

      {/* 状态标签 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag color="primary">{getRoleLabel(mode)}</Tag>
        <Tag color={getSharingModeColor()}>
          {getSharingModeLabel(displaySharingMode)}
        </Tag>
        <Tag color={getConnectionStateColor(stats.connectionState)}>
          {getConnectionStateText(stats.connectionState)}
        </Tag>
        {p2pEnabled && (
          <Tag color={getP2PStatusColor(p2pStatus)}>
            {getP2PStatusLabel(p2pStatus)}
          </Tag>
        )}
        {fallbackNotice && !p2pEnabled && (
          <Tag color="warning">{t('已回退到服务器中转')}</Tag>
        )}
      </div>

      {/* P2P 直连开关 */}
      <div
        className="glass flex items-center justify-between rounded-xl px-3 py-2"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--md-sys-color-secondary-container) calc(var(--glass-strength) * 100%), transparent)',
          borderColor: 'var(--md-sys-color-outline-variant)',
        }}
      >
        <div className="flex items-center gap-2">
          <Waypoints
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-secondary)' }}
          />
          <div className="leading-tight">
            <Paragraph className="m-0 text-xs font-medium">
              {t('P2P 直连')}
            </Paragraph>
            <Text type="secondary" className="text-[10px] opacity-70">
              {p2pEnabled
                ? getP2PStatusLabel(p2pStatus)
                : fallbackNotice
                  ? t('已回退到服务器中转')
                  : t('点击切换至 P2P')}
            </Text>
          </div>
        </div>
        <Switch
          checked={p2pEnabled}
          onChange={(e) => onToggleP2P(e.target.checked)}
        />
      </div>

      {/* 实时统计字段列表 */}
      <div className="flex flex-col gap-2 overflow-y-auto pr-1">
        {mode === 'sender' && (
          <StatRow
            icon={<Gauge className="h-3.5 w-3.5" />}
            label={t('采集帧率')}
            hint={t('捕获源实测，近零开销')}
            value={
              captureFps === null || captureFps === undefined
                ? '-'
                : `${captureFps.toFixed(1)} fps`
            }
          />
        )}
        <StatRow
          icon={<Gauge className="h-3.5 w-3.5" />}
          label={t('帧率')}
          hint={mode === 'sender' ? t('编码后发送帧率') : undefined}
          value={fpsText}
        />
        <StatRow
          icon={<Signal className="h-3.5 w-3.5" />}
          label={t('丢包率')}
          value={lossText}
        />
        <StatRow
          icon={<Radio className="h-3.5 w-3.5" />}
          label={t('实时码率')}
          hint={bitrateHint}
          value={bitrateText}
        />
        <StatRow
          icon={<Layers className="h-3.5 w-3.5" />}
          label={t('分辨率')}
          value={resolutionText}
        />
        <StatRow
          icon={<Cpu className="h-3.5 w-3.5" />}
          label={t('编码格式')}
          value={codecText}
        />
        <StatRow
          icon={<Activity className="h-3.5 w-3.5" />}
          label={t('RTT 往返时延')}
          value={rttText}
        />
        <StatRow
          icon={<Signal className="h-3.5 w-3.5" />}
          label={t('抖动')}
          value={jitterText}
        />
      </div>

      {/* 底部说明 */}
      <Text
        type="secondary"
        className="mt-auto text-[10px] leading-tight opacity-70"
      >
        {t('每 1 秒采样一次 WebRTC 统计；码率为上一秒平均速率。')}
      </Text>
    </div>
  )
}

export default SharingStatusPanel
