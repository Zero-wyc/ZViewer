import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { message } from '@/components/ui/message'

export interface UseLocalMediaStreamOptions {
  frameRate: number
  maxBitrateMbps: number
  shareSystemAudio: boolean
  shareMicrophone: boolean
  /** 视频 track ended 时的回调（用于触发 close-room 等业务逻辑） */
  onStreamEnded?: () => void
  /** 本地预览 video 元素 ref（可选，用于自动绑定 srcObject） */
  localVideoRef?: RefObject<HTMLVideoElement | null>
}

export interface UseLocalMediaStreamResult {
  /** 当前本地 MediaStream（响应式，可在 useEffect 中依赖） */
  stream: MediaStream | null
  /** 麦克风 MediaStream（独立管理，未合并到 stream，传给 useHostPeerConnections） */
  micStream: MediaStream | null
  /** 是否正在共享 */
  isSharing: boolean
  /** 是否暂停（视频 track.enabled = false） */
  isPaused: boolean
  /** 错误信息 */
  error: string | null
  /** 开始共享：调用 getDisplayMedia + 合并麦克风 + applyConstraints */
  start: () => Promise<void>
  /** 停止共享：停止所有 track、清理 micStream、清空 video.srcObject */
  stop: () => void
  /** 暂停：设置视频 track.enabled = false */
  pause: () => void
  /** 恢复：设置视频 track.enabled = true */
  resume: () => void
}

export function useLocalMediaStream(
  options: UseLocalMediaStreamOptions
): UseLocalMediaStreamResult {
  const {
    frameRate,
    shareSystemAudio,
    shareMicrophone,
    onStreamEnded,
    localVideoRef,
  } = options

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const localStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)

  // 用 ref 持有最新的 onStreamEnded，避免 start 函数依赖变化导致重建
  const onStreamEndedRef = useRef(onStreamEnded)
  useEffect(() => {
    onStreamEndedRef.current = onStreamEnded
  }, [onStreamEnded])

  const stop = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
    setMicStream(null)
    if (localVideoRef?.current) {
      localVideoRef.current.srcObject = null
    }
    setStream(null)
    setIsSharing(false)
    setIsPaused(false)
  }, [localVideoRef])

  const start = useCallback(async () => {
    setError(null)
    try {
      const useTestStream =
        new URLSearchParams(window.location.search).get('testStream') === 'true'

      let mediaStream: MediaStream
      if (useTestStream) {
        message.info('测试模式：使用摄像头画面代替屏幕共享')
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            frameRate: { ideal: frameRate, max: frameRate },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: shareSystemAudio,
        })
      } else {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            // 优先保持目标帧率；部分浏览器/显卡可能仍限制为 30/60，获取后再 applyConstraints 尽量逼近
            frameRate: { ideal: frameRate, max: frameRate },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: shareSystemAudio,
        })
      }

      if (shareMicrophone) {
        try {
          const nextMicStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          })
          micStreamRef.current = nextMicStream
          setMicStream(nextMicStream)
        } catch (err) {
          console.error('[useLocalMediaStream] getUserMedia mic error:', err)
          message.warning('无法获取麦克风权限，将仅共享屏幕')
        }
      }

      localStreamRef.current = mediaStream
      setStream(mediaStream)
      setIsSharing(true)
      setIsPaused(false)

      // 尝试将视频轨道设为运动/高帧率模式，并应用目标帧率
      mediaStream.getVideoTracks().forEach((track) => {
        track.contentHint = 'motion'
        try {
          void track.applyConstraints({
            frameRate: { ideal: frameRate, max: frameRate },
          })
        } catch (err) {
          console.warn(
            '[useLocalMediaStream] applyConstraints frameRate error:',
            err
          )
        }
      })

      mediaStream.getVideoTracks().forEach((track) => {
        console.log(
          '[useLocalMediaStream] video track:',
          track.label,
          'enabled:',
          track.enabled,
          'muted:',
          track.muted
        )
        track.addEventListener('unmute', () => {
          console.log('[useLocalMediaStream] video track unmuted')
        })
        track.addEventListener('mute', () => {
          console.warn('[useLocalMediaStream] video track muted')
        })
      })

      // 视频 track 结束时（如用户通过浏览器 UI 停止共享）触发回调
      mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        onStreamEndedRef.current?.()
      })
    } catch (err) {
      console.error('[useLocalMediaStream] getDisplayMedia error:', err)
      setError('无法获取屏幕共享权限')
    }
  }, [frameRate, shareSystemAudio, shareMicrophone])

  const pause = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = false
    })
    setIsPaused(true)
  }, [])

  const resume = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = true
    })
    setIsPaused(false)
  }, [])

  // 自动绑定 video.srcObject，stream 变化时同步预览
  useEffect(() => {
    const video = localVideoRef?.current
    if (!video) return
    // eslint-disable-next-line react-hooks/immutability -- 修改 DOM 元素属性，非 React 状态
    video.srcObject = stream
    if (stream) {
      void video.play().catch((err) => {
        console.warn('[useLocalMediaStream] video play error:', err)
      })
    }
    return () => {
      video.srcObject = null
    }
  }, [stream, localVideoRef])

  // 组件卸载时自动清理
  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return {
    stream,
    micStream,
    isSharing,
    isPaused,
    error,
    start,
    stop,
    pause,
    resume,
  }
}
