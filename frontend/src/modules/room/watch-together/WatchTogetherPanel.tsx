import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Monitor } from 'lucide-react'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { Spinner } from '@/components/ui/Spinner'
import { useSocket } from '@/hooks/useSocket'
import { useSubtitles } from '@/hooks/useSubtitles'
import { useRoomStore } from '@/store/roomStore'
import { useDanmakuStore } from '@/store/danmakuStore'
import {
  DanmakuLayer,
  type DanmakuLayerHandle,
} from '@/components/DanmakuLayer'
import {
  VideoControls,
  type VideoControlsHandle,
} from '@/components/VideoPlayer/VideoControls'
import { VideoStatsMenu } from '@/components/VideoStatsMenu'
import { useWatchTogether } from './useWatchTogether'
import { fetchBilibiliDanmaku, type BilibiliDanmakuItem } from './danmakuEngine'
import { ConfirmModal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'

interface WatchTogetherPanelProps {
  roomId: string
  isHost: boolean
}

export function WatchTogetherPanel({
  roomId,
  isHost,
}: WatchTogetherPanelProps) {
  const { socket } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const {
    watchTogether,
    setWatchTogether,
    forceSync,
    isResolving,
    resolvingMessage,
    reloadBilibili,
  } = useWatchTogether({
    roomId,
    isHost,
    videoRef,
  })

  // 字幕状态：房主操作广播同步，观众监听应用
  const subtitles = useSubtitles({ roomId, isHost })

  const [confirmJoin, setConfirmJoin] = useState<{
    open: boolean
    viewerSocketId: string
  }>({ open: false, viewerSocketId: '' })

  const videoContainerRef = useRef<HTMLDivElement | null>(null)
  const videoControlsRef = useRef<VideoControlsHandle | null>(null)
  const danmakuLayerRef = useRef<DanmakuLayerHandle | null>(null)
  // 缓存已加载的 B站 弹幕，用于弹幕开关重新开启时重新加载
  const danmakuItemsRef = useRef<BilibiliDanmakuItem[]>([])
  const loadedTracksRef = useRef<Set<string>>(new Set())
  const [danmakuEnabled, setDanmakuEnabled] = useState(true)
  const [isWebFullscreen, setIsWebFullscreen] = useState(false)
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
    null
  )

  // 网页全屏模式下按 ESC 退出
  useEffect(() => {
    if (!isWebFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsWebFullscreen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isWebFullscreen])

  const tracks = useDanmakuStore((state) => state.tracks)
  const style = useDanmakuStore((state) => state.style)
  const setDefaultTrack = useDanmakuStore((state) => state.setDefaultTrack)
  const setStyle = useDanmakuStore((state) => state.setStyle)
  const setFilters = useDanmakuStore((state) => state.setFilters)
  const setAdvancedStyle = useDanmakuStore((state) => state.setAdvancedStyle)
  const resetStyle = useDanmakuStore((state) => state.resetStyle)

  // 加载 B站 官方弹幕：缓存后通过 DanmakuLayer 时间轴弹幕接口加载
  useEffect(() => {
    const cid = watchTogether.cid
    if (!cid || watchTogether.sourceType !== 'bilibili') {
      danmakuItemsRef.current = []
      setDefaultTrack([])
      danmakuLayerRef.current?.loadDanmakuTrack('default', [])
      danmakuLayerRef.current?.clear()
      return
    }
    fetchBilibiliDanmaku(cid)
      .then((items) => {
        // 缓存 items，用于弹幕开关重新开启时重新加载
        danmakuItemsRef.current = items
        setDefaultTrack(items)
        danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
        const video = videoRef.current
        if (video) {
          danmakuLayerRef.current?.seek(video.currentTime)
        }
      })
      .catch((err) => {
        console.error('[WatchTogether] load danmaku error:', err)
      })
  }, [watchTogether.cid, watchTogether.sourceType, setDefaultTrack])

  // 弹幕开关重新开启时，重新加载当前时间轴弹幕并 seek 到当前时间
  useEffect(() => {
    if (!danmakuEnabled) return
    const items = danmakuItemsRef.current
    if (items.length > 0) {
      danmakuLayerRef.current?.loadDanmakuTrack('default', items, 0)
      const video = videoRef.current
      if (video) {
        danmakuLayerRef.current?.seek(video.currentTime)
      }
    }
  }, [danmakuEnabled])

  // 同步 store 中的轨道变化到弹幕引擎
  useEffect(() => {
    const layer = danmakuLayerRef.current
    if (!layer) return
    const current = new Set<string>()
    tracks.forEach((track) => {
      layer.loadDanmakuTrack(track.trackId, track.items, track.offset)
      current.add(track.trackId)
    })
    loadedTracksRef.current.forEach((id) => {
      if (!current.has(id)) {
        layer.removeDanmakuTrack(id)
      }
    })
    loadedTracksRef.current = current
  }, [tracks])

  // 视频加载后更新总时长
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleLoadedMetadata = () => {
      if (video.duration && isFinite(video.duration)) {
        setWatchTogether({ duration: video.duration })
      }
    }

    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
    }
  }, [setWatchTogether])

  // 应用字幕状态到 video 的 textTracks：
  // - 关闭字幕：所有轨道 mode = 'disabled'（track 被禁用并隐藏）
  // - 开启字幕：激活轨道 mode = 'showing'，其余 'disabled'
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const tracks = video.textTracks
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i]
      if (!subtitles.subtitleEnabled) {
        track.mode = 'disabled'
      } else if (i === subtitles.activeTrackIndex) {
        track.mode = 'showing'
      } else {
        track.mode = 'disabled'
      }
    }
  }, [
    subtitles.subtitleEnabled,
    subtitles.activeTrackIndex,
    subtitles.subtitleTracks,
    videoElement,
  ])

  // 房主：处理观众加入请求
  useEffect(() => {
    if (!socket || !isHost) return

    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      setConfirmJoin({ open: true, viewerSocketId: data.viewerSocketId })
    }

    socket.on('join-request', handleJoinRequest)
    return () => {
      socket.off('join-request', handleJoinRequest)
    }
  }, [socket, isHost])

  // 所有用户：监听房间模式切换
  useEffect(() => {
    if (!socket) return

    const handleRoomModeChanged = (data: {
      mode: 'screen-share' | 'watch-together'
    }) => {
      setMode(data.mode)
    }

    socket.on('room-mode-changed', handleRoomModeChanged)
    return () => {
      socket.off('room-mode-changed', handleRoomModeChanged)
    }
  }, [socket, setMode])

  const handleApproveJoin = () => {
    const viewerSocketId = confirmJoin.viewerSocketId
    if (!socket || !viewerSocketId) return
    socket.emit(
      'approve-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.success('已允许加入')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
    setConfirmJoin({ open: false, viewerSocketId: '' })
  }

  const handleRejectJoin = () => {
    const viewerSocketId = confirmJoin.viewerSocketId
    if (!socket || !viewerSocketId) return
    socket.emit(
      'reject-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) {
          message.info('已拒绝加入')
        } else {
          message.error(response.message || '操作失败')
        }
      }
    )
    setConfirmJoin({ open: false, viewerSocketId: '' })
  }

  const handleShowControls = () => {
    videoControlsRef.current?.showControls()
  }

  const videoContainer = (
    <div
      ref={videoContainerRef}
      className={cn(
        isWebFullscreen ? 'fixed inset-0 z-[100]' : 'relative h-full w-full'
      )}
      style={
        isWebFullscreen ? { width: '100dvw', height: '100dvh' } : undefined
      }
      onMouseMove={handleShowControls}
      onMouseEnter={handleShowControls}
      onClick={handleShowControls}
    >
      <video
        ref={(node) => {
          videoRef.current = node
          setVideoElement(node)
        }}
        className="h-full w-full object-contain"
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
      >
        {/* 字幕轨道挂载：mode 由 textTracks effect 根据 subtitleEnabled 控制 */}
        {subtitles.subtitleTracks.map((t, i) => (
          <track
            key={`${t.url}-${i}`}
            kind="subtitles"
            src={t.url}
            label={t.label}
            srcLang={t.lang || 'zh'}
          />
        ))}
      </video>

      {/* 字幕样式：使用 Monet 主题变量，字号可调、底色半透明 */}
      <style>{`
          video::cue {
            font-size: ${subtitles.subtitleFontSize}px;
            background-color: rgba(var(--md-sys-color-surface-container-rgb), var(--glass-strength));
            color: var(--md-sys-color-on-surface, #ffffff);
            text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
          }
        `}</style>

      {isResolving && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
          <Spinner size={32} />
          <Text className="text-sm">
            {resolvingMessage || '正在解析视频...'}
          </Text>
        </div>
      )}

      <VideoStatsMenu
        videoElement={videoElement}
        sourceType={
          watchTogether.sourceType === 'bilibili' ? 'bilibili' : 'custom'
        }
      />

      {!watchTogether.sourceUrl && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <div className="glass-strong flex h-20 w-20 items-center justify-center rounded-full">
            <Monitor
              className="h-10 w-10 opacity-70"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            />
          </div>
          <Text className="text-sm">
            {isHost ? '请在下方添加并播放影片' : '等待房主播放影片'}
          </Text>
        </div>
      )}

      {watchTogether.sourceUrl && (
        <>
          <DanmakuLayer
            ref={danmakuLayerRef}
            socket={socket}
            videoElement={videoElement}
            enabled={danmakuEnabled}
            opacity={style.opacity}
            displayArea={style.displayArea}
            density={style.advanced.density}
            speed={style.speed}
            scaleWithScreen={style.scaleWithScreen}
            filters={style.filters}
            advancedStyle={style.advanced}
            fontSize={style.fontSize}
          />
          <div className="absolute bottom-0 left-0 right-0 z-20">
            <VideoControls
              ref={videoControlsRef}
              video={videoElement}
              containerRef={videoContainerRef}
              isHost={isHost}
              sourceType={watchTogether.sourceType}
              onReloadBilibili={reloadBilibili}
              isDanmakuEnabled={danmakuEnabled}
              onToggleDanmaku={() => setDanmakuEnabled((prev) => !prev)}
              onSendDanmaku={(text) => {
                const trimmed = text.trim()
                if (!trimmed) return

                // 本地弹幕层即时显示，不依赖 socket 状态
                const item: BilibiliDanmakuItem = {
                  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  content: trimmed,
                  time: videoRef.current?.currentTime ?? 0,
                  mode: 1,
                  color: 16777215,
                  size: 25,
                }

                danmakuLayerRef.current?.addDanmaku(item)

                // socket 可用时再发送到聊天区
                if (!socket) return
                socket.emit(
                  'send-comment',
                  { roomId, content: trimmed, isDanmaku: true },
                  (response: { success: boolean; message?: string }) => {
                    if (!response.success) {
                      message.error(response.message ?? '弹幕发送失败')
                    }
                  }
                )
              }}
              onSync={() => {
                if (!isHost) return
                forceSync()
              }}
              isWebFullscreen={isWebFullscreen}
              onToggleWebFullscreen={() => setIsWebFullscreen((prev) => !prev)}
              subtitleEnabled={subtitles.subtitleEnabled}
              subtitleTracks={subtitles.subtitleTracks}
              activeTrackIndex={subtitles.activeTrackIndex}
              subtitleFontSize={subtitles.subtitleFontSize}
              onToggleSubtitles={subtitles.setEnabled}
              onSelectSubtitleTrack={subtitles.setActiveTrack}
              onAddSubtitleUrl={subtitles.addTrackFromUrl}
              onAddSubtitleFile={subtitles.addTrackFromFile}
              onChangeSubtitleFontSize={subtitles.setFontSize}
              danmakuStyle={style}
              onDanmakuStyleChange={setStyle}
              onDanmakuFilterChange={setFilters}
              onDanmakuAdvancedChange={setAdvancedStyle}
              onResetDanmakuStyle={resetStyle}
            />
          </div>
        </>
      )}
    </div>
  )

  return (
    <>
      {isWebFullscreen
        ? createPortal(videoContainer, document.body)
        : videoContainer}

      <ConfirmModal
        open={confirmJoin.open}
        onClose={() => setConfirmJoin({ open: false, viewerSocketId: '' })}
        onOk={handleApproveJoin}
        onCancel={handleRejectJoin}
        title="观看请求"
        okText="允许"
        cancelText="拒绝"
      >
        有观看者请求加入房间（{confirmJoin.viewerSocketId}），是否允许？
      </ConfirmModal>
    </>
  )
}
