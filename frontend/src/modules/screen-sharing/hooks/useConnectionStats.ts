import { useEffect, useRef, useState } from 'react'
import {
  emptyBaseline,
  emptyShareStats,
  sampleShareStats,
  type ShareStats,
  type StatsBaseline,
} from '../core/stats'

export type ConnectionMode = 'direct' | 'server' | 'unknown'
/** 媒体走向：direct = 浏览器直连（服务端只转发信令），relay = 经服务端 SFU 转发。 */
export type SharingMode = 'direct' | 'relay'

/** 采样周期。2 秒和 `chrome://webrtc-internals` 的默认窗口接近，便于对照。 */
export const STATS_SAMPLE_INTERVAL_MS = 2000

export type ConnectionStats = ShareStats & {
  mode: ConnectionMode
  sharingMode: SharingMode
  connectionState: RTCPeerConnectionState
}

export function formatBitrate(bps: number | null): string {
  if (bps === null || bps === 0) return '-'
  if (bps < 1000) return `${bps.toFixed(0)} bps`
  if (bps < 1_000_000) return `${(bps / 1000).toFixed(1)} Kbps`
  return `${(bps / 1_000_000).toFixed(2)} Mbps`
}

export function formatNumber(value: number | null): string {
  return value === null ? '-' : value.toLocaleString()
}

export function formatPacketLoss(rate: number | null): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(2)}%`
}

/**
 * 按固定周期采样 WebRTC 统计。
 *
 * 采样与计算都在 `core/stats` 里（纯函数，可单测）；这个 hook 只负责定时器
 * 与基线存取。基线必须跟着 PC 一起重置：换 PC 后计数器从 0 开始，拿旧基线
 * 做差会得出负数速率。
 */
export function useConnectionStats(
  pc: RTCPeerConnection | null,
  mode: ConnectionMode = 'unknown',
  sharingMode: SharingMode = 'direct'
) {
  const [stats, setStats] = useState<ShareStats>(emptyShareStats)
  const baselineRef = useRef<StatsBaseline>(emptyBaseline())

  useEffect(() => {
    if (!pc) return
    baselineRef.current = emptyBaseline()

    let cancelled = false
    const timer = window.setInterval(() => {
      pc.getStats()
        .then((report) => {
          if (cancelled) return
          const sample = sampleShareStats(baselineRef.current, report)
          // 第一次采样只建立基线：速率必然是 null，但状态字段已经可用。
          baselineRef.current = sample.baseline
          setStats(sample.stats)
        })
        .catch(() => {
          // 连接正在关闭时 getStats 会抛；保留上一次的值，别把面板清成一片横线。
        })
    }, STATS_SAMPLE_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(timer)
      baselineRef.current = emptyBaseline()
    }
  }, [pc])

  return {
    stats: {
      ...stats,
      mode,
      sharingMode,
      connectionState: pc?.connectionState ?? ('new' as const),
    } satisfies ConnectionStats,
    formatBitrate,
    formatNumber,
    formatPacketLoss,
  }
}
