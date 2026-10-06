import { useEffect, useRef, useState } from 'react'
import { Send, MessageSquareQuote, MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Space } from '@/components/ui/Space'
import { Switch } from '@/components/ui/Switch'
import { Text } from '@/components/ui/Typography'
import { Avatar } from '@/components/ui/Avatar'
import { message } from '@/components/ui/message'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { useAuthStore } from '@/store/authStore'
import { useRoomStore } from '@/store/roomStore'
import { cn, formatIsoTime } from '@/lib/utils'
import type { Socket } from 'socket.io-client'
import { DanmakuTrackCard } from '@/modules/room/watch-together/DanmakuTrackCard'
import { RealtimeDanmakuCard } from '@/modules/room/watch-together/RealtimeDanmakuCard'

export interface CommentItem {
  id: number
  roomId: string
  username: string
  content: string
  isDanmaku: boolean
  createdAt: string
}

interface CommentPanelProps {
  socket: Socket | null
  roomId: string
  /**
   * 仅显示评论区（隐藏弹幕轨道 / 实时弹幕 Tab）。
   * 投屏模式下弹幕轨道与实时弹幕无意义，仅 watch-together 模式启用。
   */
  commentsOnly?: boolean
  /**
   * 是否显示「以弹幕形式发送」开关（默认 true，保持投屏场景行为）。
   * 一起听等无视频画面的场景传 false——弹幕没有渲染层，发了也无人可见。
   */
  allowDanmaku?: boolean
}

interface SendCommentResponse {
  success: boolean
  message?: string
}

interface CommentHistoryResponse {
  success: boolean
  comments?: CommentItem[]
  message?: string
}

function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase()
}

export function CommentPanel({
  socket,
  roomId,
  commentsOnly = false,
  allowDanmaku = true,
}: CommentPanelProps) {
  const currentUser = useAuthStore((state) => state.user)
  // 读取 watch-together 模式下的当前播放进度，用于 send-danmaku 持久化实时弹幕记录
  // screen-share 模式下 currentTime 始终为 0，无影响
  const videoCurrentTime = useRoomStore(
    (state) => state.watchTogether.currentTime
  )
  const [comments, setComments] = useState<CommentItem[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [sendAsDanmaku, setSendAsDanmaku] = useState(false)
  const [rightPanelTab, setRightPanelTab] = useState<
    'comments' | 'tracks' | 'realtime'
  >('comments')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!socket || !roomId) return

    const handleNewComment = (comment: CommentItem) => {
      setComments((prev) => {
        if (prev.some((c) => c.id === comment.id)) return prev
        return [...prev, comment]
      })
    }

    socket.on('new-comment', handleNewComment)

    // 请求评论历史，带重试机制。
    // socket 连接后可能还没 join room（isInRoom 校验失败），延迟重试直到成功。
    let retryCount = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const fetchHistory = () => {
      socket.emit(
        'comment-history',
        { roomId },
        (response: CommentHistoryResponse) => {
          if (response.success && response.comments) {
            setComments(response.comments)
          } else if (retryCount < 5) {
            retryCount++
            retryTimer = setTimeout(fetchHistory, 800)
          }
        }
      )
    }

    // socket 已连接时立即请求，否则等 connect 事件
    if (socket.connected) {
      fetchHistory()
    } else {
      const onConnect = () => fetchHistory()
      socket.on('connect', onConnect)
      return () => {
        socket.off('new-comment', handleNewComment)
        socket.off('connect', onConnect)
        if (retryTimer) clearTimeout(retryTimer)
      }
    }

    return () => {
      socket.off('new-comment', handleNewComment)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [socket, roomId])

  useEffect(() => {
    const list = listRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [comments])

  const handleSend = (asDanmaku = false) => {
    if (!socket || !roomId) return
    const content = input.trim()
    if (!content) {
      message.warning('请输入评论内容')
      return
    }

    setSending(true)
    socket.emit(
      'send-comment',
      { roomId, content, isDanmaku: asDanmaku },
      (response: SendCommentResponse) => {
        if (!response.success) {
          setSending(false)
          message.error(response.message ?? '发送失败')
          return
        }

        if (asDanmaku) {
          socket.emit(
            'send-danmaku',
            { roomId, content, videoTime: videoCurrentTime },
            (danmakuResponse: SendCommentResponse) => {
              setSending(false)
              if (danmakuResponse.success) {
                setInput('')
              } else {
                message.error(danmakuResponse.message ?? '弹幕发送失败')
              }
            }
          )
        } else {
          setSending(false)
          setInput('')
        }
      }
    )
  }

  const handleSendComment = () => handleSend(sendAsDanmaku)

  return (
    <div className="glass-card flex min-h-0 flex-1 flex-col gap-3 overflow-hidden rounded-[var(--md-sys-shape-corner)] p-4">
      {!commentsOnly && (
        <SegmentedToggle
          options={[
            { value: 'comments', label: '评论区' },
            { value: 'tracks', label: '弹幕轨道' },
            { value: 'realtime', label: '实时弹幕' },
          ]}
          value={rightPanelTab}
          onChange={(v) => setRightPanelTab(v as typeof rightPanelTab)}
        />
      )}
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
        {commentsOnly || rightPanelTab === 'comments' ? (
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div
              ref={listRef}
              className="glass-bg flex-1 min-h-0 overflow-y-auto rounded-[var(--md-sys-shape-corner)] p-3"
            >
              {comments.length === 0 ? (
                // 空状态独立于评论列表流：占满评论区空白处并水平垂直居中
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
                  <MessagesSquare
                    className="h-8 w-8 opacity-40"
                    style={{
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  />
                  <Text type="secondary" className="text-center text-xs">
                    暂无评论，快来第一条吧
                  </Text>
                </div>
              ) : (
                <Space
                  direction="vertical"
                  className="w-full"
                  size="sm"
                  align="start"
                >
                  {comments.map((comment, idx) => (
                    <div
                      key={comment.id}
                      className={cn(
                        'zen-comment-enter rounded-[var(--md-sys-shape-corner)] border p-2 transition-all hover:shadow-sm hover:-translate-y-0.5',
                        comment.isDanmaku
                          ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                          : 'border-transparent bg-[var(--glass-bg)] hover:border-[var(--md-sys-color-outline-variant)]'
                      )}
                      style={
                        {
                          '--item-delay': `${Math.min(idx, 8) * 40}ms`,
                        } as React.CSSProperties
                      }
                    >
                      <div className="flex items-start gap-1.5">
                        <Avatar
                          size="sm"
                          fallback={
                            <span className="text-[9px] font-medium">
                              {getInitials(comment.username)}
                            </span>
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-1.5">
                            <div className="flex items-center gap-1">
                              <Text
                                className="text-[11px] font-medium leading-tight"
                                style={{ color: 'var(--md-sys-color-primary)' }}
                              >
                                {comment.username}
                              </Text>
                              {comment.isDanmaku && (
                                <span
                                  className="inline-flex items-center gap-0.5 rounded-full px-1 py-0.5 text-[9px] font-medium leading-none"
                                  style={{
                                    backgroundColor:
                                      'var(--md-sys-color-primary)',
                                    color: 'var(--md-sys-color-on-primary)',
                                  }}
                                >
                                  <MessageSquareQuote className="h-2.5 w-2.5" />
                                  弹幕
                                </span>
                              )}
                            </div>
                            <Text
                              type="secondary"
                              className="text-[9px] leading-none"
                            >
                              {formatIsoTime(comment.createdAt)}
                            </Text>
                          </div>
                          <Text className="mt-0.5 break-words text-xs leading-snug">
                            {comment.content}
                          </Text>
                        </div>
                      </div>
                    </div>
                  ))}
                </Space>
              )}
            </div>
            <Space className="w-full" size="sm">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSendComment()
                  }
                }}
                placeholder={`${currentUser?.username ?? ''} 说点什么…`}
                className="flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                loading={sending}
                icon={<Send className="h-4 w-4" />}
                onClick={handleSendComment}
              >
                发送
              </Button>
            </Space>
            {allowDanmaku && (
              <div className="flex items-center">
                <Switch
                  label="以弹幕形式发送"
                  checked={sendAsDanmaku}
                  onChange={(e) => setSendAsDanmaku(e.target.checked)}
                />
              </div>
            )}
          </div>
        ) : rightPanelTab === 'tracks' ? (
          <DanmakuTrackCard />
        ) : (
          <RealtimeDanmakuCard />
        )}
      </div>
    </div>
  )
}
