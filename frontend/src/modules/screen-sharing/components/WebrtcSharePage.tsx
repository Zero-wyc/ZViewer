/**
 * WebRTC 屏幕共享房主端。
 *
 * 三件事：采集与混音（`ShareHostSession`）、本地预览、控制栏。
 * 多观众不再由本页管理——服务端为每个观众下发一条候选，会话按候选建发布端，
 * 页面只读会话暴露的计数。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Monitor, Copy, ExternalLink } from 'lucide-react'
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
  type WebrtcShareMediaSettings,
} from '../utils/mediaSettingsStorage'
import { ICE_SERVERS } from '../constants'
import type { ResolutionPreset } from '../constants'
import { MediaSettingsCard } from './MediaSettingsCard'
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
  /** 媒体走向变化回调（直连 / 服务端转发），供统计面板标注。 */
  onSharingModeChange?: (mode: 'direct' | 'relay') => void
}

function WebrtcSharePage({
  className,
  style,
  onStatsPeerConnectionChange,
  onCaptureFpsChange,
  onSharingModeChange,
}: WebrtcSharePageProps) {
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const setIsSharing = useRoomStore((state) => state.setIsSharing)
  const roomId = useRoomStore((state) => state.roomId)
  const currentRoomId = roomId ?? ''

  // 媒体设置持久化（借鉴 mirotalk lsSettings）：进房时恢复上次选择，
  // 变化时写回 localStorage
  const [savedSettings] = useState(loadMediaSettings)
  const copy = useCopyToClipboard()
  const [frameRate, setFrameRate] = useState(savedSettings.frameRate)
  const [maxBitrateMbps, setMaxBitrateMbps] = useState(
    savedSettings.maxBitrateMbps
  )
  const [shareSystemAudio, setShareSystemAudio] = useState(
    savedSettings.shareSystemAudio
  )
  const [shareMicrophone, setShareMicrophone] = useState(
    savedSettings.shareMicrophone
  )
  const [resolutionPreset, setResolutionPreset] = useState(
    savedSettings.resolutionPreset
  )
  const [closing, setClosing] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [starting, setStarting] = useState(false)
  const [switchingResolution, setSwitchingResolution] = useState(false)

  /** 当前界面设置：事件回调同步读它，避免闭包里拿到旧值。 */
  const settingsRef = useRef<WebrtcShareMediaSettings>(savedSettings)
  useEffect(() => {
    const next: WebrtcShareMediaSettings = {
      frameRate,
      maxBitrateMbps,
      shareSystemAudio,
      shareMicrophone,
      resolutionPreset,
    }
    settingsRef.current = next
    saveMediaSettings(next)
  }, [
    frameRate,
    maxBitrateMbps,
    shareSystemAudio,
    shareMicrophone,
    resolutionPreset,
  ])

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
    stopSharing()
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
      if (next === resolutionPreset) return
      if (!isSharing) {
        setResolutionPreset(next)
        return
      }
      const prev = resolutionPreset
      setResolutionPreset(next)
      setSwitchingResolution(true)
      try {
        const ok = await switchResolution({
          ...settingsRef.current,
          resolutionPreset: next,
        })
        if (!ok) {
          setResolutionPreset(prev)
          await switchResolution({
            ...settingsRef.current,
            resolutionPreset: prev,
          })
          message.error(t('分辨率切换失败，已保留原分辨率'))
          return
        }
        message.success(t('分辨率已切换'))
      } finally {
        setSwitchingResolution(false)
      }
    },
    [resolutionPreset, isSharing, switchResolution]
  )

  // 帧率热更新：改的是编码参数，不重采集、不重协商。
  // 码率不足是 60fps 降帧的首要原因，低于推荐值时顺带抬到推荐值，
  // 但不覆盖用户主动设置的高码率。
  const handleFrameRateSettingChange = useCallback(
    (next: number) => {
      const recommended = Math.max(2, Math.round(next * 0.267))
      const nextBitrate = Math.max(maxBitrateMbps, recommended)
      setFrameRate(next)
      setMaxBitrateMbps(nextBitrate)
      if (!isSharing) return
      void applyProfile({
        ...settingsRef.current,
        frameRate: next,
        maxBitrateMbps: nextBitrate,
      })
    },
    [maxBitrateMbps, isSharing, applyProfile]
  )

  const handleBitrateChange = useCallback(
    (next: number) => {
      setMaxBitrateMbps(next)
      if (!isSharing) return
      void applyProfile({ ...settingsRef.current, maxBitrateMbps: next })
    },
    [isSharing, applyProfile]
  )

  // 麦克风是混进同一条音轨的，共享中可以直接开关；系统声必须重新采集。
  const handleMicrophoneChange = useCallback(
    (enabled: boolean) => {
      setShareMicrophone(enabled)
      if (isSharing) void setMicrophone(enabled)
    },
    [isSharing, setMicrophone]
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

  useEffect(() => {
    onSharingModeChange?.(sharingMode)
  }, [sharingMode, onSharingModeChange])

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
          <ShareControlsBar
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
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 overflow-y-auto p-6 pt-20">
          <div
            className="glass-card w-full max-w-sm rounded-2xl border p-6 shadow-sm"
            style={{
              borderColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
              backgroundColor: 'var(--glass-bg)',
              backdropFilter: 'blur(var(--glass-blur-strong))',
              WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
            }}
          >
            <div className="mb-5 flex items-center justify-between">
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

            <MediaSettingsCard
              frameRate={frameRate}
              maxBitrateMbps={maxBitrateMbps}
              shareSystemAudio={shareSystemAudio}
              shareMicrophone={shareMicrophone}
              resolutionPreset={resolutionPreset}
              isSharing={isSharing}
              switchingResolution={switchingResolution}
              onFrameRateChange={handleFrameRateSettingChange}
              onMaxBitrateChange={handleBitrateChange}
              onShareSystemAudioChange={setShareSystemAudio}
              onShareMicrophoneChange={handleMicrophoneChange}
              onResolutionChange={(value) => {
                void handleResolutionChange(value)
              }}
            />

            <Button
              variant="primary"
              className="mt-5 w-full"
              icon={<Monitor className="h-5 w-5" />}
              onClick={handleStart}
              loading={starting}
              disabled={starting || closing}
            >
              {starting ? t('正在请求权限...') : t('开始共享')}
            </Button>
          </div>

          {inIframe && (
            <div
              className="w-full max-w-sm rounded-xl border px-4 py-3 text-xs"
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

          {errorText && (
            <div
              className="relative w-full max-w-sm rounded-xl border px-4 py-3 text-xs"
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

          <Paragraph
            type="secondary"
            className="!text-white m-0 max-w-sm text-center text-xs"
          >
            {t('将链接发送给观看方，对方打开后即可自动加入房间观看。')}
          </Paragraph>
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
