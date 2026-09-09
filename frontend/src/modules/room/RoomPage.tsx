import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import { useRoomStore } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import { useDanmakuStore } from '@/store/danmakuStore'
import { setClientLoggerRoomId } from '@/lib/clientLogger'
import { useSocket } from '@/hooks/useSocket'
import { useHeaderCenterSlot } from '@/hooks/useHeaderCenterSlot'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import { VoiceChatPanel } from '@/modules/voice-chat'
import { TrafficPanel } from '@/modules/room/components/TrafficPanel'
import { RoomPanel } from '@/modules/room/components/RoomPanel'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { usePlayerRemountKey } from '@/modules/room/watch-together/usePlayerRemountKey'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomModeSwitchBar } from '@/modules/room/components/RoomLayout'
import { useRoomModeSwitch } from '@/modules/room/components/useRoomModeSwitch'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { RoomInfoFab } from '@/modules/room/components/RoomInfoFab'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import { CommentPanel } from '@/components/CommentPanel'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { SharePage, WatchPage } from '@/modules/screen-sharing'
import type { P2PStateSnapshot } from '@/modules/screen-sharing/components/WebrtcSharePage'
import type { MediaFormat } from '@/lib/mediaFormat'
import {
  MusicAppShell,
  MusicBetaNotice,
  MusicPlayerProvider,
} from '@/modules/music'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'

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
  const setActiveRoomId = useRoomStore((state) => state.setActiveRoomId)
  const setRoomSettings = useRoomStore((state) => state.setRoomSettings)
  const resetRoomStore = useRoomStore((state) => state.reset)
  const setDanmakuRoomId = useDanmakuStore((state) => state.setRoomId)
  const loadDanmakuTracks = useDanmakuStore((state) => state.loadTracks)
  const setDanmakuTracks = useDanmakuStore((state) => state.setTracks)
  const loadDanmakuMeta = useDanmakuStore((state) => state.loadMeta)
  const setDanmakuMeta = useDanmakuStore((state) => state.setMeta)

  // 切换影片时强制整个播放器重挂载（跨引擎切换时彻底清理旧引擎残留，
  // 避免复用同一 <video> 导致的卡死；首次加载不触发重挂载）
  const playerRemountKey = usePlayerRemountKey()

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

  // roomId 变化时重置 roomStore（不包括首次挂载）。
  // 注意：组件卸载时不再 resetRoomStore —— 保留房间状态用于"不离开房间"功能：
  // 用户导航到个人中心等页面时 RoomPage 卸载但房间状态保留，右上角显示"回到房间"入口。
  // 真正退出房间（点击返回按钮）由 RoomLayout/WatchPage 调用 exitRoom() 清除状态。
  const prevRoomIdRef = useRef(roomId)
  useEffect(() => {
    if (prevRoomIdRef.current !== roomId) {
      resetRoomStore()
      setDanmakuRoomId(roomId ?? null)
      setDanmakuTracks([])
      // 重置弹幕辅助数据，避免上个房间的屏蔽词/已删除/实时弹幕记录残留
      setDanmakuMeta({
        blockKeywords: [],
        deletedLog: [],
        realtimeLog: [],
      })
      setHostRegistered(false)
      setRecoveredPlayback(null)
      prevRoomIdRef.current = roomId
    }
  }, [
    roomId,
    resetRoomStore,
    setDanmakuRoomId,
    setDanmakuTracks,
    setDanmakuMeta,
  ])
  const { socket } = useSocket()
  // 房间模式切换（房主 emit + ack/超时/断线兜底）：状态上移到页面级；
  // 滑块统一经 useHeaderCenterSlot portal 注入全局 Header 中央槽位（最顶部栏），
  // 所有模式（一起看/投屏/一起听）共用同一份状态与同一渲染位置
  const { isModeSwitching, handleSwitchMode } = useRoomModeSwitch(
    socket,
    roomId ?? '',
    isHost
  )
  // 全局 Header 中央槽位（fixed 最顶部栏）：模式切换滑块的注入点
  const headerCenterSlot = useHeaderCenterSlot()
  // 退出守卫：一起听底板化后无 RoomLayout 顶栏返回按钮，返回改由音乐顶导航
  // 承担（guardNavigate 在房间内弹出确认）；其他模式仍用 RoomLayout 内置守卫
  const { guardNavigate, confirmModal: exitGuardModal } = useRoomExitGuard()
  const username = useAuthStore((state) => state.user?.username)
  const currentUserId = useAuthStore((state) => state.user?.id)
  const moderators = useRoomStore((state) => state.moderators)
  // 房管观众：可管理影片与成员（含语音），后端同步的 moderators 列表判定
  const isModerator =
    currentUserId != null && moderators.includes(Number(currentUserId))
  // Beta 功能开关：一起听模式入口与渲染的门控（spec「Beta 门控」）
  const betaFeaturesEnabled = useSystemSettingsStore(
    (state) => state.betaFeaturesEnabled
  )
  const [hostPeerConnection, setHostPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const [isWebFullscreen, setIsWebFullscreen] = useState(false)
  // 房主 P2P 状态（由 WebrtcSharePage 提升）
  const [p2pState, setP2pState] = useState<P2PStateSnapshot>({
    enabled: false,
    pc: null,
    status: 'idle',
    fallbackNotice: false,
    toggle: () => {},
  })

  // 将 URL 中的房间号同步到 store，确保刷新或直接访问房间链接时
  // MoviePushPanel 等依赖 store.roomId 的组件能正常工作。
  // 同时设置 activeRoomId，用于"不离开房间"功能：导航到其他页面时保留房间标记。
  useEffect(() => {
    if (!roomId) return
    // 进入与当前活跃房间不同的房间（切换/创建新房间）时，先真正释放旧房间：
    // 若用户是旧房间的房主，此时才 emit host-leave（房间进入 10 分钟宽限期）。
    // 「主动离开房间」不再释放——离开后房间保持运行，可从右上角按钮返回。
    const prevActive = useRoomStore.getState().activeRoomId
    if (prevActive && prevActive !== roomId && isHostOfRoom(prevActive)) {
      socket?.emit('host-leave', () => {
        /* ack */
      })
    }
    setRoomId(roomId)
    setActiveRoomId(roomId)
    setClientLoggerRoomId(roomId)
    setDanmakuRoomId(roomId)
    void loadDanmakuTracks(roomId)
    void loadDanmakuMeta(roomId)
  }, [
    roomId,
    socket,
    setRoomId,
    setActiveRoomId,
    setDanmakuRoomId,
    loadDanmakuTracks,
    loadDanmakuMeta,
  ])

  // 组件卸载或 roomId 变化时清除日志上报中的房间标记
  useEffect(() => {
    return () => {
      setClientLoggerRoomId(null)
    }
  }, [])

  // 监听后端广播的弹幕轨道同步事件（房主/观众均需要）
  useEffect(() => {
    if (!roomId || !socket) return

    const handleDanmakuTracksUpdated = (data: {
      roomId: string
      tracks: Parameters<typeof setDanmakuTracks>[0]
    }) => {
      if (data.roomId === roomId) {
        setDanmakuTracks(data.tracks)
      }
    }

    socket.on('danmaku-tracks-updated', handleDanmakuTracksUpdated)
    return () => {
      socket.off('danmaku-tracks-updated', handleDanmakuTracksUpdated)
    }
  }, [roomId, socket, setDanmakuTracks])

  // 监听后端广播的弹幕辅助数据同步事件（屏蔽词/已删除/实时弹幕记录）
  useEffect(() => {
    if (!roomId || !socket) return

    const handleDanmakuMetaUpdated = (data: {
      roomId: string
      meta: Parameters<typeof setDanmakuMeta>[0]
    }) => {
      if (data.roomId === roomId) {
        setDanmakuMeta(data.meta)
      }
    }

    socket.on('danmaku-meta-updated', handleDanmakuMetaUpdated)
    return () => {
      socket.off('danmaku-meta-updated', handleDanmakuMetaUpdated)
    }
  }, [roomId, socket, setDanmakuMeta])

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
          code?: string
          data?: {
            mode?: RoomMode
            shareMethod?: 'webrtc' | 'stream-push'
            name?: string | null
            streamKey?: string | null
            requireApproval?: boolean
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
              acceptQuality?: {
                id: number
                label: string
                resolution?: string
              }[]
              currentMovieId?: number
              headers?: Record<string, string>
              updatedAt: number
            }
          }
        }) => {
          if (!response?.success) {
            console.warn('[RoomPage] register-host failed:', response?.message)
            // 同一账户已在另一个标签页进入此房间：显示提示并返回首页
            if (response?.code === 'ALREADY_IN_ROOM') {
              message.error(response.message ?? '该账户已在此房间内')
              setTimeout(() => {
                window.location.href = '/'
              }, 2000)
              return
            }
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
          // 同步 requireApproval 到 store：房主刷新/重连后 RoomInfoPanel 显示
          // 必须与后端实际值一致，否则房主看到的开关状态与后端审批逻辑不符，
          // 观众加入时后端按真实值判定，房主却以为开关已开/关，导致"开关无效"假象。
          if (data?.requireApproval !== undefined) {
            setRoomSettings({ requireApproval: data.requireApproval })
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
  }, [
    isHost,
    roomId,
    socket,
    setMode,
    setShareMethod,
    setStreamKey,
    setRoomName,
    setRoomSettings,
  ])

  const mode = storeMode

  // 无房间号时展示创建面板，让房主选择共享方案
  if (!roomId) {
    return <RoomPanel />
  }

  const voiceChatPanel = (
    <VoiceChatPanel
      socket={socket}
      roomId={roomId}
      username={username}
      isHost={isHost}
      canManageVoice={isHost || isModerator}
    />
  )

  // 左下角流量统计（本机 HTTP 流量；root 额外展示服务端网卡流量）。
  // 一起听模式：房间状态面板不在下方控制卡片行，改为悬浮按钮
  // （经 topSlot 渲染在流量按钮上方，房主/观众两侧共用本定义）
  const trafficPanel = (
    <TrafficPanel
      topSlot={
        mode === 'listen-together' ? (
          <RoomInfoFab roomId={roomId} isHost={isHost} />
        ) : undefined
      }
    />
  )

  // 房主：使用 RoomLayout，根据模式渲染对应播放器
  if (isHost) {
    // 一起听模式：Beta 未开启时降级为提示页（仍套 RoomLayout，顶栏滑块可切回
    // 其他模式）；Beta 开启时 MusicAppShell 作为整页底板直接渲染（见下方分支）。
    //（创建入口已由 RoomPanel 门控隐藏，此处防御直接 URL / 关闭开关后的存量房间）
    const isListenTogether = mode === 'listen-together'
    const musicBetaClosed = isListenTogether && !betaFeaturesEnabled

    // 模式切换滑块 → 全局 Header 中央槽位（fixed 最顶部栏，所有模式统一位置）
    const modeSwitchPortal =
      headerCenterSlot != null
        ? createPortal(
            <RoomModeSwitchBar
              isHost
              onSwitch={handleSwitchMode}
              isSwitching={isModeSwitching}
            />,
            headerCenterSlot
          )
        : null

    // 一起听（Beta 开启）：Hydrogen 应用框架升级为整页底板——不再套 RoomLayout
    // 外框（玻璃卡片 + 顶部工具栏），语音/流量悬浮面板照常叠加；返回改由音乐
    // 顶导航按钮承担（房间内弹出确认后离开）
    if (isListenTogether && !musicBetaClosed) {
      return (
        <>
          {/* Provider 包裹底板与完整播放器覆盖层，共享同一音频引擎 */}
          <MusicPlayerProvider
            socket={socket}
            roomId={roomId}
            isHost
            username={username}
          >
            <MusicAppShell
              socket={socket}
              roomId={roomId}
              isHost
              username={username}
              // 房主天然拥有队列管理权限（添加/切歌/删除）
              canManage
              isModeSwitching={isModeSwitching}
              onBack={() => guardNavigate('/')}
            />
            {exitGuardModal}
          </MusicPlayerProvider>
          {modeSwitchPortal}
          {voiceChatPanel}
          {trafficPanel}
        </>
      )
    }

    const mainContent =
      mode === 'watch-together' ? (
        // 等待 register-host 回调完成后再渲染 WatchTogetherPanel，
        // 确保 useWatchTogether 挂载时 initialPlayback 已可用，
        // 避免 fetchMovies/current-movie 先到达导致 loadMovie effect
        // 在 initialPlayback=null 时执行而丢失播放进度恢复。
        hostRegistered ? (
          <WatchTogetherPanel
            key={playerRemountKey}
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
      ) : isListenTogether ? (
        // 一起听 Beta 关闭：降级提示页（RoomLayout 顶栏滑块可切回其他模式）
        <MusicBetaNotice />
      ) : (
        <SharePage
          onStatsPeerConnectionChange={setHostPeerConnection}
          onP2PStateChange={setP2pState}
        />
      )

    const controls =
      mode === 'screen-share' ? (
        <RoomInfoPanel roomId={roomId} isHost />
      ) : isListenTogether ? undefined : ( // 房间状态改为左下角悬浮按钮（见 trafficPanel 的 topSlot） // 一起听：搜索/队列面板已并入主区域框架（顶部导航 + widget 队列弹窗），
        <>
          <RoomInfoPanel roomId={roomId} isHost />
          <MovieListPanel isHost />
          <MoviePushPanel isHost />
        </>
      )

    const controlLabels =
      mode === 'screen-share'
        ? ['房间状态']
        : isListenTogether
          ? // 一起听：下方无控制卡片行
            undefined
          : ['房间状态', '影片列表', '添加影片']

    const roomLayout = (
      <RoomLayout
        mainContent={mainContent}
        rightPanel={
          <CommentPanel
            socket={socket}
            roomId={roomId}
            commentsOnly={mode === 'screen-share'}
          />
        }
        peerConnection={hostPeerConnection}
        p2pEnabled={p2pState.enabled}
        p2pPC={p2pState.pc}
        p2pStatus={p2pState.status}
        p2pFallbackNotice={p2pState.fallbackNotice}
        onToggleP2P={p2pState.toggle}
        controls={controls}
        controlLabels={controlLabels}
        webFullscreen={isWebFullscreen}
        isModeSwitching={isModeSwitching}
      />
    )

    // 到达此处的听模式只剩 Beta 关闭降级（提示页，不依赖音乐引擎），无需 Provider
    return (
      <>
        {modeSwitchPortal}
        {roomLayout}
        {voiceChatPanel}
        {trafficPanel}
      </>
    )
  }

  // 观众：统一由 WatchPage 处理加入与模式切换
  return (
    <>
      <WatchPage />
      {voiceChatPanel}
      {trafficPanel}
    </>
  )
}

export default RoomPage
