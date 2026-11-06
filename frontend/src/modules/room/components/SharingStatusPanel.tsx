import {
  Activity,
  Boxes,
  Cpu,
  Gauge,
  Layers,
  Radio,
  Signal,
  Timer,
  Users,
  Video,
  Volume2,
} from 'lucide-react'
import { Tag } from '@/components/ui/Tag'
import { Text, Paragraph } from '@/components/ui/Typography'
import { cn } from '@/lib/utils'
import {
  formatBitrate,
  formatMsPerFrame,
  formatPacketLoss,
  type SharingMode,
} from '@/modules/screen-sharing/hooks/useConnectionStats'
import {
  aggregateEdgeStats,
  type ShareEdgeStats,
} from '@/modules/screen-sharing/core/edge-stats'
import type {
  QualityLimitationDurations,
  QualityLimitationReason,
} from '@/modules/screen-sharing/core/stats'
import {
  peerQualitySeverity,
  type PeerQuality,
} from '@/modules/screen-sharing/core/peer-quality'
import { t } from '@/i18n'

export interface SharingStatusPanelProps {
  /**
   * 每条连接（边）的统计。
   *
   * Piik 链路没有「唯一一条 PC」：房主一位观众一条出边，观众一条入边。
   * 面板先汇总成一份整体数字，再多连接时逐条列出——单条 PC 的旧口径在这里
   * 已经不成立了。
   */
  edges: ShareEdgeStats[]
  /**
   * 采集实测帧率（发送端专属，来自 MediaStreamTrackProcessor 帧率计）。
   * 与下方「帧率」（发送/接收帧率，来自 outbound/inbound-rtp）分离展示：
   * 采集高而发送低 = 编码丢帧；码率上不去 = 网络不足。
   */
  captureFps?: number | null
  /** 当前角色：发送端 / 接收端 */
  mode: 'sender' | 'receiver'
  /** 共享模式标签：服务器中转 / P2P 直连 */
  sharingMode: SharingMode
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
  // 「直连」指媒体不过服务端（只借它换 SDP/ICE）；中继才真的占服务端带宽。
  return mode === 'relay' ? t('服务器转发') : t('浏览器直连')
}

/**
 * 编码受限原因。
 *
 * 这是定位「画面糊/掉帧」最关键的一列：带宽不足要降档位或换网络，CPU 不足
 * 要降分辨率或换硬件编码，两者处置完全不同，靠猜只会白折腾。
 */
function getLimitationText(reason: QualityLimitationReason | null): string {
  switch (reason) {
    case null:
      return '-'
    case 'none':
      return t('无')
    case 'cpu':
      return t('CPU 不足')
    case 'bandwidth':
      return t('带宽不足')
    case 'other':
      return t('其他')
  }
}

function getLimitationColor(
  reason: QualityLimitationReason | null
): 'default' | 'success' | 'warning' {
  if (reason === null) return 'default'
  return reason === 'none' ? 'success' : 'warning'
}

/**
 * 本窗口内占比最高的受限原因。
 *
 * 只看瞬时 `qualityLimitationReason` 会闪（浏览器每帧都可能换原因），
 * 窗口占比能回答「这一分钟到底卡在哪」，比瞬时值可靠得多。
 */
function dominantLimitation(
  share: QualityLimitationDurations | null
): [QualityLimitationReason, number] | null {
  if (!share) return null
  const reasons: QualityLimitationReason[] = [
    'none',
    'bandwidth',
    'cpu',
    'other',
  ]
  let best: QualityLimitationReason = 'none'
  for (const reason of reasons) {
    if (share[reason] > share[best]) best = reason
  }
  return [best, share[best]]
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

/**
 * 质量等级 → 展示文案。等级判定本身在 core/peer-quality（有单测）。
 * 房主的出边才有观众回传的丢包与 RTT，入边退回连接状态。
 */
function peerQualityText(
  quality: PeerQuality,
  state: RTCPeerConnectionState
): string {
  switch (peerQualitySeverity(quality, state)) {
    case 'offline':
      return t('未连接')
    case 'loss':
      return t('丢包 {{value}}', {
        value: `${((quality.packetLossRate ?? 0) * 100).toFixed(1)}%`,
      })
    case 'latency':
      return t('延迟 {{value}}', { value: `${quality.rttMs ?? 0} ms` })
    case 'bandwidth':
      return t('上行带宽受限')
    case 'cpu':
      return t('编码 CPU 受限')
    default:
      return t('良好')
  }
}

function peerQualityColor(
  quality: PeerQuality,
  state: RTCPeerConnectionState
): 'default' | 'success' | 'warning' {
  const severity = peerQualitySeverity(quality, state)
  if (severity === 'offline') return 'default'
  return severity === 'good' ? 'success' : 'warning'
}

/** 一条边的摘要：分辨率 · 帧率 · 码率，多观众时一眼看出谁慢。 */
function edgeSummary(edge: ShareEdgeStats): string {
  const parts: string[] = []
  const resolution = edge.stats.resolution
  if (resolution) parts.push(`${resolution.width} × ${resolution.height}`)
  if (edge.stats.frameRate !== null)
    parts.push(`${edge.stats.frameRate.toFixed(1)} fps`)
  const bitrate = formatBitrate(edge.stats.bitrate)
  if (bitrate !== '-') parts.push(bitrate)
  return parts.length > 0 ? parts.join(' · ') : '-'
}

export function SharingStatusPanel({
  edges,
  captureFps,
  mode,
  sharingMode,
}: SharingStatusPanelProps) {
  // 汇总口径写在 core/edge-stats：帧率/丢包取最差一条，码率求和。
  const stats = aggregateEdgeStats(edges)
  const hasEdges = edges.length > 0

  const fpsText =
    stats.frameRate === null ? '-' : `${stats.frameRate.toFixed(1)} fps`
  // 主值看本窗口：累计丢包率会把几分钟前的丢包摊薄，看不出「现在卡不卡」。
  // 累计值降级成副标题，需要判断「一直不好还是刚好不好」时仍然可查。
  const lossText = formatPacketLoss(
    stats.windowPacketLossRate ?? stats.packetLossRate
  )
  // 发送端没有入向流，丢包率一直是 `-`：这时别再挂一条「累计 -」的副标题。
  const lossHint =
    stats.windowPacketLossRate === null && stats.packetLossRate === null
      ? undefined
      : t('本窗口 · 累计 {{value}}', {
          value: formatPacketLoss(stats.packetLossRate),
        })
  const bitrateText = formatBitrate(stats.bitrate)
  const resolutionText = stats.resolution
    ? `${stats.resolution.width} × ${stats.resolution.height}`
    : '-'
  const codecText = stats.codec ?? '-'
  const rttText = stats.rttMs === null ? '-' : `${stats.rttMs} ms`
  const jitterText = stats.jitterMs === null ? '-' : `${stats.jitterMs} ms`
  const jitterBufferText =
    stats.jitterBufferMs === null ? '-' : `${stats.jitterBufferMs} ms`
  const processText = formatMsPerFrame(
    mode === 'sender' ? stats.encodeMsPerFrame : stats.decodeMsPerFrame
  )
  const limitation = dominantLimitation(stats.limitationShare)
  const limitationText = limitation
    ? limitation[0] === 'none'
      ? t('无')
      : `${getLimitationText(limitation[0])} ${Math.round(limitation[1])}%`
    : getLimitationText(stats.qualityLimitationReason)
  const audio = stats.audio
  const audioText =
    audio && audio.level !== null
      ? `${Math.round(audio.level * 100)}%`
      : formatBitrate(audio?.bitrate ?? null)
  const audioHint =
    audio === null
      ? undefined
      : [
          formatBitrate(audio.bitrate),
          audio.packetLossRate === null
            ? null
            : t('丢包 {{value}}', {
                value: formatPacketLoss(audio.packetLossRate),
              }),
          audio.concealmentRate === null
            ? null
            : t('隐藏 {{value}}', {
                value: `${(audio.concealmentRate * 100).toFixed(1)}%`,
              }),
        ]
          .filter(Boolean)
          .join(' · ')
  const freezeText =
    stats.freezeCount === null
      ? '-'
      : stats.totalFreezeMs === null
        ? `${stats.freezeCount} ${t('次')}`
        : `${stats.freezeCount} ${t('次')} / ${(stats.totalFreezeMs / 1000).toFixed(1)} s`
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
        <Tag color="primary">{getSharingModeLabel(sharingMode)}</Tag>
        <Tag color={getConnectionStateColor(stats.connectionState)}>
          {getConnectionStateText(stats.connectionState)}
        </Tag>
        {mode === 'sender' && stats.qualityLimitationReason !== null && (
          <Tag color={getLimitationColor(stats.qualityLimitationReason)}>
            {getLimitationText(stats.qualityLimitationReason)}
          </Tag>
        )}
      </div>

      {!hasEdges && (
        <div className="glass rounded-xl px-3 py-3">
          <Text type="secondary" className="block text-xs">
            {t('还没有连接')}
          </Text>
          <Text
            type="secondary"
            className="mt-1 block text-[10px] leading-tight opacity-70"
          >
            {mode === 'sender'
              ? t('观众接入后这里会显示每条连接的数据')
              : t('正在等待房主的画面')}
          </Text>
        </div>
      )}

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
          hint={lossHint}
          value={lossText}
        />
        <StatRow
          icon={<Radio className="h-3.5 w-3.5" />}
          label={t('实时码率')}
          hint={bitrateHint}
          value={bitrateText}
        />
        <StatRow
          icon={<Timer className="h-3.5 w-3.5" />}
          label={mode === 'sender' ? t('编码耗时') : t('解码耗时')}
          hint={t('每帧平均，越高越吃 CPU')}
          value={processText}
        />
        {audio && (
          <StatRow
            icon={<Volume2 className="h-3.5 w-3.5" />}
            label={t('音频')}
            hint={audioHint || t('无音频数据')}
            value={audioText}
          />
        )}
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
        {mode === 'sender' && (
          <StatRow
            icon={<Boxes className="h-3.5 w-3.5" />}
            label={t('编码器')}
            hint={t('浏览器实际启用的实现')}
            value={stats.encoderImplementation ?? '-'}
          />
        )}
        {mode === 'sender' && (
          <StatRow
            icon={<Gauge className="h-3.5 w-3.5" />}
            label={t('编码受限原因')}
            hint={limitation ? t('本窗口占比') : t('决定该降档位还是降分辨率')}
            value={limitationText}
          />
        )}
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
        {mode === 'receiver' && (
          <StatRow
            icon={<Timer className="h-3.5 w-3.5" />}
            label={t('抖动缓冲')}
            hint={t('帧在缓冲里的平均停留')}
            value={jitterBufferText}
          />
        )}
        {mode === 'receiver' && (
          <StatRow
            icon={<Video className="h-3.5 w-3.5" />}
            label={t('画面冻结')}
            hint={t('累计次数 / 累计时长')}
            value={freezeText}
          />
        )}
      </div>

      {/* 逐条连接的用量。只有一条边时上面的汇总就是它本身，列出来只是重复；
          房主有多位观众时，这里能直接指出「谁的画面差」。 */}
      {edges.length > 1 && (
        <div
          className="flex flex-col gap-2 border-t pt-3"
          style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
        >
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5" />
            <Text type="secondary" className="text-xs">
              {t('观众质量')}
            </Text>
          </div>
          {edges.map((edge, index) => (
            <div
              key={edge.connectionId}
              className="glass flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <Text type="secondary" className="block truncate text-xs">
                  {edge.direction === 'inbound'
                    ? t('上游连接')
                    : t('观众 {{index}}', {
                        // 观众序号只数出边：中继节点自己也有一条入边。
                        index:
                          edges
                            .slice(0, index)
                            .filter((item) => item.direction === 'outbound')
                            .length + 1,
                      })}
                </Text>
                <Text
                  type="secondary"
                  className="block truncate font-mono text-[10px] leading-tight opacity-70"
                >
                  {edgeSummary(edge)}
                </Text>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5">
                {edge.quality ? (
                  <Tag color={peerQualityColor(edge.quality, edge.state)}>
                    {peerQualityText(edge.quality, edge.state)}
                  </Tag>
                ) : (
                  <Tag color={getConnectionStateColor(edge.state)}>
                    {getConnectionStateText(edge.state)}
                  </Tag>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部说明 */}
      <Text
        type="secondary"
        className="mt-auto text-[10px] leading-tight opacity-70"
      >
        {t('每 2 秒采样一次 WebRTC 统计；帧率与码率为该窗口内的平均值。')}
      </Text>
    </div>
  )
}

export default SharingStatusPanel
