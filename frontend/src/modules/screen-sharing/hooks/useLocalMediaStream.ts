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
  /** 是否正在启动共享（等待 getDisplayMedia 授权弹窗） */
  starting: boolean
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
  const [starting, setStarting] = useState(false)
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
    // 防重复点击：正在启动或正在共享时直接返回
    if (starting || isSharing) return

    // 前置检查 1：getDisplayMedia 仅在安全上下文（HTTPS 或 localhost）可用
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      const isLocalhost =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
      let reason: string
      if (window.isSecureContext || isLocalhost) {
        reason =
          '当前浏览器不支持屏幕共享 API，请使用最新版 Chrome / Edge / Firefox'
      } else {
        reason =
          `屏幕共享 (getDisplayMedia) 需要安全上下文（HTTPS 或 localhost），当前页面为 HTTP 来源，浏览器已禁用该 API。\n\n` +
          `解决方案（任选其一）：\n` +
          `1. 【推荐】将站点部署为 HTTPS：可使用 Let's Encrypt 申请免费证书，或通过 Nginx/Caddy 反向代理终止 TLS。\n` +
          `2. 【临时方案】在 Chrome/Edge 地址栏访问 chrome://flags/#unsafely-treat-insecure-origin-as-secure，` +
          `在输入框添加 ${window.location.origin} 并点击启用，然后完全重启浏览器。\n` +
          `3. 【本地代理】在本地通过 SSH 隧道将远程服务映射到 localhost，再通过 https://localhost 访问。`
      }
      setError(reason)
      message.error('屏幕共享不可用：当前为非安全上下文')
      return
    }

    // 前置检查 2：iframe 嵌套环境检测
    // getDisplayMedia 在 iframe 中需要父页面通过 allow="display-capture" 授权，
    // 否则调用时会抛 NotSupportedError。IDE 内置预览（如 trae-preview）即属于此类场景。
    const inIframe = (() => {
      try {
        return window.self !== window.top
      } catch {
        // 跨域 iframe 访问 window.top 会抛错，视为 iframe 环境
        return true
      }
    })()
    if (inIframe) {
      // document.featurePolicy 在标准 TS 类型中不存在，使用类型断言
      const docWithPolicy = document as Document & {
        featurePolicy?: { allowedFeatures(): string[] }
      }
      const allowed =
        typeof docWithPolicy.featurePolicy !== 'undefined' &&
        docWithPolicy.featurePolicy
          .allowedFeatures()
          .includes('display-capture')
      if (!allowed) {
        const reason =
          `当前页面运行在 iframe 嵌套环境中，浏览器禁止调用屏幕共享 API（需要父页面通过 allow="display-capture" 授权）。\n\n` +
          `常见场景：IDE 内置预览、嵌入式开发服务器预览页等。\n\n` +
          `解决方案：\n` +
          `1. 【推荐】点击「在新窗口打开」按钮，或在浏览器中直接访问 ${window.location.origin}\n` +
          `2. 复制下方链接到外部浏览器（Chrome / Edge）地址栏打开：\n` +
          `   ${window.location.href}`
        setError(reason)
        message.error('屏幕共享不可用：iframe 环境未获授权')
        return
      }
    }

    setError(null)
    setStarting(true)
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
      // 区分错误类型给出明确提示
      const errName = (err as { name?: string })?.name
      let reason = '无法获取屏幕共享权限'
      if (errName === 'NotAllowedError') {
        reason = '已取消屏幕共享授权，或浏览器未授予屏幕共享权限'
      } else if (errName === 'NotFoundError') {
        reason = '未找到可用的屏幕共享源'
      } else if (errName === 'NotReadableError') {
        reason = '屏幕共享源被其他程序占用，无法捕获'
      } else if (errName === 'OverconstrainedError') {
        reason = '请求的约束条件无法满足，请降低帧率或分辨率后重试'
      } else if (errName === 'TypeError') {
        reason = '请求参数错误，请检查媒体设置'
      } else if (errName === 'NotSupportedError') {
        // 兜底：iframe 未授权 / 浏览器不支持 / 系统未启用屏幕捕获
        const inIframe = (() => {
          try {
            return window.self !== window.top
          } catch {
            return true
          }
        })()
        reason = inIframe
          ? `当前 iframe 环境未授权屏幕共享，请在独立浏览器窗口中打开本页面：\n${window.location.href}`
          : '当前浏览器或系统不支持屏幕共享，请使用最新版 Chrome / Edge 并确认系统已启用屏幕捕获权限'
      }
      setError(reason)
      message.error(reason)
    } finally {
      setStarting(false)
    }
  }, [frameRate, shareSystemAudio, shareMicrophone, starting, isSharing])

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
    starting,
    isPaused,
    error,
    start,
    stop,
    pause,
    resume,
  }
}
