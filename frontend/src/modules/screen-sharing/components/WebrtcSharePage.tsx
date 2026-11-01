/**
 * WebRTC 屏幕共享房主端。
 *
 * 三件事：采集与混音（`ShareHostSession`）、本地预览、控制栏。
 * 多观众不再由本页管理——服务端为每个观众下发一条候选，会话按候选建发布端，
 * 页面只读会话暴露的计数。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Monitor, Copy, ExternalLink, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { ConfirmModal } from '@/components/ui/Modal'
import { LiveArtPlayer } from '@/modules/art-player'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { AnnotationLayer } from '@/components/AnnotationLayer'
import { message } from '@/components/ui/message'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useShareHost } from '../hooks/useShareHost'
import { createCaptureFrameMeter } from '../utils/frameMeter'
import { hostErrorText, parameterOverrideText } from '../utils/shareMessages'
import {
  loadMediaSettings,
  saveMediaSettings,
  type CaptureSource,
  type WebrtcShareMediaSettings,
} from '../utils/mediaSettingsStorage'
import { browserCameras, type CaptureDevice } from '../core/capture-devices'
import type { PeerQualityView } from '../core/peer-quality'
import { ICE_SERVERS } from '@/lib/iceServers'
import {
  QUALITY_PRESETS,
  type QualityPresetId,
  type ResolutionPreset,
} from '../constants'
import { ShareSettingsCard } from './ShareSettingsCard'
import { ShareControlsBar } from './ShareControlsBar'
import { SharingPausedOverlay } from './SharingPausedOverlay'
import type { CloseRoomResponse, RoomModeChangedPayload } from '../types'
import { t } from '@/i18n'

interface WebrtcSharePageProps {
  className?: string
  style?: React.CSSProperties
  onStatsPeerConnectionChange?: (pc: RTCPeerConnection | null) => void
  /** 采集实测帧率变化回调，提升到 RoomPage 供 SharingStatusPanel 显示 */
  onCaptureFpsChange?: (fps: number | null) => void
  /** 上报每条观众连接的质量（房主侧本地采样，供状态面板展示）。 */
  onPeerQualitiesChange?: (list: PeerQualityView[]) => void
  /** 媒体走向变化回调（直连 / 服务端转发），供统计面板标注。 */
  onSharingModeChange?: (mode: 'direct' | 'relay') => void
}

function WebrtcSharePage({
  className,
  style,
  onStatsPeerConnectionChange,
  onCaptureFpsChange,
  onPeerQualitiesChange,
  onSharingModeChange,
}: WebrtcSharePageProps) {
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const setIsSharing = useRoomStore((state) => state.setIsSharing)
  const roomId = useRoomStore((state) => state.roomId)
  const currentRoomId = roomId ?? ''

  // 媒体设置持久化（借鉴 mirotalk lsSettings）：进房时恢复上次选择，
  // 变化时写回 localStorage。
  //
  // 所有参数放在**一个** state 对象里：拆成七个 useState 时，任何一次
  // 「档位一次性改三项」都会读到彼此的旧值（settingsRef 要等下一次渲染才
  // 更新），于是界面显示 1080P/60fps 而实际下发的还是旧组合。
  const [savedSettings] = useState(loadMediaSettings)
  const copy = useCopyToClipboard()
  const [settings, setSettings] =
    useState<WebrtcShareMediaSettings>(savedSettings)
  const settingsRef = useRef<WebrtcShareMediaSettings>(savedSettings)
  useEffect(() => {
    settingsRef.current = settings
    saveMediaSettings(settings)
  }, [settings])

  /**
   * 改设置并**同步**返回合并后的结果。
   *
   * ref 立刻更新（事件处理里紧接着要把新值交给会话），state 只负责渲染。
   */
  const commitSettings = useCallback(
    (patch: Partial<WebrtcShareMediaSettings>): WebrtcShareMediaSettings => {
      const next = { ...settingsRef.current, ...patch }
      settingsRef.current = next
      setSettings(next)
      return next
    },
    []
  )

  const [closing, setClosing] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [starting, setStarting] = useState(false)
  const [switchingResolution, setSwitchingResolution] = useState(false)
  const [switchingSource, setSwitchingSource] = useState(false)
  /** 可选摄像头（`enumerateDevices` 的结果，未授权时 label 为空）。 */
  const [cameras, setCameras] = useState<CaptureDevice[]>([])
  /** 共享中拉起的「共享设置」浮层。 */
  const [settingsOpen, setSettingsOpen] = useState(false)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const [localVideoVersion, setLocalVideoVersion] = useState(0)
  const handleLocalVideoReady = useCallback((node: HTMLVideoElement | null) => {
    const prev = localVideoRef.current
    localVideoRef.current = node
    if (node && !prev) setLocalVideoVersion((v) => v + 1)
  }, [])
  const handleStreamEndedRef = useRef<() => void>(() => {})

  const {
    sharing: isSharing,
    paused: isPaused,
    peerCount,
    viewerCount,
    statsPeerConnection,
    sharingMode,
    parameterOverride,
    previewStream,
    error,
    start,
    stop,
    setPaused,
    setMicrophone,
    applyProfile,
    switchResolution,
    switchCaptureSource,
    peerQualities,
    autoDowngrade,
  } = useShareHost({
    socket,
    roomId: currentRoomId,
    iceServers: ICE_SERVERS,
    videoRef: localVideoRef,
    videoVersion: localVideoVersion,
    onStreamEnded: () => handleStreamEndedRef.current(),
  })

  const stopSharing = useCallback(() => {
    stop()
  }, [stop])

  const handleStreamEnded = useCallback(() => {
    const source = settingsRef.current.captureSource
    // 采集被系统级停掉（用户点了浏览器的「停止共享」、摄像头被拔掉/被抢占）。
    // 这条日志是现场唯一能解释「为什么共享突然停了」的线索。
    console.warn('[share] capture ended', { source })
    stopSharing()
    if (source === 'camera') {
      // 摄像头掉线只停共享，**不关房间**：房主可能正在一起看/一起听，
      // 不该因为一颗摄像头把整场会话关掉，他换回屏幕共享就能继续。
      message.warning(t('摄像头已断开，共享已停止'))
      return
    }
    if (!socket) return
    socket.emit('close-room', (response: CloseRoomResponse) => {
      if (response.success) {
        message.success(t('房间已关闭'))
        navigate('/', { replace: true })
      } else {
        message.error(response.message ?? t('关闭房间失败'))
      }
    })
  }, [stopSharing, socket, navigate])

  useEffect(() => {
    handleStreamEndedRef.current = handleStreamEnded
  }, [handleStreamEnded])

  const handleRoomClosed = useCallback(() => {
    // 提示与退房导航由 RoomPage 统一处理（避免与页面级 room-closed
    // 响应重复弹 toast / 导航冲突）；这里只做本组件的即时清理。
    setClosing(true)
    stopSharing()
  }, [stopSharing])

  const handleRoomModeChanged = useCallback(
    (data: RoomModeChangedPayload) => {
      setMode(data.mode)
      if (data.mode === 'watch-together') stopSharing()
    },
    [setMode, stopSharing]
  )

  // 房间生命周期只订这两个事件：信令已经全部走 `share` 单一通道，
  // 旧 signal-* / viewer-* 事件前端不再收发。
  useEffect(() => {
    if (!socket) return
    socket.on('room-closed', handleRoomClosed)
    socket.on('room-mode-changed', handleRoomModeChanged)
    return () => {
      socket.off('room-closed', handleRoomClosed)
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [socket, handleRoomClosed, handleRoomModeChanged])

  const handleStopSharing = useCallback(() => {
    stopSharing()
    // 浮层跟着共享一起收：停止后再挂着一个「共享设置」只会让人以为还在共享。
    setSettingsOpen(false)
  }, [stopSharing])

  const handleClearAnnotations = useCallback(() => {
    if (!socket || !currentRoomId) return
    socket.emit(
      'clear-annotations',
      { roomId: currentRoomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success)
          message.error(response.message ?? t('清空批注失败'))
      }
    )
  }, [socket, currentRoomId])

  const handleCopy = useCallback(() => {
    void copy(`${window.location.origin}/room/${currentRoomId}`, {
      successMessage: t('观看链接已复制'),
    })
  }, [copy, currentRoomId])

  const handleCopyError = useCallback(() => {
    const text = hostErrorText(error)
    if (!text) return
    void copy(text, {
      successMessage: t('错误详情已复制，可粘贴给管理员'),
      errorMessage: t('复制失败，请手动选择文本复制'),
    })
  }, [copy, error])

  const inIframe = (() => {
    try {
      return window.self !== window.top
    } catch {
      return true
    }
  })()

  const handleOpenInNewWindow = useCallback(() => {
    window.open(window.location.href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleTogglePause = useCallback(() => {
    setPaused(!isPaused)
  }, [isPaused, setPaused])

  const handleStart = useCallback(async () => {
    if (starting) return
    setStarting(true)
    try {
      await start(settingsRef.current)
    } finally {
      setStarting(false)
    }
  }, [start, starting])

  const handleRefresh = useCallback(async () => {
    stopSharing()
    await handleStart()
  }, [stopSharing, handleStart])

  // 分辨率切换：未共享时只记录档位（下次 start 生效）；共享中重新下发采集
  // 约束并热替换 sender track——PC 全程存活、观众无感。采集失败时回滚档位，
  // 否则界面显示的档位和实际画面不一致。
  const handleResolutionChange = useCallback(
    async (next: ResolutionPreset) => {
      if (next === settingsRef.current.resolutionPreset) return
      const previous = settingsRef.current
      if (!isSharing) {
        commitSettings({ resolutionPreset: next })
        return
      }
      const pending = commitSettings({ resolutionPreset: next })
      setSwitchingResolution(true)
      try {
        const ok = await switchResolution(pending)
        if (!ok) {
          await switchResolution(commitSettings(previous))
          message.error(t('分辨率切换失败，已保留原分辨率'))
          return
        }
        message.success(t('分辨率已切换'))
      } finally {
        setSwitchingResolution(false)
      }
    },
    [isSharing, switchResolution, commitSettings]
  )

  // 帧率热更新：改的是编码参数，不重采集、不重协商。
  // 码率不足是 60fps 降帧的首要原因，低于推荐值时顺带抬到推荐值，
  // 但不覆盖用户主动设置的高码率。
  const handleFrameRateSettingChange = useCallback(
    (next: number) => {
      const recommended = Math.max(2, Math.round(next * 0.267))
      const nextBitrate = Math.max(
        settingsRef.current.maxBitrateMbps,
        recommended
      )
      const pending = commitSettings({
        frameRate: next,
        maxBitrateMbps: nextBitrate,
      })
      if (isSharing) void applyProfile(pending)
    },
    [isSharing, applyProfile, commitSettings]
  )

  const handleBitrateChange = useCallback(
    (next: number) => {
      const pending = commitSettings({ maxBitrateMbps: next })
      if (isSharing) void applyProfile(pending)
    },
    [isSharing, applyProfile, commitSettings]
  )

  // 画面偏好与音频码率都只改编码参数：不重采集、不重协商，共享中即时生效。
  const handleDegradationChange = useCallback(
    (preference: RTCDegradationPreference) => {
      const pending = commitSettings({ degradationPreference: preference })
      if (isSharing) void applyProfile(pending)
    },
    [isSharing, applyProfile, commitSettings]
  )

  const handleAudioBitrateChange = useCallback(
    (bitrate: number) => {
      const pending = commitSettings({ maxAudioBitrate: bitrate })
      if (isSharing) void applyProfile(pending)
    },
    [isSharing, applyProfile, commitSettings]
  )

  // 一键档位：分辨率变了要重采集，只变帧率/码率则改编码参数。
  const handlePresetChange = useCallback(
    async (id: QualityPresetId) => {
      const preset = QUALITY_PRESETS.find((item) => item.id === id)
      if (!preset || switchingResolution) return
      if (preset.resolutionPreset !== settingsRef.current.resolutionPreset) {
        // 先把帧率/码率写进去，切分辨率时一并下发。
        commitSettings({
          frameRate: preset.frameRate,
          maxBitrateMbps: preset.maxBitrateMbps,
        })
        await handleResolutionChange(preset.resolutionPreset)
        return
      }
      const pending = commitSettings({
        frameRate: preset.frameRate,
        maxBitrateMbps: preset.maxBitrateMbps,
        resolutionPreset: preset.resolutionPreset,
      })
      if (isSharing) void applyProfile(pending)
    },
    [
      isSharing,
      applyProfile,
      commitSettings,
      handleResolutionChange,
      switchingResolution,
    ]
  )

  // 麦克风是混进同一条音轨的，共享中可以直接开关；系统声必须重新采集。
  const handleMicrophoneChange = useCallback(
    (enabled: boolean) => {
      commitSettings({ shareMicrophone: enabled })
      if (isSharing) void setMicrophone(enabled)
    },
    [isSharing, setMicrophone, commitSettings]
  )

  const handleSystemAudioChange = useCallback(
    (enabled: boolean) => {
      commitSettings({ shareSystemAudio: enabled })
    },
    [commitSettings]
  )

  // 摄像头列表：只在选「摄像头」时枚举。enumerateDevices 不触发权限，
  // 但未授权时 label 是空串，面板会用序号占位。
  useEffect(() => {
    if (settings.captureSource !== 'camera') return
    let cancelled = false
    void browserCameras()
      .then((list) => {
        if (!cancelled) setCameras(list)
      })
      .catch(() => {
        if (!cancelled) setCameras([])
      })
    return () => {
      cancelled = true
    }
  }, [settings.captureSource])

  /**
   * 换采集源 / 换摄像头。
   *
   * 共享中走 `switchSource`：采集新流 → `replaceTrack`，PC 不重协商、观众端
   * 无感。失败（摄像头被别的程序占着等）要回滚设置，否则界面显示「摄像头」
   * 而画面还是屏幕，比直接报错更让人困惑。
   */
  const applyCaptureSource = useCallback(
    async (patch: Partial<WebrtcShareMediaSettings>, failureText: string) => {
      const previous = settingsRef.current
      const pending = commitSettings(patch)
      if (!isSharing) return
      setSwitchingSource(true)
      try {
        const ok = await switchCaptureSource(pending)
        if (!ok) {
          commitSettings(previous)
          message.error(t(failureText))
        }
      } finally {
        setSwitchingSource(false)
      }
    },
    [commitSettings, isSharing, switchCaptureSource]
  )

  const handleCaptureSourceChange = useCallback(
    (source: CaptureSource) => {
      if (source === settingsRef.current.captureSource) return
      void applyCaptureSource(
        { captureSource: source },
        t('切换采集源失败，已保留原画面')
      )
    },
    [applyCaptureSource]
  )

  const handleCameraDeviceChange = useCallback(
    (deviceId: string) => {
      if (deviceId === settingsRef.current.cameraDeviceId) return
      void applyCaptureSource(
        { cameraDeviceId: deviceId },
        t('切换摄像头失败，已保留原画面')
      )
    },
    [applyCaptureSource]
  )

  useEffect(() => {
    onStatsPeerConnectionChange?.(statsPeerConnection)
  }, [statsPeerConnection, onStatsPeerConnectionChange])

  // 采集实测帧率计：MediaStreamTrackProcessor 纯数帧，近零开销。
  // 与观众 PC 的 outbound-rtp 发送帧率分离展示，用于定位瓶颈
  // （采集低=捕获问题；采集高发送低=编码丢帧；码率上不去=网络）。
  const [captureFps, setCaptureFps] = useState<number | null>(null)
  useEffect(() => {
    if (!previewStream) return
    const videoTrack = previewStream.getVideoTracks()[0]
    if (!videoTrack) return
    const meter = createCaptureFrameMeter(videoTrack)
    if (!meter) return
    const timer = window.setInterval(() => {
      const fps = meter.sample()
      if (fps !== undefined) setCaptureFps(fps)
    }, 1000)
    return () => {
      window.clearInterval(timer)
      meter.stop()
      // 共享流停止时同步清零，避免面板残留最后一次采样值
      setCaptureFps(null)
    }
  }, [previewStream])

  useEffect(() => {
    onCaptureFpsChange?.(captureFps)
  }, [captureFps, onCaptureFpsChange])

  // 编码跟不上自动降档：同一次降档只提示一遍（state 里是纯数据，
  // 每 2 秒采样都会带上同一个值，没有去重会刷屏）。
  const notifiedDowngradeRef = useRef('')
  useEffect(() => {
    if (!autoDowngrade) return
    const key = `${autoDowngrade.width}x${autoDowngrade.height}@${autoDowngrade.frameRate}`
    if (notifiedDowngradeRef.current === key) return
    notifiedDowngradeRef.current = key
    message.warning(
      t('编码跟不上，已自动降到 {{value}}', {
        value: `${autoDowngrade.width} × ${autoDowngrade.height} · ${autoDowngrade.frameRate} fps`,
      }),
      { duration: 8000 }
    )
  }, [autoDowngrade])

  // 观众质量由会话层本地采样（remote-inbound-rtp），这里只往上层抛一份最新值。
  useEffect(() => {
    onPeerQualitiesChange?.(peerQualities)
  }, [peerQualities, onPeerQualitiesChange])

  useEffect(() => {
    onSharingModeChange?.(sharingMode)
  }, [sharingMode, onSharingModeChange])

  // 共享中的错误必须浮出来：未共享时错误渲染在开始卡片上方，一旦开始共享，
  // 那块 UI 就不在了——服务端拒绝 share.start（或路由耗尽）会变成「界面显示
  // 共享中、观众什么都没有」，而且没有任何提示。
  useEffect(() => {
    if (!isSharing || !error) return
    message.error(hostErrorText(error) ?? t('共享出错，请重新开始共享'))
  }, [error, isSharing])

  useEffect(() => {
    setIsSharing(isSharing)
  }, [isSharing, setIsSharing])

  const errorText = hostErrorText(error)
  const overrideText = parameterOverrideText(parameterOverride)

  if (!currentRoomId) {
    return (
      <div
        className={cn('flex h-full items-center justify-center p-6', className)}
        style={style}
      >
        <Paragraph type="secondary">
          {t('房间号不存在，请重新创建房间')}
        </Paragraph>
      </div>
    )
  }

  return (
    <div className={cn('relative h-full w-full', className)} style={style}>
      {isSharing ? (
        <>
          <div
            className="h-full w-full"
            style={{ opacity: isPaused ? 0.6 : 1 }}
          >
            <LiveArtPlayer
              muted
              showControls={false}
              onVideoReady={handleLocalVideoReady}
            />
          </div>
          <AnnotationLayer socket={socket} roomId={currentRoomId} readOnly />
          <SharingPausedOverlay visible={isPaused} />
          {overrideText && (
            <div
              className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full px-3 py-1.5 text-xs shadow-sm"
              style={{
                border: '1px solid var(--md-sys-color-outline-variant)',
                backgroundColor: 'var(--glass-bg)',
                color: 'var(--md-sys-color-on-surface-variant)',
                backdropFilter: 'blur(var(--glass-blur-strong))',
                WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
              }}
            >
              {overrideText}
            </div>
          )}
          {settingsOpen && (
            <div
              className="absolute right-2 top-2 z-30 flex max-h-[calc(100%-7rem)] w-[min(22rem,calc(100%-1rem))] flex-col overflow-hidden rounded-2xl border shadow-xl"
              style={{
                borderColor:
                  'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
                backgroundColor: 'var(--glass-bg)',
                backdropFilter: 'blur(var(--glass-blur-strong))',
                WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
              }}
            >
              <div
                className="flex items-center justify-between border-b px-3 py-2"
                style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
              >
                <Text className="text-xs font-semibold">{t('共享设置')}</Text>
                <button
                  type="button"
                  onClick={() => setSettingsOpen(false)}
                  className="rounded p-1 opacity-70 hover:opacity-100"
                  aria-label={t('收起共享设置')}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="overflow-y-auto p-3">
                <ShareSettingsCard
                  compact
                  settings={settings}
                  isSharing={isSharing}
                  switchingResolution={switchingResolution}
                  switchingSource={switchingSource}
                  cameras={cameras}
                  onPresetChange={(id) => void handlePresetChange(id)}
                  onResolutionChange={(value) => {
                    void handleResolutionChange(value)
                  }}
                  onFrameRateChange={handleFrameRateSettingChange}
                  onBitrateChange={handleBitrateChange}
                  onDegradationChange={handleDegradationChange}
                  onAudioBitrateChange={handleAudioBitrateChange}
                  onSystemAudioChange={handleSystemAudioChange}
                  onMicrophoneChange={handleMicrophoneChange}
                  onCaptureSourceChange={handleCaptureSourceChange}
                  onCameraDeviceChange={handleCameraDeviceChange}
                />
              </div>
            </div>
          )}
          <ShareControlsBar
            settingsOpen={settingsOpen}
            onToggleSettings={() => setSettingsOpen((open) => !open)}
            isPaused={isPaused}
            connected={connected}
            viewerCount={viewerCount}
            connectionCount={peerCount}
            closing={closing}
            onTogglePause={handleTogglePause}
            onCopyLink={handleCopy}
            onClearAnnotations={handleClearAnnotations}
            onClose={() => setConfirmClose(true)}
            onRefresh={handleRefresh}
          />
        </>
      ) : (
        <div className="flex h-full min-h-0 flex-col items-center justify-start gap-5 overflow-y-auto p-6 pt-20">
          {errorText && (
            <div
              className="relative w-full max-w-sm shrink-0 rounded-xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'var(--md-sys-color-error-container)',
                backgroundColor: 'var(--md-sys-color-error-container)',
              }}
            >
              <Paragraph
                type="danger"
                className="m-0 whitespace-pre-line pr-8 text-xs"
              >
                {errorText}
              </Paragraph>
              <button
                type="button"
                onClick={handleCopyError}
                className="absolute right-2 top-2 rounded p-1 opacity-70 hover:opacity-100"
                style={{
                  color: 'var(--md-sys-color-on-error-container)',
                  backgroundColor: 'transparent',
                }}
                title={t('复制错误详情')}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {inIframe && (
            <div
              className="w-full max-w-sm shrink-0 rounded-xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'var(--md-sys-color-outline-variant)',
                backgroundColor: 'var(--md-sys-color-tertiary-container)',
              }}
            >
              <Paragraph type="secondary" className="m-0 mb-2 text-xs">
                {t(
                  '检测到当前页面运行在嵌入式预览（iframe）环境中，屏幕共享功能可能被浏览器限制。建议在新窗口中打开本页面：'
                )}
              </Paragraph>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={handleOpenInNewWindow}
              >
                {t('在新窗口打开')}
              </Button>
            </div>
          )}

          {/* 卡片自己限高：设置区滚动，「开始共享」永远贴在卡片底部。
              房间里的共享区高度有限，把主操作挤到折叠线以下等于藏起它。 */}
          <div
            className="glass-card flex max-h-full w-full max-w-sm flex-col rounded-2xl border p-6 shadow-sm"
            style={{
              borderColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
              backgroundColor: 'var(--glass-bg)',
              backdropFilter: 'blur(var(--glass-blur-strong))',
              WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
            }}
          >
            <div className="mb-4 flex shrink-0 items-center justify-between">
              <Space align="center" size="sm">
                <Monitor className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
                <Text className="text-base font-semibold">
                  {t('WebRTC 屏幕共享')}
                </Text>
              </Space>
              <Tag color={connected ? 'success' : 'default'}>
                {connected ? t('已连接') : t('未连接')}
              </Tag>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <ShareSettingsCard
                settings={settings}
                isSharing={isSharing}
                switchingResolution={switchingResolution}
                switchingSource={switchingSource}
                cameras={cameras}
                onPresetChange={(id) => void handlePresetChange(id)}
                onResolutionChange={(value) => {
                  void handleResolutionChange(value)
                }}
                onFrameRateChange={handleFrameRateSettingChange}
                onBitrateChange={handleBitrateChange}
                onDegradationChange={handleDegradationChange}
                onAudioBitrateChange={handleAudioBitrateChange}
                onSystemAudioChange={handleSystemAudioChange}
                onMicrophoneChange={handleMicrophoneChange}
                onCaptureSourceChange={handleCaptureSourceChange}
                onCameraDeviceChange={handleCameraDeviceChange}
              />
            </div>

            <Button
              variant="primary"
              className="mt-4 w-full shrink-0"
              icon={<Monitor className="h-5 w-5" />}
              onClick={handleStart}
              loading={starting}
              disabled={starting || closing}
            >
              {starting ? t('正在请求权限...') : t('开始共享')}
            </Button>
            <Paragraph
              type="secondary"
              className="mt-2 m-0 shrink-0 text-center text-[10px] leading-tight"
            >
              {t('将链接发送给观看方，对方打开后即可自动加入房间观看。')}
            </Paragraph>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onOk={() => {
          setConfirmClose(false)
          handleStopSharing()
        }}
        onCancel={() => setConfirmClose(false)}
        title={t('结束共享')}
        okText={t('确认结束')}
        cancelText={t('取消')}
      >
        {t(
          '结束共享将停止屏幕共享并断开观众连接，房间仍会保留，您可以重新开始共享或切换到一起看模式。'
        )}
      </ConfirmModal>
    </div>
  )
}

export default WebrtcSharePage
