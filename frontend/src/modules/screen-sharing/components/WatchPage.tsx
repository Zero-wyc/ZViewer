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
import {
  RoomLayout,
  RoomModeSwitchBar,
} from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import {
  MusicAppShell,
  MusicBetaNotice,
  MusicPlayerProvider,
} from '@/modules/music'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
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

  // 切换影片时强制整个播放器重挂载（与房主端一致，跨引擎切换彻底清理）
  const playerRemountKey = usePlayerRemountKey()

  // 退出守卫：一起听底板化后无 RoomLayout 顶栏返回按钮，返回改由音乐顶导航
  // 承担（guardNavigate 在房间内弹出确认）；其他模式仍用 RoomLayout 内置守卫
  const { guardNavigate, confirmModal: exitGuardModal } = useRoomExitGuard()

  // 3.1 已加入且 roomMode === 'watch-together'：观众使用与房主统一的 RoomLayout
  if (joinStatus === 'approved' && roomMode === 'watch-together') {
    return (
      <RoomLayout
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
      // 一起听：Hydrogen 应用框架作为整页底板，不再套 RoomLayout 外框；
      // Provider 包裹底板与完整播放器覆盖层，共享同一音频引擎；
      // 返回改由音乐顶导航按钮承担（房间内弹出确认后离开）
      <MusicPlayerProvider
        socket={socket}
        roomId={roomId}
        isHost={false}
        username={username}
      >
        <MusicAppShell
          socket={socket}
          roomId={roomId ?? ''}
          isHost={false}
          username={username}
          // 房管观众可管理队列（添加/删除），普通观众仅浏览
          canManage={isModerator}
          // 当前模式标签注入音乐顶导航（与房主滑块位置一致）
          topNavExtra={<RoomModeSwitchBar isHost={false} />}
          onBack={() => guardNavigate('/')}
        />
        {exitGuardModal}
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
