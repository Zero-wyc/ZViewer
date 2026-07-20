import { useCallback, useState } from 'react'
import type { RefObject } from 'react'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import { Spinner } from '@/components/ui/Spinner'

interface RemoteVideoPlayerProps {
  /** video 元素 ref（由调用方通过 useRef 创建并传入） */
  videoRef: RefObject<HTMLVideoElement | null>
  /** 设置 video 元素 ref 的回调（来自调用方的 setVideoRef） */
  setVideoRef: (node: HTMLVideoElement | null) => void
  /** 是否静音 */
  isMuted: boolean
  /** 是否已收到远端视频流 */
  hasRemoteStream: boolean
  /** PeerConnection（用于 VideoStatsMenu） */
  peerConnection: RTCPeerConnection | null
}

export function RemoteVideoPlayer({
  setVideoRef,
  isMuted,
  hasRemoteStream,
  peerConnection,
}: RemoteVideoPlayerProps): JSX.Element {
  // 用 state 跟踪 video 元素，避免在 render 中读取 ref.current
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null)
  const handleRef = useCallback(
    (node: HTMLVideoElement | null) => {
      setVideoEl(node)
      setVideoRef(node)
    },
    [setVideoRef]
  )

  return (
    <div className="relative h-full w-full">
      <video
        ref={handleRef}
        autoPlay
        playsInline
        muted={isMuted}
        className="h-full w-full object-contain"
      />
      <VideoStatsMenu
        videoElement={videoEl}
        pc={peerConnection}
        sourceType="webrtc"
      />
      {!hasRemoteStream && (
        <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/80">
          <Spinner tip="正在接收画面..." size={32} />
        </div>
      )}
    </div>
  )
}
