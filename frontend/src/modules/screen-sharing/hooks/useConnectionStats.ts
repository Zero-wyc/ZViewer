import { useEffect, useRef, useState } from 'react'

export type ConnectionMode = 'direct' | 'server' | 'unknown'
export type SharingMode = 'server-relay' | 'p2p'

export interface ConnectionStats {
  mode: ConnectionMode
  sharingMode: SharingMode
  connectionState: RTCPeerConnectionState
  resolution: { width: number; height: number } | null
  frameRate: number | null
  bitrate: number | null
  packetsReceived: number | null
  packetsSent: number | null
  packetsLost: number | null
  packetLossRate: number | null
  codec: string | null
  rtt: number | null
  jitter: number | null
}

interface PrevSample {
  bytes: number
  timestamp: number
}

function formatBitrate(bps: number | null): string {
  if (bps === null || bps === 0) return '-'
  if (bps < 1000) return `${bps.toFixed(0)} bps`
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} Kbps`
  return `${(bps / 1_000_000).toFixed(2)} Mbps`
}

function formatNumber(value: number | null): string {
  return value === null ? '-' : value.toLocaleString()
}

function formatPacketLoss(rate: number | null): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(2)}%`
}

/**
 * 将 WebRTC codec.mimeType（如 video/H264、video/VP8）解析为人类可读名称。
 */
function formatCodecName(mimeType: string | undefined | null): string | null {
  if (!mimeType) return null
  const lower = mimeType.toLowerCase()
  const videoPrefix = 'video/'
  if (!lower.startsWith(videoPrefix)) return mimeType
  const name = mimeType.slice(videoPrefix.length).toUpperCase()
  switch (name) {
    case 'H264':
      return 'H.264'
    case 'H265':
      return 'H.265'
    case 'VP8':
    case 'VP9':
    case 'AV1':
      return name
    default:
      return name
  }
}

type BaseStats = Omit<
  ConnectionStats,
  'connectionState' | 'mode' | 'sharingMode'
>

export function useConnectionStats(
  pc: RTCPeerConnection | null,
  mode: ConnectionMode = 'unknown',
  sharingMode: SharingMode = 'server-relay'
) {
  const [baseStats, setBaseStats] = useState<BaseStats>({
    resolution: null,
    frameRate: null,
    bitrate: null,
    packetsReceived: null,
    packetsSent: null,
    packetsLost: null,
    packetLossRate: null,
    codec: null,
    rtt: null,
    jitter: null,
  })

  const prevInboundRef = useRef<PrevSample | null>(null)
  const prevOutboundRef = useRef<PrevSample | null>(null)

  useEffect(() => {
    if (!pc) return

    const timer = setInterval(() => {
      pc.getStats().then((report) => {
        let inbound: RTCInboundRtpStreamStats | null = null
        let outbound: RTCOutboundRtpStreamStats | null = null
        let activeCandidatePair: RTCIceCandidatePairStats | null = null

        // 当前 TS DOM 库未声明 RTCCodecStats，这里用最小结构替代
        type CodecStat = { id: string; mimeType?: string }
        const codecMap = new Map<string, CodecStat>()
        report.forEach((value) => {
          if (value.type === 'codec') {
            codecMap.set(value.id, value as unknown as CodecStat)
          }
        })

        report.forEach((value) => {
          if (value.type === 'inbound-rtp' && value.kind === 'video') {
            inbound = value as RTCInboundRtpStreamStats
          } else if (value.type === 'outbound-rtp' && value.kind === 'video') {
            outbound = value as RTCOutboundRtpStreamStats
          } else if (value.type === 'candidate-pair') {
            const pair = value as RTCIceCandidatePairStats
            // 优先选择已提名或处于成功状态的候选对，其 RTT 才是当前活跃路径的真实值
            if (pair.nominated || pair.state === 'succeeded') {
              if (
                !activeCandidatePair ||
                (pair.nominated && !activeCandidatePair.nominated)
              ) {
                activeCandidatePair = pair
              }
            }
          }
        })

        const next: BaseStats = {
          resolution: null,
          frameRate: null,
          bitrate: null,
          packetsReceived: null,
          packetsSent: null,
          packetsLost: null,
          packetLossRate: null,
          codec: null,
          rtt: null,
          jitter: null,
        }

        if (inbound) {
          next.resolution =
            inbound.frameWidth && inbound.frameHeight
              ? { width: inbound.frameWidth, height: inbound.frameHeight }
              : null
          next.frameRate = inbound.framesPerSecond ?? null
          next.packetsReceived = inbound.packetsReceived ?? null
          next.packetsLost = inbound.packetsLost ?? null

          if (
            inbound.packetsReceived !== undefined &&
            inbound.packetsLost !== undefined &&
            inbound.packetsReceived + inbound.packetsLost > 0
          ) {
            next.packetLossRate =
              inbound.packetsLost /
              (inbound.packetsReceived + inbound.packetsLost)
          }

          // jitter 在 WebRTC 统计中以秒为单位，转换为毫秒展示
          if (typeof inbound.jitter === 'number') {
            next.jitter = Math.round(inbound.jitter * 1000)
          }

          // 通过 codecId 查找对应的 codec 报告
          if (inbound.codecId) {
            const codecStats = codecMap.get(inbound.codecId)
            next.codec = formatCodecName(codecStats?.mimeType)
          }

          const bytes = inbound.bytesReceived ?? 0
          const timestamp = inbound.timestamp ?? performance.now()
          const prev = prevInboundRef.current
          if (prev && timestamp > prev.timestamp) {
            const deltaBytes = Math.max(0, bytes - prev.bytes)
            const deltaMs = timestamp - prev.timestamp
            next.bitrate = (deltaBytes * 8 * 1000) / deltaMs
          }
          prevInboundRef.current = { bytes, timestamp }
        } else if (outbound) {
          next.resolution =
            outbound.frameWidth && outbound.frameHeight
              ? { width: outbound.frameWidth, height: outbound.frameHeight }
              : null
          next.frameRate = outbound.framesPerSecond ?? null
          next.packetsSent = outbound.packetsSent ?? null

          if (outbound.codecId) {
            const codecStats = codecMap.get(outbound.codecId)
            next.codec = formatCodecName(codecStats?.mimeType)
          }

          const bytes = outbound.bytesSent ?? 0
          const timestamp = outbound.timestamp ?? performance.now()
          const prev = prevOutboundRef.current
          if (prev && timestamp > prev.timestamp) {
            const deltaBytes = Math.max(0, bytes - prev.bytes)
            const deltaMs = timestamp - prev.timestamp
            next.bitrate = (deltaBytes * 8 * 1000) / deltaMs
          }
          prevOutboundRef.current = { bytes, timestamp }
        }

        if (activeCandidatePair) {
          // currentRoundTripTime 以秒为单位，转换为毫秒
          const rtt = activeCandidatePair.currentRoundTripTime
          if (typeof rtt === 'number' && rtt >= 0) {
            next.rtt = Math.round(rtt * 1000)
          }
        }

        setBaseStats(next)
      })
    }, 1000)

    return () => {
      clearInterval(timer)
      prevInboundRef.current = null
      prevOutboundRef.current = null
    }
  }, [pc])

  const stats: ConnectionStats = {
    ...baseStats,
    mode,
    sharingMode,
    connectionState: pc?.connectionState ?? 'new',
  }

  return { stats, formatBitrate, formatNumber, formatPacketLoss }
}
