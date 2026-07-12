import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Activity,
  Cpu,
  Gauge,
  Layers,
  Radio,
  Signal,
  Waypoints,
} from 'lucide-react'
import { Switch } from '@/components/ui/Switch'
import { Tag } from '@/components/ui/Tag'
import { Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import { useSocket } from '@/hooks/useSocket'
import {
  useConnectionStats,
  type SharingMode,
} from '@/hooks/useConnectionStats'
import { useP2PTunnel, type P2PStatus } from '@/hooks/useP2PTunnel'

export interface SharingStatusPanelProps {
  pc: RTCPeerConnection | null
  /** 当前角色：发送端 / 接收端 */
  mode: 'sender' | 'receiver'
  /** 共享模式标签：服务器中转 / P2P 直连 */
  sharingMode: SharingMode
  /** P2P 直连开关当前状态（外部同步覆盖，例如来自 p2p-mode-change 广播） */
  p2pEnabled?: boolean
  /** P2P 直连开关回调（Task 6.3 接入，本任务预留） */
  onToggleP2P?: (enabled: boolean) => void
  /** 本地媒体流（sender 模式下用于 P2P 轨道注入） */
  localStream?: MediaStream | null
  /** 远端成员 socketId（sender 模式下指定 P2P 对端；receiver 可由 offer 自动填充） */
  remotePeerId?: string | null
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
  return mode === 'p2p' ? 'P2P 直连' : '服务器中转'
}

function getSharingModeColor(): 'success' | 'primary' {
  // P2P 直连用 success 突出低延迟直连；服务器中转用 primary
  return 'primary'
}

function getRoleLabel(role: 'sender' | 'receiver'): string {
  return role === 'sender' ? '发送端' : '接收端'
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

function getP2PStatusLabel(status: P2PStatus): string {
  switch (status) {
    case 'idle':
      return '未启用'
    case 'connecting':
      return 'P2P 协商中'
    case 'connected':
      return 'P2P 直连'
    case 'failed':
      return '已回退到服务器中转'
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
  mode,
  sharingMode,
  p2pEnabled: p2pEnabledProp,
  onToggleP2P,
  localStream,
  remotePeerId,
}: SharingStatusPanelProps) {
  const { socket } = useSocket()
  const { roomId: routeRoomId } = useParams<{ roomId?: string }>()
  const roomId = routeRoomId ?? ''

  const [fallbackNotice, setFallbackNotice] = useState(false)

  const handleP2PStatusChange = useMemo(
    () => (status: P2PStatus, didFallback: boolean) => {
      if (didFallback) {
        setFallbackNotice(true)
        message.warning('已回退到服务器中转')
      } else if (status === 'connected') {
        setFallbackNotice(false)
        message.success('P2P 直连已建立')
      } else if (status === 'connecting') {
        setFallbackNotice(false)
      }
    },
    []
  )

  const {
    enableP2P,
    disableP2P,
    p2pEnabled: p2pTunnelEnabled,
    p2pPC,
    p2pStatus,
  } = useP2PTunnel({
    socket,
    roomId,
    localStream,
    role: mode,
    remotePeerId,
    onStatusChange: handleP2PStatusChange,
  })

  // 房主切换 P2P 时：触发 hook 的 enable/disable，并广播状态给房间成员
  const handleToggleP2P = (enabled: boolean) => {
    if (enabled) {
      void enableP2P()
    } else {
      disableP2P()
    }
    onToggleP2P?.(enabled)
    if (socket && roomId) {
      socket.emit('p2p-mode-change', { roomId, enabled })
    }
  }

  // 接收房间内 P2P 模式广播：同步开关状态（房主以外的成员仅同步显示）
  useEffect(() => {
    if (!socket) return
    const handleP2PModeChange = (data: {
      roomId: string
      enabled: boolean
    }) => {
      if (!roomId || data.roomId !== roomId) return
      if (data.enabled) {
        void enableP2P()
      } else {
        disableP2P()
      }
    }
    socket.on('p2p-mode-change', handleP2PModeChange)
    return () => {
      socket.off('p2p-mode-change', handleP2PModeChange)
    }
  }, [socket, roomId, enableP2P, disableP2P])

  // 真正展示给统计面板的 PC：P2P 启用时切换为 p2pPC
  const displayPC = p2pTunnelEnabled ? p2pPC : pc
  const displaySharingMode: SharingMode = p2pTunnelEnabled ? 'p2p' : sharingMode

  // SharingStatusPanel 内部始终使用 server 模式（旧 ConnectionMode 用于 tag 展示），
  // 真正的共享模式由 sharingMode 字段表达
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

  const bitrateHint = mode === 'sender' ? '上行码率' : '下行码率'

  const switchChecked = p2pTunnelEnabled || p2pEnabledProp || false

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
        <Paragraph className="m-0 text-sm font-semibold">共享情况</Paragraph>
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
        {p2pTunnelEnabled && (
          <Tag color={getP2PStatusColor(p2pStatus)}>
            {getP2PStatusLabel(p2pStatus)}
          </Tag>
        )}
        {fallbackNotice && !p2pTunnelEnabled && (
          <Tag color="warning">已回退到服务器中转</Tag>
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
            <Paragraph className="m-0 text-xs font-medium">P2P 直连</Paragraph>
            <Text type="secondary" className="text-[10px] opacity-70">
              {p2pTunnelEnabled
                ? getP2PStatusLabel(p2pStatus)
                : fallbackNotice
                  ? '已回退到服务器中转'
                  : '点击切换至 P2P'}
            </Text>
          </div>
        </div>
        <Switch
          checked={switchChecked}
          onChange={(e) => handleToggleP2P(e.target.checked)}
        />
      </div>

      {/* 实时统计字段列表 */}
      <div className="flex flex-col gap-2 overflow-y-auto pr-1">
        <StatRow
          icon={<Gauge className="h-3.5 w-3.5" />}
          label="帧率"
          value={fpsText}
        />
        <StatRow
          icon={<Signal className="h-3.5 w-3.5" />}
          label="丢包率"
          value={lossText}
        />
        <StatRow
          icon={<Radio className="h-3.5 w-3.5" />}
          label="实时码率"
          hint={bitrateHint}
          value={bitrateText}
        />
        <StatRow
          icon={<Layers className="h-3.5 w-3.5" />}
          label="分辨率"
          value={resolutionText}
        />
        <StatRow
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="编码格式"
          value={codecText}
        />
        <StatRow
          icon={<Activity className="h-3.5 w-3.5" />}
          label="RTT 往返时延"
          value={rttText}
        />
        <StatRow
          icon={<Signal className="h-3.5 w-3.5" />}
          label="抖动"
          value={jitterText}
        />
      </div>

      {/* 底部说明 */}
      <Text
        type="secondary"
        className="mt-auto text-[10px] leading-tight opacity-70"
      >
        每 1 秒采样一次 WebRTC 统计；码率为上一秒平均速率。
      </Text>
    </div>
  )
}

export default SharingStatusPanel
