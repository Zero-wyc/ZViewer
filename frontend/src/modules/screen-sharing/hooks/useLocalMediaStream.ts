import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { message } from '@/components/ui/message'
import type { ResolutionPreset } from '../constants'
import { RESOLUTION_DIMENSIONS } from '../constants'
import { t as translate } from '@/i18n'

/**
 * 按档位构造视频约束：帧率只给 ideal（Chromium 对 max 的严格匹配会把
 * 桌面采集钳回 30fps），宽高按档位 ideal 下发（native 不下发，跟随本机）。
 */
function buildVideoConstraints(
  frameRate: number,
  preset: ResolutionPreset
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    frameRate: { ideal: frameRate },
  }
  const dims = RESOLUTION_DIMENSIONS[preset]
  if (dims) {
    constraints.width = { ideal: dims.width }
    constraints.height = { ideal: dims.height }
  }
  return constraints
}

export interface UseLocalMediaStreamOptions {
  frameRate: number
  maxBitrateMbps: number
  shareSystemAudio: boolean
  shareMicrophone: boolean
  /** 分辨率档位（start 时下发采集约束；共享中切换走 switchResolution） */
  resolutionPreset: ResolutionPreset
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
  /** 是否正在热切换分辨率（重新采集中） */
  switchingResolution: boolean
  /** 错误信息 */
  error: string | null
  /**
   * 开始共享：调用 getDisplayMedia + 合并麦克风 + applyConstraints。
   * 返回是否成功启动（失败/取消返回 false，供调用方做一致性广播等处理；
   * 正在启动或已在共享中的重复调用视为成功，不触发失败逻辑）。
   */
  start: () => Promise<boolean>
  /** 停止共享：停止所有 track、清理 micStream、清空 video.srcObject */
  stop: () => void
  /** 暂停：设置视频 track.enabled = false */
  pause: () => void
  /** 恢复：设置视频 track.enabled = true */
  resume: () => void
  /**
   * 共享中热切换分辨率：按新档位重新采集视频 track，替换本地流并停旧
   * 采集（借鉴 mirotalk replaceTrack 换轨模式——观众端由调用方对 sender
   * 执行 replaceTrack，无重协商、观众无感）。返回新视频 track；失败或
   * 用户取消授权时返回 null（本地状态保持不变）。
   */
  switchResolution: (
    preset: ResolutionPreset
  ) => Promise<MediaStreamTrack | null>
}

export function useLocalMediaStream(
  options: UseLocalMediaStreamOptions
): UseLocalMediaStreamResult {
  const {
    frameRate,
    shareSystemAudio,
    shareMicrophone,
    resolutionPreset,
    onStreamEnded,
    localVideoRef,
  } = options

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [switchingResolution, setSwitchingResolution] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const localStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  /** 当前视频 track 的 ended 监听（热切换分辨率时需从旧 track 摘除） */
  const videoEndedHandlerRef = useRef<(() => void) | null>(null)
  /** 防止分辨率切换并发重入 */
  const switchingResolutionRef = useRef(false)

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

  const start = useCallback(async (): Promise<boolean> => {
    // 防重复点击：正在启动或正在共享时直接返回
    if (starting || isSharing) return true

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
        reason = translate(
          '当前浏览器不支持屏幕共享 API，请使用最新版 Chrome / Edge / Firefox'
        )
      } else {
        reason =
          translate(
            '屏幕共享 (getDisplayMedia) 需要安全上下文（HTTPS 或 localhost），当前页面为 HTTP 来源，浏览器已禁用该 API。\n\n'
          ) +
          translate('解决方案（任选其一）：\n') +
          translate(
            "1. 【推荐】将站点部署为 HTTPS：可使用 Let's Encrypt 申请免费证书，或通过 Nginx/Caddy 反向代理终止 TLS。\n"
          ) +
          translate(
            '2. 【临时方案】在 Chrome/Edge 地址栏访问 chrome://flags/#unsafely-treat-insecure-origin-as-secure，'
          ) +
          translate(
            '在输入框添加 {{origin}} 并点击启用，然后完全重启浏览器。\n',
            { origin: window.location.origin }
          ) +
          translate(
            '3. 【本地代理】在本地通过 SSH 隧道将远程服务映射到 localhost，再通过 https://localhost 访问。'
          )
      }
      setError(reason)
      message.error(translate('屏幕共享不可用：当前为非安全上下文'))
      return false
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
          translate(
            '当前页面运行在 iframe 嵌套环境中，浏览器禁止调用屏幕共享 API（需要父页面通过 allow="display-capture" 授权）。\n\n'
          ) +
          translate('常见场景：IDE 内置预览、嵌入式开发服务器预览页等。\n\n') +
          translate('解决方案：\n') +
          translate(
            '1. 【推荐】点击「在新窗口打开」按钮，或在浏览器中直接访问 {{origin}}\n',
            { origin: window.location.origin }
          ) +
          translate(
            '2. 复制下方链接到外部浏览器（Chrome / Edge）地址栏打开：\n'
          ) +
          `   ${window.location.href}`
        setError(reason)
        message.error(translate('屏幕共享不可用：iframe 环境未获授权'))
        return false
      }
    }

    setError(null)
    setStarting(true)
    try {
      const useTestStream =
        new URLSearchParams(window.location.search).get('testStream') === 'true'

      // 帧率约束：只使用 ideal，不设置 max（借鉴 mirotalk
      // getScreenShareVideoConstraints 的写法）。
      // Chromium 桌面采集器对 max 帧率约束做严格模式匹配，无法精确满足时
      // 会回落到默认档（30fps）——这正是「选择 60 帧仍为 30 帧」的根因；
      // ideal 语义下 Chrome 会以目标帧率为期望尽可能采集。
      // 编码器输出上限由 useHostPeerConnections 的 encodings.maxFramerate
      // 负责，采集侧无需重复设限。
      //
      // 分辨率约束：仅使用 ideal，不设置 max。
      // Firefox 对 getDisplayMedia 的 max 约束解释与 Chrome 不同：
      // 当 max 恰好等于显示器原生分辨率时，Firefox 会将其视为严格约束，
      // 在无法精确匹配时回退到下一级标准分辨率（通常是 720p）。
      // 移除 max 后，Firefox 和 Chrome 都会以 ideal 为目标选择最接近的可用分辨率。
      // 视频约束统一由 buildVideoConstraints 构造：帧率只给 ideal，
      // 宽高按分辨率档位 ideal 下发（native 不下发跟随本机）。
      const videoConstraints = buildVideoConstraints(
        frameRate,
        resolutionPreset
      )

      let mediaStream: MediaStream
      if (useTestStream) {
        message.info(translate('测试模式：使用摄像头画面代替屏幕共享'))
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...videoConstraints,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: shareSystemAudio,
        })
      } else {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
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
          message.warning(translate('无法获取麦克风权限，将仅共享屏幕'))
        }
      }

      localStreamRef.current = mediaStream
      setStream(mediaStream)
      setIsSharing(true)
      setIsPaused(false)

      // 系统音频兜底检测（issue #26）：浏览器完全可能不返回音频轨道——
      // Chrome/Edge 需要在共享选择器里勾选「同时共享系统音频」，
      // Firefox 不支持屏幕音频采集，WebView2 等内嵌环境也可能静默丢弃
      // 音频轨道。若不提示，表现为「开了开关、观众却没声音」且双方无从排查。
      if (shareSystemAudio && mediaStream.getAudioTracks().length === 0) {
        message.warning(
          translate(
            '浏览器未返回系统音频轨道：请在共享选择窗口勾选「同时共享系统音频」后重新开始共享。'
          ) + translate('Firefox 不支持共享系统音频，请改用 Chrome / Edge。'),
          { duration: 10000 }
        )
      }
      // 系统音频轨中途被停止（用户在浏览器共享栏取消音频勾选等）时提示房主
      mediaStream.getAudioTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          message.warning(translate('系统音频共享已停止，观众将不再听到声音'), {
            duration: 8000,
          })
        })
      })

      // 对视频轨道设置 contentHint 并做分辨率兜底
      // - contentHint='motion' 告知浏览器/编码器内容为动态画面，避免静止检测降帧
      // - 帧率不再二次 applyConstraints 限 max：Chromium 对 max 约束的严格
      //   匹配会把桌面采集钳回 30fps；编码器输出上限已由 sender 的
      //   encodings.maxFramerate 负责（useHostPeerConnections）
      // - 分辨率兜底：部分浏览器（尤其 Firefox）在 getDisplayMedia 时可能返回
      //   低于 ideal 的分辨率（如 720p），此处尝试通过 applyConstraints 提升到 1080p
      // - 必须 await 确保 PC 建立前约束已生效
      await Promise.all(
        mediaStream.getVideoTracks().map(async (track) => {
          track.contentHint = 'motion'
          const settingsBefore = track.getSettings()
          console.log(
            '[useLocalMediaStream] track settings before applyConstraints:',
            settingsBefore
          )

          // 分辨率兜底：浏览器返回的分辨率低于档位目标时尝试提升
          // applyConstraints 对分辨率的调整能力有限（取决于捕获源），
          // 但在某些场景下能从 720p 提升到目标档位；native 档不兜底
          const dims = RESOLUTION_DIMENSIONS[resolutionPreset]
          if (
            dims &&
            settingsBefore.width &&
            settingsBefore.height &&
            (settingsBefore.width < dims.width ||
              settingsBefore.height < dims.height)
          ) {
            try {
              await track.applyConstraints({
                width: { ideal: dims.width },
                height: { ideal: dims.height },
              })
              const afterResolution = track.getSettings()
              console.log(
                '[useLocalMediaStream] resolution upgrade attempt:',
                `${settingsBefore.width}x${settingsBefore.height}`,
                '->',
                `${afterResolution.width}x${afterResolution.height}`
              )
            } catch (err) {
              console.warn(
                '[useLocalMediaStream] applyConstraints resolution error:',
                err
              )
            }
          }

          // 采集实际帧率以日志为准，不再二次 applyConstraints 限 max
          // （Chromium 对 max 约束的严格匹配会把桌面采集钳回 30fps）
          const captureSettings = track.getSettings()
          console.log(
            '[useLocalMediaStream] capture settings:',
            'frameRate:',
            captureSettings.frameRate,
            'target:',
            frameRate,
            'resolution:',
            `${captureSettings.width}x${captureSettings.height}`
          )
        })
      )

      mediaStream.getVideoTracks().forEach((track) => {
        console.log(
          '[useLocalMediaStream] video track:',
          track.label,
          'enabled:',
          track.enabled,
          'muted:',
          track.muted,
          'settings:',
          track.getSettings()
        )
        track.addEventListener('unmute', () => {
          console.log('[useLocalMediaStream] video track unmuted')
        })
        track.addEventListener('mute', () => {
          console.warn('[useLocalMediaStream] video track muted')
        })
      })

      // 视频 track 结束时（如用户通过浏览器 UI 停止共享）触发回调。
      // handler 存入 ref：热切换分辨率换轨时需先从旧 track 摘除，
      // 否则 stop 旧 track 会误触发 close-room
      const endedHandler = () => {
        onStreamEndedRef.current?.()
      }
      videoEndedHandlerRef.current = endedHandler
      mediaStream.getVideoTracks()[0]?.addEventListener('ended', endedHandler)
      return true
    } catch (err) {
      console.error('[useLocalMediaStream] getDisplayMedia error:', err)
      // 区分错误类型给出明确提示
      const errName = (err as { name?: string })?.name
      let reason = translate('无法获取屏幕共享权限')
      if (errName === 'NotAllowedError') {
        reason = translate('已取消屏幕共享授权，或浏览器未授予屏幕共享权限')
      } else if (errName === 'NotFoundError') {
        reason = translate('未找到可用的屏幕共享源')
      } else if (errName === 'NotReadableError') {
        reason = translate('屏幕共享源被其他程序占用，无法捕获')
      } else if (errName === 'OverconstrainedError') {
        reason = translate('请求的约束条件无法满足，请降低帧率或分辨率后重试')
      } else if (errName === 'TypeError') {
        reason = translate('请求参数错误，请检查媒体设置')
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
          ? translate(
              '当前 iframe 环境未授权屏幕共享，请在独立浏览器窗口中打开本页面：\n{{href}}',
              { href: window.location.href }
            )
          : translate(
              '当前浏览器或系统不支持屏幕共享，请使用最新版 Chrome / Edge 并确认系统已启用屏幕捕获权限'
            )
      }
      setError(reason)
      message.error(reason)
      return false
    } finally {
      setStarting(false)
    }
  }, [
    frameRate,
    shareSystemAudio,
    shareMicrophone,
    resolutionPreset,
    starting,
    isSharing,
  ])

  // 共享期间帧率热更新：用户在媒体设置中修改帧率时，对采集 track 即时
  // applyConstraints（编码器上限由 useHostPeerConnections 的
  // setParameters 热更新同步生效），无需停止共享。start() 内部的初始
  // 应用不受影响：appliedFrameRateRef 已等于当前值，此处不会重复执行。
  const appliedFrameRateRef = useRef(frameRate)
  useEffect(() => {
    if (appliedFrameRateRef.current === frameRate) return
    appliedFrameRateRef.current = frameRate
    const track = localStreamRef.current?.getVideoTracks()[0]
    if (!track || track.readyState !== 'live') return
    void track
      .applyConstraints({
        // 裸数值=ideal 语义（借鉴 mirotalk setLocalMaxFps），不用 max：
        // Chromium 对 max 的严格匹配会把桌面采集钳回 30fps
        frameRate,
      })
      .then(() => {
        console.log(
          '[useLocalMediaStream] hot frameRate applied:',
          frameRate,
          'actual:',
          track.getSettings().frameRate
        )
      })
      .catch((err) => {
        console.warn('[useLocalMediaStream] hot frameRate apply error:', err)
      })
  }, [frameRate, stream])

  // 共享中热切换分辨率：重新采集视频 track → 替换本地流 → 停旧采集。
  // 借鉴 mirotalk refreshMyStreamToPeers 的换轨模式：观众端由调用方
  // （WebrtcSharePage）对所有 sender 执行 replaceTrack，PC 全程存活、
  // 无重协商、观众无感。关键陷阱：旧 track.stop() 会触发 ended 事件，
  // 必须先摘除监听，否则会误走 close-room 流程。
  const switchResolution = useCallback(
    async (preset: ResolutionPreset): Promise<MediaStreamTrack | null> => {
      const currentStream = localStreamRef.current
      const oldTrack = currentStream?.getVideoTracks()[0]
      if (!currentStream || !oldTrack || oldTrack.readyState !== 'live') {
        return null
      }
      if (switchingResolutionRef.current) return null
      switchingResolutionRef.current = true
      setSwitchingResolution(true)
      try {
        const useTestStream =
          new URLSearchParams(window.location.search).get('testStream') ===
          'true'
        const videoConstraints = buildVideoConstraints(frameRate, preset)

        // 仅重新采集视频（audio: false 避免再次弹出音频授权）；
        // 已有的系统音频/麦克风 track 原样保留
        let captured: MediaStream
        if (useTestStream) {
          captured = await navigator.mediaDevices.getUserMedia({
            video: {
              ...videoConstraints,
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
          })
        } else {
          captured = await navigator.mediaDevices.getDisplayMedia({
            video: videoConstraints,
            audio: false,
          })
        }
        const newTrack = captured.getVideoTracks()[0]
        if (!newTrack) {
          captured.getTracks().forEach((t) => t.stop())
          return null
        }
        newTrack.contentHint = 'motion'
        // 保持暂停状态一致（暂停 = track.enabled = false）
        newTrack.enabled = oldTrack.enabled

        // ended 监听迁移：先摘旧再挂新，随后才能安全 stop 旧 track
        if (videoEndedHandlerRef.current) {
          oldTrack.removeEventListener('ended', videoEndedHandlerRef.current)
        }
        const endedHandler = () => {
          onStreamEndedRef.current?.()
        }
        videoEndedHandlerRef.current = endedHandler
        newTrack.addEventListener('ended', endedHandler)

        // 换入本地流：新 MediaStream（视频替换，音频沿用原 track）
        const nextStream = new MediaStream([
          newTrack,
          ...currentStream.getAudioTracks(),
        ])
        localStreamRef.current = nextStream
        setStream(nextStream)

        // 停旧采集（监听已摘除，不会触发 onStreamEnded）
        try {
          oldTrack.stop()
        } catch {
          // ignore
        }

        const settings = newTrack.getSettings()
        console.log(
          '[useLocalMediaStream] resolution switched:',
          preset,
          'actual:',
          `${settings.width}x${settings.height}`,
          'frameRate:',
          settings.frameRate
        )
        return newTrack
      } catch (err) {
        const errName = (err as { name?: string })?.name
        if (errName === 'NotAllowedError') {
          message.info(translate('已取消授权，保持当前分辨率'))
        } else {
          console.warn('[useLocalMediaStream] switchResolution error:', err)
          message.warning(translate('切换分辨率失败，保持当前分辨率'))
        }
        return null
      } finally {
        switchingResolutionRef.current = false
        setSwitchingResolution(false)
      }
    },
    [frameRate]
  )

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
    switchingResolution,
    error,
    start,
    stop,
    pause,
    resume,
    switchResolution,
  }
}
