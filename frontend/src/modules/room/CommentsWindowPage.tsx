/**
 * 评论独立窗口页面(/room/:roomId/comments-window)。
 *
 * 由主窗口 CommentPanel 右下角的「独立窗口」按钮 window.open 打开,
 * 用于把「弹幕轨道 / 评论区 / 实时弹幕」面板放到副屏或独立小窗,
 * 主窗口继续看片。
 *
 * - 轻量加入:走 join-room-panel 事件(豁免重复加入限制,与主窗口并存;
 *   密码房间需在窗口内输入一次密码),仅注册 viewer session 供评论/弹幕
 *   事件的 isInRoom 校验通过
 * - 数据:评论区走 socket 事件(CommentPanel 自带历史拉取);弹幕轨道/
 *   实时弹幕先经 danmakuStore.loadTracks/loadMeta HTTP 拉快照,再监听
 *   danmaku-tracks-updated / danmaku-meta-updated 增量同步(与 RoomPage 同款)
 * - 布局极简:仅标题行 + 面板本体,适配独立小窗
 */
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Text } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { CommentPanel } from '@/components/CommentPanel'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useDanmakuStore } from '@/store/danmakuStore'

type JoinState = 'connecting' | 'ready' | 'need-password' | 'closed' | 'error'

export default function CommentsWindowPage() {
  const { roomId = '' } = useParams<{ roomId: string }>()
  const { socket } = useSocket()
  const [joinState, setJoinState] = useState<JoinState>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [password, setPassword] = useState('')

  const setDanmakuTracks = useDanmakuStore((state) => state.setTracks)
  const setDanmakuMeta = useDanmakuStore((state) => state.setMeta)

  const attemptJoin = useCallback(
    (pwd?: string) => {
      if (!socket || !roomId) return
      socket.emit(
        'join-room-panel',
        { roomId, password: pwd },
        (response: { success: boolean; code?: string; message?: string }) => {
          if (response.success) {
            setJoinState('ready')
            return
          }
          if (response.code === 'NEED_PASSWORD') {
            setJoinState('need-password')
            return
          }
          if (response.message === '房间已关闭') {
            setJoinState('closed')
            return
          }
          setJoinState('error')
          setErrorMsg(response.message ?? '加入失败')
        }
      )
    },
    [socket, roomId]
  )

  // socket 连接后发起 join-panel:未连接时等 connect 事件(带重试上限)
  useEffect(() => {
    if (!socket || !roomId) return
    let retries = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const tryJoin = () => {
      if (socket.connected) {
        attemptJoin()
      } else if (retries < 10) {
        retries++
        retryTimer = setTimeout(tryJoin, 500)
      } else {
        setJoinState('error')
        setErrorMsg('连接服务器超时,请刷新重试')
      }
    }
    tryJoin()

    const onReconnect = () => attemptJoin()
    socket.on('connect', onReconnect)
    return () => {
      socket.off('connect', onReconnect)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [socket, roomId, attemptJoin])

  // 房间关闭:提示并停在关闭态
  useEffect(() => {
    if (!socket || !roomId || joinState !== 'ready') return
    const handleRoomClosed = (data: { roomId: string }) => {
      if (data.roomId === roomId) {
        setJoinState('closed')
        message.warning(`房间 ${roomId} 已关闭`)
      }
    }
    socket.on('room-closed', handleRoomClosed)
    return () => {
      socket.off('room-closed', handleRoomClosed)
    }
  }, [socket, roomId, joinState])

  // 弹幕轨道 / 实时弹幕数据:HTTP 快照 + socket 增量(与 RoomPage 同款)
  useEffect(() => {
    if (joinState !== 'ready' || !roomId) return
    void useDanmakuStore.getState().loadTracks(roomId)
    void useDanmakuStore.getState().loadMeta(roomId)

    const handleTracksUpdated = (data: {
      roomId: string
      tracks: Parameters<typeof setDanmakuTracks>[0]
    }) => {
      if (data.roomId === roomId) setDanmakuTracks(data.tracks)
    }
    const handleMetaUpdated = (data: {
      roomId: string
      meta: Parameters<typeof setDanmakuMeta>[0]
    }) => {
      if (data.roomId === roomId) setDanmakuMeta(data.meta)
    }

    socket?.on('danmaku-tracks-updated', handleTracksUpdated)
    socket?.on('danmaku-meta-updated', handleMetaUpdated)
    return () => {
      socket?.off('danmaku-tracks-updated', handleTracksUpdated)
      socket?.off('danmaku-meta-updated', handleMetaUpdated)
    }
  }, [joinState, roomId, socket, setDanmakuTracks, setDanmakuMeta])

  return (
    <div className="flex h-[100dvh] flex-col gap-2.5 overflow-hidden bg-[var(--md-sys-color-surface)] px-3 py-3">
      <div className="flex shrink-0 items-center justify-between px-1">
        <Text className="text-sm font-semibold">房间 {roomId} · 评论</Text>
        <Text type="secondary" className="text-[10px]">
          独立窗口
        </Text>
      </div>

      {joinState === 'ready' && socket && roomId ? (
        <div className="flex min-h-0 flex-1 flex-col [&_.glass-card]:flex-1">
          <CommentPanel socket={socket} roomId={roomId} />
        </div>
      ) : joinState === 'connecting' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--md-sys-color-primary)]" />
          <Text type="secondary" className="text-xs">
            正在加入房间…
          </Text>
        </div>
      ) : joinState === 'need-password' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <Text className="text-sm font-medium">该房间已设密码</Text>
          <div className="flex w-full max-w-xs flex-col gap-2">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="房间密码"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && password) attemptJoin(password)
              }}
            />
            <Button
              variant="primary"
              block
              disabled={!password}
              onClick={() => attemptJoin(password)}
            >
              加入
            </Button>
          </div>
        </div>
      ) : joinState === 'closed' ? (
        <div className="flex flex-1 items-center justify-center">
          <Text type="secondary" className="text-sm">
            房间已关闭,可关闭此窗口
          </Text>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Text className="text-sm">{errorMsg || '加入失败'}</Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setJoinState('connecting')
              attemptJoin()
            }}
          >
            重试
          </Button>
        </div>
      )}
    </div>
  )
}
