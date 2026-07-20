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
import { cn } from '@/lib/utils'
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

function formatTime(iso: string) {
  const date = new Date(iso)
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getInitials(name: string) {
  return name.slice(0, 2).toUpperCase()
}

export function CommentPanel({
  socket,
  roomId,
  commentsOnly = false,
}: CommentPanelProps) {
  const currentUser = useAuthStore((state) => state.user)
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

    socket.emit(
      'comment-history',
      { roomId },
      (response: CommentHistoryResponse) => {
        if (response.success && response.comments) {
          setComments(response.comments)
        }
      }
    )

    return () => {
      socket.off('new-comment', handleNewComment)
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
            { roomId, content },
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
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
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
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {commentsOnly || rightPanelTab === 'comments' ? (
          <div className="flex h-full min-h-0 flex-col gap-3">
            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] p-3"
              style={{
                backgroundColor: 'var(--md-sys-color-surface-container)',
              }}
            >
              <Space direction="vertical" className="w-full" size="sm">
                {comments.length === 0 && (
                  <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
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
                )}
                {comments.map((comment, idx) => (
                  <div
                    key={comment.id}
                    className={cn(
                      'zen-comment-enter rounded-[var(--md-sys-shape-corner)] border p-3 transition-all hover:shadow-sm hover:-translate-y-0.5',
                      comment.isDanmaku
                        ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                        : 'border-transparent bg-[var(--md-sys-color-surface-container-high)] hover:border-[var(--md-sys-color-outline-variant)]'
                    )}
                    style={
                      {
                        '--item-delay': `${Math.min(idx, 8) * 40}ms`,
                      } as React.CSSProperties
                    }
                  >
                    <div className="flex items-start gap-2">
                      <Avatar
                        size="sm"
                        fallback={
                          <span className="text-[10px] font-medium">
                            {getInitials(comment.username)}
                          </span>
                        }
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <Text
                              className="text-xs font-medium"
                              style={{ color: 'var(--md-sys-color-primary)' }}
                            >
                              {comment.username}
                            </Text>
                            {comment.isDanmaku && (
                              <span
                                className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                                style={{
                                  backgroundColor:
                                    'var(--md-sys-color-primary)',
                                  color: 'var(--md-sys-color-on-primary)',
                                }}
                              >
                                <MessageSquareQuote className="h-3 w-3" />
                                弹幕
                              </span>
                            )}
                          </div>
                          <Text type="secondary" className="text-[10px]">
                            {formatTime(comment.createdAt)}
                          </Text>
                        </div>
                        <Text className="mt-1 break-words text-sm">
                          {comment.content}
                        </Text>
                        {!comment.isDanmaku && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="mt-2 h-6 px-2 text-xs"
                            icon={<MessageSquareQuote className="h-3 w-3" />}
                            onClick={() => {
                              socket?.emit(
                                'send-danmaku',
                                { roomId, content: comment.content },
                                (response: SendCommentResponse) => {
                                  if (!response.success) {
                                    message.error(
                                      response.message ?? '弹幕发送失败'
                                    )
                                  }
                                }
                              )
                            }}
                          >
                            弹幕
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </Space>
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
            <div className="flex items-center">
              <Switch
                label="以弹幕形式发送"
                checked={sendAsDanmaku}
                onChange={(e) => setSendAsDanmaku(e.target.checked)}
              />
            </div>
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
