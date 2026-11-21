import { useEffect, useRef, useState } from 'react'
import {
  AppWindow,
  ArrowDownToLine,
  Send,
  MessageSquareQuote,
  MessagesSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Space } from '@/components/ui/Space'
import { Switch } from '@/components/ui/Switch'
import { Text } from '@/components/ui/Typography'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { message } from '@/components/ui/message'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { useAuthStore } from '@/store/authStore'
import { useCommentFloatingStore } from '@/store/commentFloatingStore'
import { getDesktopCapabilities, openDesktopCommentsWindow } from '@/lib/desktopWindow'
import { useRoomStore } from '@/store/roomStore'
import { cn, formatIsoTime } from '@/lib/utils'
import type { Socket } from 'socket.io-client'
import { DanmakuTrackCard } from '@/modules/danmaku/components/DanmakuTrackCard'
import { RealtimeDanmakuCard } from '@/modules/danmaku/components/RealtimeDanmakuCard'
import { t } from '@/i18n'

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
  /**
   * 悬浮窗内使用：去掉 glass-card 外框（背景由悬浮窗统一控制透明度），
   * 让面板直接透出窗口背景。
   */
  floating?: boolean
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

/** 判定评论列表是否停在底部（容差避免亚像素误差） */
function isScrolledToBottom(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= 8
}

/** 手动滚动结束后恢复自动滚动的等待时间 */
const AUTO_SCROLL_RESUME_DELAY_MS = 5000

export function CommentPanel({
  socket,
  roomId,
  commentsOnly = false,
  allowDanmaku = true,
  floating = false,
}: CommentPanelProps) {
  const currentUser = useAuthStore((state) => state.user)
  const openFloatingWindow = useCommentFloatingStore((state) => state.open)
  /**
   * 桌面端独立窗口能力：由后端判定（桌面端托管 + 壳程序存在 + 浏览器与桌面端同机），
   * 结果在 lib/desktopWindow 内缓存。普通浏览器只会得到 false，一次请求后不再重复。
   */
  const [desktopCommentsAvailable, setDesktopCommentsAvailable] = useState(false)
  useEffect(() => {
    if (!roomId || floating) return undefined
    let alive = true
    void getDesktopCapabilities().then((caps) => {
      if (alive) setDesktopCommentsAvailable(caps.available)
    })
    return () => {
      alive = false
    }
  }, [roomId, floating])

  /**
   * 独立窗口按钮：桌面端能开窗就走真正的桌面窗口（可置顶、无边框、可脱离标签页），
   * 否则退回应用内悬浮浮层——浏览器里行为与之前完全一致。
   */
  const handleOpenCommentsWindow = async () => {
    if (!roomId) return
    if (desktopCommentsAvailable) {
      const opened = await openDesktopCommentsWindow(roomId)
      if (opened) return
    }
    openFloatingWindow(roomId)
  }
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
  /** 是否跟随新评论自动滚到底部（手动滚动会临时关闭，5 秒无操作后自动恢复） */
  const [autoScroll, setAutoScroll] = useState(true)
  /** 本次关闭是「手动滚动触发」还是「用户手动点开关关掉的」 */
  const autoPausedRef = useRef(false)
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  /** 滚到底部（自动滚动恢复时使用） */
  const scrollToBottom = () => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }

  /** 清掉待恢复的定时器 */
  const clearResumeTimer = () => {
    if (resumeTimerRef.current) {
      clearTimeout(resumeTimerRef.current)
      resumeTimerRef.current = null
    }
  }

  /**
   * 安排「手动滚动结束后自动恢复」：每次滚动事件都会重置计时，
   * 只有连续 5 秒没有新的滚动才恢复自动滚动。只对「因手动滚动被动关闭」
   * 生效——用户自己点开关关掉的不恢复。
   */
  const scheduleAutoScrollResume = () => {
    clearResumeTimer()
    resumeTimerRef.current = setTimeout(() => {
      resumeTimerRef.current = null
      if (!autoPausedRef.current) return
      autoPausedRef.current = false
      setAutoScroll(true)
      scrollToBottom()
    }, AUTO_SCROLL_RESUME_DELAY_MS)
  }

  // 新评论到达：仅在自动滚动开启时跟随到底部
  useEffect(() => {
    if (!autoScroll) return
    const list = listRef.current
    if (list) {
      list.scrollTop = list.scrollHeight
    }
  }, [comments, autoScroll])

  // 手动滚动检测：离开底部即临时关闭自动滚动，停手 5 秒后恢复
  const handleListScroll = () => {
    const list = listRef.current
    if (!list) return
    if (isScrolledToBottom(list)) {
      // 滚回底部：恢复（如果这次是手动滚动触发的暂停）
      clearResumeTimer()
      if (autoPausedRef.current) {
        autoPausedRef.current = false
        setAutoScroll(true)
      }
      return
    }
    if (autoPausedRef.current) {
      // 手动滚动仍在进行中：不断顺延恢复时间
      scheduleAutoScrollResume()
      return
    }
    if (autoScroll) {
      autoPausedRef.current = true
      setAutoScroll(false)
      scheduleAutoScrollResume()
    }
  }

  /** 开关点击：手动关闭不参与 5 秒自动恢复 */
  const handleToggleAutoScroll = () => {
    clearResumeTimer()
    autoPausedRef.current = false
    setAutoScroll((prev) => {
      if (!prev) scrollToBottom()
      return !prev
    })
  }

  // 卸载时清掉待恢复定时器
  useEffect(() => {
    return () => {
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    }
  }, [])

  const handleSend = (asDanmaku = false) => {
    if (!socket || !roomId) return
    const content = input.trim()
    if (!content) {
      message.warning(t('请输入评论内容'))
      return
    }

    setSending(true)
    socket.emit(
      'send-comment',
      { roomId, content, isDanmaku: asDanmaku },
      (response: SendCommentResponse) => {
        if (!response.success) {
          setSending(false)
          message.error(response.message ?? t('发送失败'))
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
                message.error(danmakuResponse.message ?? t('弹幕发送失败'))
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
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden',
        floating
          ? 'h-full'
          : 'glass-card rounded-[var(--md-sys-shape-corner)] p-4'
      )}
    >
      {!commentsOnly && (
        <SegmentedToggle
          options={[
            { value: 'comments', label: t('评论区') },
            { value: 'tracks', label: t('弹幕轨道') },
            { value: 'realtime', label: t('实时弹幕') },
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
              onScroll={handleListScroll}
              className="glass-bg flex-1 min-h-0 overflow-y-auto rounded-[var(--md-sys-shape-corner)] p-3"
            >
              {comments.length === 0 ? (
                // 空状态独立于评论列表流：占满评论区空白处并水平垂直居中
                <EmptyState
                  icon={<MessagesSquare className="h-8 w-8" />}
                  text={t('暂无评论，快来第一条吧')}
                  variant="centered"
                />
              ) : (
                <Space
                  direction="vertical"
                  className="w-full"
                  size="sm"
                  align="start"
                >
                  {comments.map((comment, idx) => {
                    // 自己的评论靠右、别人的靠左（仿聊天窗口，便于快速区分）
                    const isOwn =
                      Boolean(comment.username) &&
                      comment.username === currentUser?.username
                    return (
                    <div
                      key={comment.id}
                      className={cn(
                        'flex w-full',
                        isOwn ? 'justify-end' : 'justify-start'
                      )}
                    >
                    <div
                      className={cn(
                        'zen-comment-enter max-w-[85%] rounded-[var(--md-sys-shape-corner)] border p-2 transition-all hover:shadow-sm hover:-translate-y-0.5',
                        comment.isDanmaku
                          ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                          : isOwn
                            ? 'border-transparent bg-[var(--glass-bg)]'
                            : 'border-transparent bg-[var(--glass-bg)] hover:border-[var(--md-sys-color-outline-variant)]'
                      )}
                      style={
                        {
                          '--item-delay': `${Math.min(idx, 8) * 40}ms`,
                          ...(isOwn && !comment.isDanmaku
                            ? {
                                borderColor:
                                  'color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent)',
                              }
                            : null),
                        } as React.CSSProperties
                      }
                    >
                      <div
                        className={cn(
                          'flex items-start gap-1.5',
                          isOwn && 'flex-row-reverse'
                        )}
                      >
                        <Avatar
                          size="sm"
                          fallback={
                            <span className="text-[9px] font-medium">
                              {getInitials(comment.username)}
                            </span>
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <div
                            className={cn(
                              'flex items-center gap-1.5',
                              isOwn ? 'flex-row-reverse' : 'justify-between'
                            )}
                          >
                            <div
                              className={cn(
                                'flex items-center gap-1',
                                isOwn && 'flex-row-reverse'
                              )}
                            >
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
                                  {t('弹幕')}
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
                          <Text
                            className={cn(
                              'mt-0.5 break-words text-xs leading-snug',
                              isOwn && 'text-right'
                            )}
                          >
                            {comment.content}
                          </Text>
                        </div>
                      </div>
                    </div>
                    </div>
                    )
                  })}
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
                placeholder={t('{{value}} 说点什么…', {
                  value: currentUser?.username ?? '',
                })}
                className="flex-1"
              />
              <Button
                variant="primary"
                size="sm"
                loading={sending}
                icon={<Send className="h-4 w-4" />}
                onClick={handleSendComment}
              >
                {t('发送')}
              </Button>
            </Space>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                {/* 弹幕目前不可用：投屏/屏幕共享场景（commentsOnly）不显示弹幕开关 */}
                {allowDanmaku && !commentsOnly && (
                  <Switch
                    label={t('以弹幕形式发送')}
                    checked={sendAsDanmaku}
                    onChange={(e) => setSendAsDanmaku(e.target.checked)}
                  />
                )}
                {/* 自动滚动开关：手动滚动评论区会自动关闭，停手 5 秒后恢复 */}
                <button
                  type="button"
                  aria-pressed={autoScroll}
                  title={t('自动滚动到最新')}
                  onClick={handleToggleAutoScroll}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] leading-none transition-colors',
                    autoScroll
                      ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                      : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                  )}
                >
                  <ArrowDownToLine className="h-3 w-3" />
                  {t('自动滚动')}
                </button>
              </div>
              {roomId && !floating && (
                <button
                  type="button"
                  title={t('在悬浮窗打开评论区')}
                  className="ml-auto inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-high)] hover:text-[var(--md-sys-color-primary)]"
                  onClick={() => void handleOpenCommentsWindow()}
                >
                  <AppWindow className="h-4 w-4" />
                </button>
              )}
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
