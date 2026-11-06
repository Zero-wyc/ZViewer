/**
 * RemoteVideoPlayer —— WebRTC 远程流播放组件（ArtPlayer 版）。
 *
 * 基于 LiveArtPlayer（ArtPlayer isLive 模式）：
 * - art.video 通过 setVideoRef 暴露给父组件绑定 srcObject（契约不变）
 * - 控制栏（播放/音量/全屏）由 ArtPlayer 提供
 * - 右键视频统计（VideoStatsMenu）保留
 */
import { useCallback, useState } from 'react'
import type { RefObject } from 'react'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import type { ShareEdgeStats } from '../core/edge-stats'
import { Spinner } from '@/components/ui/Spinner'
import { LiveArtPlayer } from '@/modules/art-player'
import { t } from '@/i18n'

interface RemoteVideoPlayerProps {
  /** video 元素 ref（由调用方通过 useRef 创建并传入） */
  videoRef: RefObject<HTMLVideoElement | null>
  /** 设置 video 元素 ref 的回调（来自调用方的 setVideoRef） */
  setVideoRef: (node: HTMLVideoElement | null) => void
  /** 初始静音（托管模式下只在元素挂载时应用一次） */
  isMuted: boolean
  /** 静音与音量由 ViewerAudio 托管，播放器不再改写 video.muted。 */
  managedMuted?: boolean
  /** 是否已收到远端视频流 */
  hasRemoteStream: boolean
  /** 每条共享连接的用量（Piik 链路没有唯一一条 PC） */
  edges: ShareEdgeStats[]
  /** 没有画面时占位区显示的状态文案 */
  statusTip?: string
}

export function RemoteVideoPlayer({
  setVideoRef,
  isMuted,
  managedMuted = false,
  hasRemoteStream,
  edges,
  statusTip,
}: RemoteVideoPlayerProps): JSX.Element {
  // 用 state 跟踪 video 元素，避免在 render 中读取 ref.current
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const handleVideoReady = useCallback(
    (node: HTMLVideoElement | null) => {
      setVideoEl(node)
      setVideoRef(node)
    },
    [setVideoRef]
  )

  return (
    <div className="relative h-full w-full">
      <LiveArtPlayer
        muted={isMuted}
        managedMuted={managedMuted}
        onVideoReady={handleVideoReady}
      />
      <VideoStatsMenu
        videoElement={videoEl}
        edges={edges}
        sourceType="webrtc"
      />
      {!hasRemoteStream && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/80">
          <Spinner tip={statusTip ?? t('正在接收画面...')} size={32} />
        </div>
      )}
    </div>
  )
}
