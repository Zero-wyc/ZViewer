import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, Copy, Terminal, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Tag } from '@/components/ui/Tag'
import { message } from '@/components/ui/message'
import { useConnectionStats } from '@/hooks/useConnectionStats'

export interface VideoStatsMenuProps {
  videoElement: HTMLVideoElement | null
  pc?: RTCPeerConnection | null
  sourceType: 'bilibili' | 'custom' | 'webrtc'
}

interface Position {
  x: number
  y: number
}

interface VideoStats {
  codec: string
  resolution: string
  frameRate: string
  bitrate: string
  packetLossRate: string
  rtt: string
  jitter: string
  bufferHealth: string
  url: string
  sourceLabel: string
}

const SOURCE_LABELS: Record<VideoStatsMenuProps['sourceType'], string> = {
  bilibili: 'B 站',
  custom: '自定义源',
  webrtc: 'WebRTC 屏幕共享',
}

const LOADING_STATS: VideoStats = {
  codec: '加载中…',
  resolution: '-',
  frameRate: '-',
  bitrate: '-',
  packetLossRate: '-',
  rtt: '-',
  jitter: '-',
  bufferHealth: '-',
  url: '',
  sourceLabel: '',
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(1)} ms`
}

function formatSeconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(2)} s`
}

function getBufferedEnd(video: HTMLVideoElement): number {
  if (video.buffered.length === 0) return 0
  return video.buffered.end(video.buffered.length - 1)
}

// 尝试从 videoTracks[0].codec 读取编码（非标准 API，部分浏览器可用）
function getVideoCodec(video: HTMLVideoElement): string {
  try {
    const withTracks = video as HTMLVideoElement & {
      videoTracks?: { length: number; [index: number]: { codec?: string } }
    }
    const tracks = withTracks.videoTracks
    if (tracks && tracks.length > 0 && tracks[0].codec) {
      return tracks[0].codec as string
    }
  } catch {
    // ignore
  }
  return 'unknown'
}

interface WebRtcExtras {
  codec: string
  jitter: number | null // ms
  rtt: number | null // ms
}

// 统一描述需要访问的 RTC stats 字段（兼容不同 TS lib 版本）
type RtcStatsLike = RTCStats & {
  kind?: string
  codecId?: string
  jitter?: number
  roundTripTime?: number
  mimeType?: string
}

// 单独读取 useConnectionStats 未暴露的 codec / jitter / rtt
async function readWebRtcExtras(
  pc: RTCPeerConnection | null
): Promise<WebRtcExtras | null> {
  if (!pc) return null
  let report: RTCStatsReport
  try {
    report = await pc.getStats()
  } catch {
    return null
  }

  let inboundCodecId: string | undefined
  let inboundJitter: number | undefined
  let remoteRtt: number | undefined
  let remoteJitter: number | undefined
  let hasInbound = false
  const codecMimes = new Map<string, string>()

  report.forEach((value) => {
    const v = value as RtcStatsLike
    if (v.type === 'inbound-rtp' && v.kind === 'video') {
      hasInbound = true
      inboundCodecId = v.codecId
      inboundJitter = v.jitter
    } else if (v.type === 'remote-inbound-rtp' && v.kind === 'video') {
      remoteRtt = v.roundTripTime
      remoteJitter = v.jitter
    } else if (v.type === 'codec') {
      if (v.mimeType) {
        codecMimes.set(v.id, v.mimeType)
      }
    }
  })

  if (!hasInbound) return null

  let codec = 'unknown'
  if (inboundCodecId && codecMimes.has(inboundCodecId)) {
    const mime = codecMimes.get(inboundCodecId)
    if (mime) {
      codec = mime.replace(/^video\//, '')
    }
  }

  const jitterSec = inboundJitter ?? remoteJitter ?? null
  const rttSec = remoteRtt ?? null

  return {
    codec,
    jitter: jitterSec != null ? jitterSec * 1000 : null,
    rtt: rttSec != null ? rttSec * 1000 : null,
  }
}

export function VideoStatsMenu({
  videoElement,
  pc,
  sourceType,
}: VideoStatsMenuProps) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 })
  const [stats, setStats] = useState<VideoStats | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const isWebRtc = sourceType === 'webrtc'

  // 复用现有 useConnectionStats，仅在 WebRTC 时启用
  const {
    stats: connStats,
    formatBitrate,
    formatPacketLoss,
  } = useConnectionStats(isWebRtc ? (pc ?? null) : null, 'server')

  // MSE 帧率采样
  const mseFramesRef = useRef<{ frames: number; time: number } | null>(null)
  // MSE 码率采样（按 bufferedEnd 增量 × 8 估算）
  const mseBufferedRef = useRef<{ end: number; time: number } | null>(null)

  const computeStats = useCallback(async (): Promise<VideoStats | null> => {
    const video = videoElement
    if (!video) return null

    const url = video.currentSrc || video.src || ''

    if (isWebRtc) {
      const extras = await readWebRtcExtras(pc ?? null)

      let width = connStats.resolution?.width ?? 0
      let height = connStats.resolution?.height ?? 0
      if ((!width || !height) && video.videoWidth && video.videoHeight) {
        width = video.videoWidth
        height = video.videoHeight
      }

      const bufferedEnd = getBufferedEnd(video)
      const bufferHealth =
        bufferedEnd > 0 ? bufferedEnd - video.currentTime : null

      return {
        codec: extras?.codec ?? 'unknown',
        resolution: width && height ? `${width} × ${height}` : '-',
        frameRate:
          connStats.frameRate != null
            ? `${connStats.frameRate.toFixed(1)} fps`
            : '-',
        bitrate: formatBitrate(connStats.bitrate),
        packetLossRate: formatPacketLoss(connStats.packetLossRate),
        rtt: formatMs(extras?.rtt ?? null),
        jitter: formatMs(extras?.jitter ?? null),
        bufferHealth:
          bufferHealth != null ? formatSeconds(bufferHealth) : '直播流无缓冲',
        url,
        sourceLabel: SOURCE_LABELS[sourceType],
      }
    }

    // MSE (bilibili / custom)
    const codec = getVideoCodec(video)
    const width = video.videoWidth
    const height = video.videoHeight

    // 帧率：通过 getVideoPlaybackQuality 的 totalVideoFrames 采样
    let frameRateStr = '-'
    const quality = video.getVideoPlaybackQuality?.()
    if (quality) {
      const now = performance.now()
      const prev = mseFramesRef.current
      if (prev) {
        const dt = (now - prev.time) / 1000
        if (dt > 0) {
          const fps = (quality.totalVideoFrames - prev.frames) / dt
          if (Number.isFinite(fps) && fps >= 0) {
            frameRateStr = `${fps.toFixed(1)} fps`
          }
        }
      }
      mseFramesRef.current = {
        frames: quality.totalVideoFrames,
        time: now,
      }
    }

    // 码率：按 bufferedEnd 增量 × 8 估算（任务规范）
    let bitrateStr = '-'
    const bufferedEnd = getBufferedEnd(video)
    const now = performance.now()
    const prevBuf = mseBufferedRef.current
    if (prevBuf) {
      const dt = (now - prevBuf.time) / 1000
      if (dt > 0) {
        const delta = bufferedEnd - prevBuf.end
        if (delta > 0) {
          const kbps = (delta * 8) / dt / 1000
          if (Number.isFinite(kbps) && kbps > 0) {
            bitrateStr = `${kbps.toFixed(1)} kbps`
          }
        }
      }
    }
    mseBufferedRef.current = { end: bufferedEnd, time: now }

    const bufferHealth = bufferedEnd > 0 ? bufferedEnd - video.currentTime : 0

    return {
      codec,
      resolution: width && height ? `${width} × ${height}` : '-',
      frameRate: frameRateStr,
      bitrate: bitrateStr,
      packetLossRate: '-',
      rtt: '-',
      jitter: '-',
      bufferHealth: bufferHealth > 0 ? formatSeconds(bufferHealth) : '0 s',
      url,
      sourceLabel: SOURCE_LABELS[sourceType],
    }
  }, [
    videoElement,
    pc,
    isWebRtc,
    sourceType,
    connStats,
    formatBitrate,
    formatPacketLoss,
  ])

  // 始终持有最新 computeStats 引用，避免频繁重建监听器
  const computeStatsRef = useRef(computeStats)
  useEffect(() => {
    computeStatsRef.current = computeStats
  }, [computeStats])

  // 监听 video 元素的 contextmenu，阻止默认菜单并在点击位置弹出
  useEffect(() => {
    const video = videoElement
    if (!video) return

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      // 同步展示初始 stats（MSE 路径同步返回；WebRTC 等异步完成后再刷新）
      const initial = computeStatsRef.current()
      void initial.then((s) => {
        if (s) setStats(s)
      })
      setPosition({ x: e.clientX, y: e.clientY })
      setOpen(true)
    }

    video.addEventListener('contextmenu', handleContextMenu)
    return () => {
      video.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [videoElement])

  // 菜单打开时每秒轮询刷新统计
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => {
      void computeStatsRef.current().then((s) => {
        if (s) setStats(s)
      })
    }, 1000)
    return () => clearInterval(timer)
  }, [open])

  // ESC 关闭
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  // 点击菜单外部关闭
  useEffect(() => {
    if (!open) return
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  // video 元素失效时关闭
  useEffect(() => {
    if (!videoElement) {
      setOpen(false)
      setStats(null)
    }
  }, [videoElement])

  const handleCopy = useCallback(async () => {
    if (!stats) return
    const lines: string[] = [
      '视频统计信息',
      `来源: ${stats.sourceLabel}`,
      `URL: ${stats.url || '-'}`,
      `编码: ${stats.codec}`,
      `分辨率: ${stats.resolution}`,
      `帧率: ${stats.frameRate}`,
      `码率: ${stats.bitrate}`,
    ]
    if (isWebRtc) {
      lines.push(`丢包率: ${stats.packetLossRate}`)
      lines.push(`RTT: ${stats.rtt}`)
      lines.push(`抖动: ${stats.jitter}`)
    }
    lines.push(`缓冲健康度: ${stats.bufferHealth}`)
    try {
      await navigator.clipboard.writeText(lines.join('\n'))
      message.success('统计信息已复制到剪贴板')
    } catch (err) {
      console.error('[VideoStatsMenu] copy error:', err)
      message.error('复制失败，请检查浏览器剪贴板权限')
    }
  }, [stats, isWebRtc])

  const handleOpenDevPanel = useCallback(() => {
    if (!videoElement) return
    const detail = {
      sourceType,
      url: videoElement.currentSrc || videoElement.src,
      videoWidth: videoElement.videoWidth,
      videoHeight: videoElement.videoHeight,
      duration: videoElement.duration,
      currentTime: videoElement.currentTime,
      readyState: videoElement.readyState,
      networkState: videoElement.networkState,
      buffered: Array.from(
        { length: videoElement.buffered.length },
        (_, i) => ({
          start: videoElement.buffered.start(i),
          end: videoElement.buffered.end(i),
        })
      ),
      playbackQuality: videoElement.getVideoPlaybackQuality?.() ?? null,
      webkitVideoDecodedByteCount: (
        videoElement as HTMLVideoElement & {
          webkitVideoDecodedByteCount?: number
        }
      ).webkitVideoDecodedByteCount,
      webkitAudioDecodedByteCount: (
        videoElement as HTMLVideoElement & {
          webkitAudioDecodedByteCount?: number
        }
      ).webkitAudioDecodedByteCount,
      pc: pc
        ? {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState,
          }
        : null,
      currentStats: stats,
    }
    console.log('[VideoStatsMenu] Developer stats:', detail)
    if (isWebRtc) {
      message.info(
        '已输出详细统计到控制台；如需更深入分析可访问 chrome://webrtc-internals/'
      )
    } else {
      message.info('已输出详细统计到浏览器开发者控制台')
    }
  }, [videoElement, pc, sourceType, isWebRtc, stats])

  if (!videoElement || !open) return null

  const displayStats: VideoStats = stats ?? {
    ...LOADING_STATS,
    sourceLabel: SOURCE_LABELS[sourceType],
  }

  // 防止菜单超出视口
  const menuWidth = 280
  const estimatedHeight = 400
  const clampedX = Math.min(
    Math.max(8, position.x),
    Math.max(8, window.innerWidth - menuWidth - 8)
  )
  const clampedY = Math.min(
    Math.max(8, position.y),
    Math.max(8, window.innerHeight - estimatedHeight - 8)
  )

  return createPortal(
    <div
      ref={menuRef}
      className="glass-strong fixed z-[60] w-[280px] rounded-[var(--md-sys-shape-corner)] p-3"
      style={{
        left: `${clampedX}px`,
        top: `${clampedY}px`,
        boxShadow: '0 12px 32px -8px rgba(0, 0, 0, 0.4)',
      }}
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Activity
            className="h-3.5 w-3.5"
            style={{ color: 'var(--md-sys-color-primary)' }}
          />
          <span
            className="text-xs font-semibold"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            视频统计信息
          </span>
        </div>
        <button
          onClick={() => setOpen(false)}
          className="rounded p-0.5 hover:bg-[var(--md-sys-color-surface-container-high)]"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-2">
        <Tag color="primary">{displayStats.sourceLabel}</Tag>
      </div>

      <div className="flex flex-col gap-1.5 text-xs">
        <StatsRow label="编码" value={displayStats.codec} />
        <StatsRow label="分辨率" value={displayStats.resolution} />
        <StatsRow label="帧率" value={displayStats.frameRate} />
        <StatsRow label="码率" value={displayStats.bitrate} />
        {isWebRtc && (
          <>
            <StatsRow label="丢包率" value={displayStats.packetLossRate} />
            <StatsRow label="RTT" value={displayStats.rtt} />
            <StatsRow label="抖动" value={displayStats.jitter} />
          </>
        )}
        <StatsRow label="缓冲健康度" value={displayStats.bufferHealth} />
        <div
          className="mt-1 border-t pt-1.5"
          style={{ borderColor: 'var(--md-sys-color-outline)' }}
        >
          <div
            className="mb-1 text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          >
            播放地址
          </div>
          <div
            className="break-all font-mono text-[10px] leading-relaxed"
            style={{
              color: 'var(--md-sys-color-on-surface-variant)',
              maxHeight: '40px',
              overflow: 'hidden',
            }}
          >
            {displayStats.url || '-'}
          </div>
        </div>
      </div>

      <div className="mt-3 flex gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1 text-[11px]"
          icon={<Copy className="h-3 w-3" />}
          onClick={handleCopy}
        >
          复制统计信息
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="flex-1 text-[11px]"
          icon={<Terminal className="h-3 w-3" />}
          onClick={handleOpenDevPanel}
        >
          开发者统计
        </Button>
      </div>
    </div>,
    document.body
  )
}

interface StatsRowProps {
  label: string
  value: string
}

function StatsRow({ label, value }: StatsRowProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span style={{ color: 'var(--md-sys-color-on-surface-variant)' }}>
        {label}
      </span>
      <span
        className="font-mono tabular-nums"
        style={{ color: 'var(--md-sys-color-on-surface)' }}
      >
        {value}
      </span>
    </div>
  )
}
