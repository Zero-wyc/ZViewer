import { useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useRoomStore } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { RoomPanel } from '@/modules/room/components/RoomPanel'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import { CommentPanel } from '@/components/CommentPanel'
import { SharePage, WatchPage } from '@/modules/room/screen-sharing'

// 房间模式类型扩展：包含 bili-compat（store 的 RoomMode 类型暂未更新，本地扩展）
type RoomMode = 'screen-share' | 'watch-together' | 'bili-compat'

function RoomPage() {
  const { roomId } = useParams<{ roomId?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const role = searchParams.get('role')
  const modeParam = searchParams.get('mode') as RoomMode | null
  const storeMode = useRoomStore((state) => state.mode) as RoomMode
  const setMode = useRoomStore((state) => state.setMode)
  const setRoomId = useRoomStore((state) => state.setRoomId)
  const setRoomName = useRoomStore((state) => state.setRoomName)
  const modeSyncedRef = useRef(false)
  const prevStoreModeRef = useRef(storeMode)
  const { socket } = useSocket()

  // 将 URL 中的房间号同步到 store，确保刷新或直接访问房间链接时
  // MoviePushPanel 等依赖 store.roomId 的组件能正常工作。
  useEffect(() => {
    if (roomId) {
      setRoomId(roomId)
    }
  }, [roomId, setRoomId])

  // 首次进入房间时，将 URL 中的 mode 同步到 store；
  // 同步完成后以 store/socket 实时状态为准，确保模式切换后 UI 正确跟随。
  useEffect(() => {
    if (modeParam) {
      // store.setMode 类型暂未包含 bili-compat，此处类型断言为兼容字段
      setMode(modeParam as 'screen-share' | 'watch-together')
    }
    modeSyncedRef.current = true
  }, [modeParam, setMode])

  // 模式切换后同步更新 URL，避免地址栏停留在旧 mode。
  // 通过 prevStoreModeRef 忽略首次同步导致的 storeMode 默认值，避免在 store
  // 尚未应用 URL mode 时就错误地把地址栏改写为默认模式。
  useEffect(() => {
    if (!modeSyncedRef.current) return
    if (prevStoreModeRef.current === storeMode) return
    prevStoreModeRef.current = storeMode
    if (modeParam === storeMode) return
    if (!roomId) return

    const next = new URLSearchParams(searchParams)
    next.set('mode', storeMode)
    setSearchParams(next, { replace: true })
  }, [storeMode, modeParam, roomId, searchParams, setSearchParams])

  // 房主刷新或重连后，重新声明房主身份以恢复 sharer 会话
  useEffect(() => {
    if (role !== 'host' || !roomId || !socket) return

    const registerHost = () => {
      socket.emit(
        'register-host',
        { roomId },
        (response: {
          success: boolean
          message?: string
          mode?: RoomMode
          name?: string | null
        }) => {
          if (!response?.success) {
            console.warn('[RoomPage] register-host failed:', response?.message)
            return
          }
          // 刷新后 roomStore 已重置为默认值，若 URL 未携带 mode，
          // 则使用后端返回的房间真实模式，避免默认回退到 screen-share。
          if (response.mode && !modeParam) {
            setMode(response.mode as 'screen-share' | 'watch-together')
            const next = new URLSearchParams(searchParams)
            next.set('mode', response.mode)
            setSearchParams(next, { replace: true })
          }
          if (response.name) {
            setRoomName(response.name)
          }
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
  }, [
    role,
    roomId,
    socket,
    modeParam,
    searchParams,
    setMode,
    setSearchParams,
    setRoomName,
  ])

  // eslint-disable-next-line react-hooks/refs
  const mode = modeSyncedRef.current ? storeMode : modeParam || storeMode

  // 无房间号时展示创建面板，让房主选择共享方案
  if (!roomId) {
    return <RoomPanel />
  }

  // 房主：使用 RoomLayout，根据模式渲染对应播放器；
  // bili-compat 模式由 RoomLayout 内部直接渲染 BiliCompatPlayer，mainContent 传 null
  if (role === 'host') {
    const mainContent =
      mode === 'watch-together' ? (
        <WatchTogetherPanel roomId={roomId} isHost />
      ) : mode === 'screen-share' ? (
        <SharePage />
      ) : null

    return (
      <RoomLayout
        roomId={roomId}
        isHost
        mainContent={mainContent}
        rightPanel={<CommentPanel socket={socket} roomId={roomId} />}
        controls={
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="glass-card min-w-0 overflow-hidden p-4">
              <RoomInfoPanel roomId={roomId} isHost />
            </div>
            <div className="glass-card min-w-0 overflow-hidden p-4">
              <MovieListPanel isHost />
            </div>
            <div className="glass-card min-w-0 overflow-hidden p-4">
              <MoviePushPanel isHost />
            </div>
          </div>
        }
      />
    )
  }

  // 观众：统一由 WatchPage 处理加入与模式切换
  return <WatchPage />
}

export default RoomPage
