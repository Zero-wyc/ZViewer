/**
 * 观众端分发器。
 *
 * 分离式架构：根据 roomMode + shareMethod 分发到不同子组件。
 * - watch-together → RoomLayout + WatchTogetherPanel（一起看模式）
 * - screen-share + stream-push → StreamPushViewer（OBS 推流拉流）
 * - screen-share + webrtc → WebrtcWatchPage（WebRTC 接收）
 *
 * 分发器职责：
 * 1. 加入房间流程（useJoinRoom）
 * 2. 子模式状态订阅（useStreamStatus / useShareMethod）
 * 3. 未加入时的 JoinRoomForm / 加载动画
 *
 * WebRTC 和 OBS 推流的业务逻辑互不感知，各自在子组件中独立实现。
 */
import { useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { CommentPanel } from '@/components/CommentPanel'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { usePlayerRemountKey } from '@/modules/room/watch-together/usePlayerRemountKey'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import {
  ListenTogetherPanel,
  MusicSearchPanel,
  MusicQueuePanel,
  MusicBetaNotice,
  MusicPlayerProvider,
  useMusicStore,
} from '@/modules/music'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useJoinRoom } from '../hooks/useJoinRoom'
import { useStreamStatus } from '../hooks/useStreamStatus'
import { useShareMethod } from '../hooks/useShareMethod'
import { JoinRoomForm } from './JoinRoomForm'
import StreamPushViewer from './StreamPushViewer'
import WebrtcWatchPage from './WebrtcWatchPage'
import type { JoinFormValues } from '../types'

function WatchPage() {
  const { roomId } = useParams<{ roomId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { socket, connected } = useSocket()

  // 从房间列表进入时携带的 state：{ fromList, hasPassword, name }
  // - hasPassword=true：显示密码输入框，不自动 requestJoin（避免空密码触发"密码错误"）
  // - hasPassword=false：显示加载动画，useJoinRoom 自动 requestJoin
  const navState = location.state as {
    fromList?: boolean
    hasPassword?: boolean
    name?: string | null
  } | null
  const fromList = navState?.fromList === true
  const listHasPassword = navState?.hasPassword === true
  const listRoomName = navState?.name ?? null

  const [isWebFullscreen, setIsWebFullscreen] = useState(false)

  // 1. 加入房间 hook
  // 分离式架构下不再需要 onApprovedScreenShare / onRoomModeChanged 创建 PC：
  // WebrtcWatchPage 挂载时自动 create PC，卸载时自动 cleanup PC。
  const { joinStatus, roomMode, requestJoin } = useJoinRoom({
    socket,
    roomId,
    connected,
    autoJoin: !(fromList && listHasPassword),
    onRoomClosed: (data) => {
      message.warning(`房间 ${data.roomId} 已关闭`)
      setTimeout(() => navigate('/room', { replace: true }), 1500)
    },
  })

  // 2. 推流子模式状态（仅 screen-share + stream-push 时使用）
  const streamStatus = useStreamStatus(socket, roomId ?? '')
  const { shareMethod } = useShareMethod(socket, roomId ?? '', false)
  const streamKey = useRoomStore((state) => state.streamKey)
  const exitRoom = useRoomStore((state) => state.exitRoom)
  const moderators = useRoomStore((state) => state.moderators)
  const currentUserId = useAuthStore((state) => state.user?.id)
  const username = useAuthStore((state) => state.user?.username)
  // 房管观众：可管理影片与成员（含语音），由服务器同步的 moderators 判定
  const isModerator =
    currentUserId != null && moderators.includes(Number(currentUserId))
  // Beta 功能开关：一起听模式渲染的门控（spec「Beta 门控」）
  const betaFeaturesEnabled = useSystemSettingsStore(
    (state) => state.betaFeaturesEnabled
  )
  // 一起听：当前播放曲目（队列面板高亮传入）
  const currentSongId = useMusicStore((state) => state.currentSongId)

  // 切换影片时强制整个播放器重挂载（与房主端一致，跨引擎切换彻底清理）
  const playerRemountKey = usePlayerRemountKey()

  // 3.1 已加入且 roomMode === 'watch-together'：观众使用与房主统一的 RoomLayout
  if (joinStatus === 'approved' && roomMode === 'watch-together') {
    return (
      <RoomLayout
        roomId={roomId ?? ''}
        isHost={false}
        mainContent={
          <WatchTogetherPanel
            key={playerRemountKey}
            roomId={roomId ?? ''}
            isHost={false}
            isWebFullscreen={isWebFullscreen}
            onToggleWebFullscreen={() => setIsWebFullscreen((prev) => !prev)}
          />
        }
        rightPanel={
          <CommentPanel
            socket={socket}
            roomId={roomId ?? ''}
            commentsOnly={false}
          />
        }
        controls={
          <>
            <RoomInfoPanel roomId={roomId ?? ''} isHost={false} />
            <MovieListPanel isHost={false} canManage={isModerator} />
            {isModerator && <MoviePushPanel isHost={isModerator} />}
          </>
        }
        controlLabels={
          isModerator
            ? ['房间状态', '影片列表', '添加影片']
            : ['房间状态', '影片列表']
        }
        webFullscreen={isWebFullscreen}
      />
    )
  }

  // 3.1b 已加入且 roomMode === 'listen-together'：一起听（Beta 门控）
  if (joinStatus === 'approved' && roomMode === 'listen-together') {
    // Beta 未开启：降级提示页，不渲染任何音乐 UI
    //（防御直接 URL / 管理员关闭开关后的存量房间场景）
    if (!betaFeaturesEnabled) {
      return <MusicBetaNotice />
    }
    return (
      // Provider 包裹整个布局，让侧栏队列面板与主播放器共享同一音频引擎
      //（ListenTogetherPanel 检测到外层实例后复用，不重复创建引擎）
      <MusicPlayerProvider
        socket={socket}
        roomId={roomId}
        isHost={false}
        username={username}
      >
        <RoomLayout
          roomId={roomId ?? ''}
          isHost={false}
          mainContent={
            <ListenTogetherPanel
              socket={socket}
              roomId={roomId ?? ''}
              isHost={false}
              username={username}
            />
          }
          rightPanel={
            <CommentPanel
              socket={socket}
              roomId={roomId ?? ''}
              commentsOnly={false}
            />
          }
          controls={
            <>
              <RoomInfoPanel roomId={roomId ?? ''} isHost={false} />
              {/* 观众可浏览搜索结果与队列；房管额外拥有添加/删除/排序权限 */}
              <MusicSearchPanel
                socket={socket}
                roomId={roomId}
                canManage={isModerator}
              />
              <MusicQueuePanel
                socket={socket}
                roomId={roomId}
                isHost={false}
                canManage={isModerator}
                currentSongId={currentSongId}
              />
            </>
          }
          controlLabels={['房间状态', '搜索歌曲', '播放队列']}
        />
      </MusicPlayerProvider>
    )
  }

  // 3.2 已加入且 roomMode === 'screen-share' + stream-push：OBS 推流拉流
  if (
    joinStatus === 'approved' &&
    roomMode === 'screen-share' &&
    shareMethod === 'stream-push'
  ) {
    return (
      <StreamPushViewer
        roomId={roomId ?? ''}
        streamKey={streamKey ?? roomId ?? ''}
        streamStatus={streamStatus}
      />
    )
  }

  // 3.3 已加入且 roomMode === 'screen-share' + webrtc：WebRTC 接收
  if (
    joinStatus === 'approved' &&
    roomMode === 'screen-share' &&
    shareMethod === 'webrtc'
  ) {
    return <WebrtcWatchPage roomId={roomId ?? ''} />
  }

  // 4. 未加入或加入失败：根据入口来源渲染不同 UI
  // - 从房间列表进入的无密码房间：显示加载动画（useJoinRoom 正在自动加入）
  // - 从房间列表进入的有密码房间：显示密码输入框（隐藏房间号）
  // - 其他情况（直接访问 URL）：显示完整的 JoinRoomForm
  if (
    fromList &&
    !listHasPassword &&
    (joinStatus === 'idle' || joinStatus === 'joining')
  ) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
        <Spinner tip="正在加入房间..." size={48} />
        {listRoomName && <Text type="secondary">正在加入：{listRoomName}</Text>}
      </div>
    )
  }

  const handleJoin = (values: JoinFormValues) => {
    if (!values.roomId.trim()) {
      message.warning('请输入房间号')
      return
    }
    const targetRoomId = values.roomId.trim()
    if (targetRoomId !== roomId) {
      navigate(`/room/${targetRoomId}`)
    } else {
      requestJoin(targetRoomId, values.password ?? '')
    }
  }

  return (
    <JoinRoomForm
      initialRoomId={roomId ?? ''}
      joinStatus={joinStatus}
      onSubmit={handleJoin}
      onBack={() => {
        exitRoom()
        navigate('/')
      }}
      hideRoomId={fromList && listHasPassword}
      roomName={
        fromList && listHasPassword ? (listRoomName ?? undefined) : undefined
      }
      passwordRequired={fromList && listHasPassword}
    />
  )
}

export default WatchPage
