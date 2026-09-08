/**
 * 音乐播放器 Context Provider。
 *
 * 让侧栏面板（队列切歌等）与主播放器共享同一份 useListenTogether 实例
 * （单一音频引擎 + 同一 socket 监听）。由 ListenTogetherPanel 挂载；
 * MusicQueuePanel 等经 useMusicPlayer()（../hooks/useMusicPlayer）消费。
 */
import type { Socket } from 'socket.io-client'
import { useListenTogether } from './hooks/useListenTogether'
import { useMusicStore } from './store'
import { MusicPlayerContext } from './hooks/useMusicPlayer'
import type { MusicPlayerContextValue } from './hooks/useMusicPlayer'

export interface MusicPlayerProviderProps {
  socket: Socket | null
  roomId: string | undefined
  /** 是否为房主（房主为同步源：直接控制 + 广播 + 心跳） */
  isHost: boolean
  /** 当前用户名（观众申请控制时随请求发送） */
  username?: string
  children: React.ReactNode
}

/**
 * 持有 useListenTogether 的全部返回值 + 实时播放状态。
 *
 * positionSec / isPlaying / playMode 来自 music store 镜像
 * （useListenTogether 内部由 audio timeupdate/play/pause 事件维护），
 * 无需额外的 rAF/interval 轮询。
 */
export function MusicPlayerProvider({
  socket,
  roomId,
  isHost,
  username,
  children,
}: MusicPlayerProviderProps) {
  const player = useListenTogether({ socket, roomId, isHost, username })
  const positionSec = useMusicStore((s) => s.positionSec)
  const isPlaying = useMusicStore((s) => s.isPlaying)
  const playMode = useMusicStore((s) => s.playMode)

  const value: MusicPlayerContextValue = {
    ...player,
    positionSec,
    isPlaying,
    playMode,
  }

  return (
    <MusicPlayerContext.Provider value={value}>
      {children}
    </MusicPlayerContext.Provider>
  )
}
