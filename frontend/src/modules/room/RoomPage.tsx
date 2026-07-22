import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useRoomStore } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { RoomPanel } from '@/modules/room/components/RoomPanel'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import { CommentPanel } from '@/components/CommentPanel'
import { Spinner } from '@/components/ui/Spinner'
import { SharePage, WatchPage } from '@/modules/screen-sharing'
import type { MediaFormat } from '@/lib/mediaFormat'

import type { RoomMode } from '@/store/roomStore'

// sessionStorage key：标记当前用户是哪个房间的房主。
// 房主创建房间时写入，RoomPage 据此判断身份并走 register-host 流程。
// 刷新页面后仍可恢复身份，URL 无需携带 role/mode 参数。
const HOST_ROOM_KEY = 'zcontrol-host-room'

function isHostOfRoom(roomId: string): boolean {
  try {
    return sessionStorage.getItem(HOST_ROOM_KEY) === roomId
  } catch {
    return false
  }
}

function clearHostRoomMark(roomId: string) {
  try {
    if (sessionStorage.getItem(HOST_ROOM_KEY) === roomId) {
      sessionStorage.removeItem(HOST_ROOM_KEY)
    }
  } catch {
    // ignore
  }
}

function RoomPage() {
  const { roomId } = useParams<{ roomId?: string }>()
  // 身份判断：仅通过 sessionStorage 标记判断房主身份，URL 不再携带 role/mode 参数。
  // 房主创建房间时写入 sessionStorage，刷新后仍可识别；观众进入时 sessionStorage 无标记。
  const isHost = roomId ? isHostOfRoom(roomId) : false

  const storeMode = useRoomStore((state) => state.mode)
  const setMode = useRoomStore((state) => state.setMode)
  const setShareMethod = useRoomStore((state) => state.setShareMethod)
  const setStreamKey = useRoomStore((state) => state.setStreamKey)
  const setRoomId = useRoomStore((state) => state.setRoomId)
  const setRoomName = useRoomStore((state) => state.setRoomName)
  const resetRoomStore = useRoomStore((state) => state.reset)

  // 房主刷新/重连恢复时由后端返回的最近一次播放状态
  const [recoveredPlayback, setRecoveredPlayback] = useState<{
    currentTime: number
    isPlaying: boolean
    playbackRate: number
    duration?: number
    sourceUrl?: string
    sourceType?: string
    audioUrl?: string
    format?: MediaFormat
    videoCodec?: string
    audioCodec?: string
    cid?: number
    currentQn?: number
    acceptQuality?: { id: number; label: string; resolution?: string }[]
    currentMovieId?: number
    headers?: Record<string, string>
    updatedAt: number
  } | null>(null)
  // 房主 register-host 是否已完成回调。
  // 必须等待回调完成后再渲染 WatchTogetherPanel，确保 useWatchTogether 挂载时
  // initialPlayback 已可用，避免 fetchMovies/current-movie 先到达导致 loadMovie
  // effect 在 initialPlayback=null 时执行，从而丢失播放进度恢复。
  const [hostRegistered, setHostRegistered] = useState(false)

  // roomId 变化（包括从有值变为无值，即返回主页）或组件卸载时重置 roomStore，
  // 避免旧房间的 movies/currentMovieId/watchTogether 残留导致下次创建新房间时
  // useWatchTogether 加载旧影片，看起来像"进入旧房间"。
  const prevRoomIdRef = useRef(roomId)
  useEffect(() => {
    // roomId 变化时重置（不包括首次挂载）
    if (prevRoomIdRef.current !== roomId) {
      resetRoomStore()
      setHostRegistered(false)
      setRecoveredPlayback(null)
      prevRoomIdRef.current = roomId
    }
  }, [roomId, resetRoomStore])
  useEffect(() => {
    return () => {
      resetRoomStore()
    }
  }, [resetRoomStore])
  const { socket } = useSocket()
  const [hostPeerConnection, setHostPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const [isWebFullscreen, setIsWebFullscreen] = useState(false)

  // 将 URL 中的房间号同步到 store，确保刷新或直接访问房间链接时
  // MoviePushPanel 等依赖 store.roomId 的组件能正常工作。
  useEffect(() => {
    if (roomId) {
      setRoomId(roomId)
    }
  }, [roomId, setRoomId])

  // 房主刷新或重连后，重新声明房主身份以恢复 sharer 会话
  useEffect(() => {
    if (!isHost || !roomId || !socket) return

    const registerHost = () => {
      socket.emit(
        'register-host',
        { roomId },
        (response: {
          success: boolean
          message?: string
          data?: {
            mode?: RoomMode
            shareMethod?: 'webrtc' | 'stream-push'
            name?: string | null
            streamKey?: string | null
            playback?: {
              currentTime: number
              isPlaying: boolean
              playbackRate: number
              duration?: number
              sourceUrl?: string
              sourceType?: string
              audioUrl?: string
              format?: MediaFormat
              videoCodec?: string
              audioCodec?: string
              cid?: number
              currentQn?: number
              acceptQuality?: { id: number; label: string; resolution?: string }[]
              currentMovieId?: number
              headers?: Record<string, string>
              updatedAt: number
            }
          }
        }) => {
          if (!response?.success) {
            console.warn('[RoomPage] register-host failed:', response?.message)
            // 房主身份恢复失败（房间被关闭/被接管等）：清除本地标记，回退到观众流程
            clearHostRoomMark(roomId)
            // 即使失败也标记为已完成，避免 WatchTogetherPanel 永远不渲染
            setHostRegistered(true)
            return
          }
          // AckResponse 标准格式：业务数据在 data 字段内
          const data = response.data
          // 使用后端返回的房间真实模式，避免 store 默认值 screen-share 导致 UI 错误。
          // 模式不再写入 URL，由后端房间状态唯一确定。
          if (data?.mode) {
            setMode(data.mode)
          }
          if (data?.name) {
            setRoomName(data.name)
          }
          // 同步房间的 shareMethod（screen-share 子模式）
          if (data?.shareMethod) {
            setShareMethod(data.shareMethod)
          }
          // 同步推流密钥（stream-push 子模式使用）
          if (data?.streamKey !== undefined) {
            setStreamKey(data.streamKey)
          }
          // 房主刷新恢复：保存 playback 传给 WatchTogetherPanel 应用
          if (data?.playback) {
            setRecoveredPlayback(data.playback)
          }
          // 标记 register-host 已完成，WatchTogetherPanel 可以渲染
          // 必须在 setRecoveredPlayback 之后设置，确保渲染时 initialPlayback 已就绪
          setHostRegistered(true)
        }
      )
    }

    const handleRoomNameUpdated = (data: { roomId: string; name: string }) => {
      if (data.roomId === roomId) {
        setRoomName(data.name)
      }
    }

    if (socket.connected) {
      registerHost()
    }
    socket.on('connect', registerHost)
    socket.on('room-name-updated', handleRoomNameUpdated)
    return () => {
      socket.off('connect', registerHost)
      socket.off('room-name-updated', handleRoomNameUpdated)
    }
  }, [isHost, roomId, socket, setMode, setShareMethod, setStreamKey, setRoomName])

  const mode = storeMode

  // 无房间号时展示创建面板，让房主选择共享方案
  if (!roomId) {
    return <RoomPanel />
  }

  // 房主：使用 RoomLayout，根据模式渲染对应播放器
  if (isHost) {
    const mainContent =
      mode === 'watch-together' ? (
        // 等待 register-host 回调完成后再渲染 WatchTogetherPanel，
        // 确保 useWatchTogether 挂载时 initialPlayback 已可用，
        // 避免 fetchMovies/current-movie 先到达导致 loadMovie effect
        // 在 initialPlayback=null 时执行而丢失播放进度恢复。
        hostRegistered ? (
          <WatchTogetherPanel
            roomId={roomId}
            isHost
            isWebFullscreen={isWebFullscreen}
            onToggleWebFullscreen={() => setIsWebFullscreen((prev) => !prev)}
            initialPlayback={recoveredPlayback}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Spinner tip="正在恢复房间..." size={32} />
          </div>
        )
      ) : (
        <SharePage onStatsPeerConnectionChange={setHostPeerConnection} />
      )

    const controls =
      mode === 'screen-share' ? null : (
        <>
          <RoomInfoPanel roomId={roomId} isHost />
          <MovieListPanel isHost />
          <MoviePushPanel isHost />
        </>
      )

    return (
      <RoomLayout
        roomId={roomId}
        isHost
        mainContent={mainContent}
        rightPanel={
          <CommentPanel
            socket={socket}
            roomId={roomId}
            commentsOnly={mode === 'screen-share'}
          />
        }
        peerConnection={hostPeerConnection}
        controls={controls}
        webFullscreen={isWebFullscreen}
      />
    )
  }

  // 观众：统一由 WatchPage 处理加入与模式切换
  return <WatchPage />
}

export default RoomPage
