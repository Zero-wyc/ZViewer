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
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { useParams } from 'react-router-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Text } from '@/components/ui/Typography'
import { LoadingLine } from '@/components/ui/LoadingLine'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { CommentPanel } from '@/components/CommentPanel'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomDisplayName } from './hooks/useRoomDisplayName'
import { useDanmakuStore } from '@/store/danmakuStore'
import { t } from '@/i18n'

type JoinState = 'connecting' | 'ready' | 'need-password' | 'closed' | 'error'

export default function CommentsWindowPage() {
  const { roomId = '' } = useParams<{ roomId: string }>()
  const { socket } = useSocket()
  // 本窗口是独立页面，必须自己把「房间内昵称」同步给服务端，
  // 否则这里发出的评论会退化成账号名（评论名要显示房间内设置的名字）。
  const { name: roomDisplayName } = useRoomDisplayName(roomId)
  const pushedDisplayNameRef = useRef('')
  useEffect(() => {
    if (!socket || !roomId) return undefined
    const push = (force = false) => {
      if (!roomDisplayName) return
      if (!force && pushedDisplayNameRef.current === roomDisplayName) return
      pushedDisplayNameRef.current = roomDisplayName
      socket.emit('set-display-name', { roomId, name: roomDisplayName })
    }
    push()
    // 重连后 socket.data 已重置，需要重新同步
    const onConnect = () => push(true)
    socket.on('connect', onConnect)
    return () => {
      socket.off('connect', onConnect)
    }
  }, [socket, roomId, roomDisplayName])
  const [joinState, setJoinState] = useState<JoinState>('connecting')
  const [errorMsg, setErrorMsg] = useState('')
  const [password, setPassword] = useState('')

  // 桌面端独立窗口：壳程序用 iframe 加载本页（后端拼的 URL 带 desktopWindow=1），
  // 此时页面要透出桌面背景，并把自己的鼠标活动/关闭动作转给外壳。
  const isDesktopWindow =
    new URLSearchParams(window.location.search).get('desktopWindow') === '1'
  // 真的被壳用 iframe 嵌着才启用歌词式行为：地址栏手敲参数打开时保持普通布局
  const isEmbedded = isDesktopWindow && window.parent !== window
  /**
   * 外壳（桌面歌词式窗口）下发的文字样式与悬停状态。
   *
   * 页面只负责文字本身：背景透明度由外壳的「背景」滑杆控制（见
   * desktop/ui/comments-window.js）。因此这里把卡片底色置空、文字颜色与
   * 描边换成外壳选的值，鼠标移开时收起发送区，只留评论内容。
   */
  const [lyricsStyle, setLyricsStyle] = useState<CSSProperties>({})
  const [hovered, setHovered] = useState(false)

  useEffect(() => {
    if (!isEmbedded) return undefined
    const onMessage = (event: MessageEvent) => {
      // 只认外壳（父窗口）发来的消息：页面里任何 iframe/广告都可能是别的来源
      if (event.source !== window.parent) return
      const data = event.data as {
        type?: string
        color?: string
        shadow?: string
        hover?: boolean
      } | null
      if (!data || typeof data.type !== 'string') return
      if (data.type === 'zviewer:lyrics-style') {
        const color = typeof data.color === 'string' ? data.color : ''
        if (!color) return
        setLyricsStyle({
          '--md-sys-color-on-surface': color,
          '--md-sys-color-on-surface-variant': color,
          // 卡片底色交给外壳的透明度滑杆，页面不再叠一层不透明背景
          '--glass-bg': 'transparent',
          textShadow: data.shadow,
        } as CSSProperties)
        return
      }
      if (data.type === 'zviewer:lyrics-hover') {
        setHovered(data.hover === true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [isEmbedded])

  useEffect(() => {
    if (!isEmbedded) return undefined
    let lastSent = 0
    const post = (hover: boolean) => {
      try {
        window.parent.postMessage(
          { type: 'zviewer:lyrics-pointer', hover },
          '*'
        )
      } catch {
        // 外壳未就绪，忽略
      }
    }
    // 鼠标在页面内移动即通知外壳展开工具条（限频 1s，避免高频 postMessage）；
    // 指针移出页面则通知外壳开始倒计时自动隐藏。
    const onMove = () => {
      const now = Date.now()
      if (now - lastSent < 1000) return
      lastSent = now
      post(true)
    }
    const onLeave = () => post(false)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)
    window.addEventListener('blur', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      window.removeEventListener('blur', onLeave)
    }
  }, [isEmbedded])

  const closeWindow = useCallback(() => {
    try {
      window.parent.postMessage({ type: 'zviewer:comments-close' }, '*')
    } catch {
      // 忽略
    }
    // 外壳未响应时兜底（例如普通浏览器里手改 URL 带参数打开）
    window.setTimeout(() => window.close(), 300)
  }, [])

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
          setErrorMsg(response.message ?? t('加入失败'))
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
        setErrorMsg(t('连接服务器超时,请刷新重试'))
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
        message.warning(t('房间 {{roomId}} 已关闭', { roomId }))
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
    <div
      className={cn(
        'relative flex h-[100dvh] flex-col overflow-hidden',
        isDesktopWindow
          ? 'bg-transparent'
          : 'bg-[var(--md-sys-color-surface)] p-2'
      )}
      style={isEmbedded ? lyricsStyle : undefined}
    >
      {/* 桌面独立窗口无系统边框，页面自己提供关闭入口（外壳收到消息后关窗） */}
      {isDesktopWindow && (
        <button
          type="button"
          aria-label={t('关闭')}
          title={t('关闭')}
          onClick={closeWindow}
          className="absolute right-1.5 top-1.5 z-10 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white/90 opacity-60 backdrop-blur-sm transition-opacity hover:opacity-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {joinState === 'ready' && socket && roomId ? (
        <div className="flex min-h-0 flex-1 flex-col [&_.glass-card]:h-full [&_.glass-card]:flex-1">
          <CommentPanel
            socket={socket}
            roomId={roomId}
            floating={isEmbedded}
            composerHidden={isEmbedded && !hovered}
          />
        </div>
      ) : joinState === 'connecting' ? (
        <LoadingLine
          text={t('正在加入房间…')}
          spinnerClassName="h-6 w-6 text-[var(--md-sys-color-primary)]"
          className="h-auto flex-1"
        />
      ) : joinState === 'need-password' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
          <Text className="text-sm font-medium">{t('该房间已设密码')}</Text>
          <div className="flex w-full max-w-xs flex-col gap-2">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t('房间密码')}
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
              {t('加入')}
            </Button>
          </div>
        </div>
      ) : joinState === 'closed' ? (
        <div className="flex flex-1 items-center justify-center">
          <Text type="secondary" className="text-sm">
            {t('房间已关闭,可关闭此窗口')}
          </Text>
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <Text className="text-sm">{errorMsg || t('加入失败')}</Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setJoinState('connecting')
              attemptJoin()
            }}
          >
            {t('重试')}
          </Button>
        </div>
      )}
    </div>
  )
}
