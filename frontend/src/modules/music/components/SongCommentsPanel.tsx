/**
 * 网易云歌曲评论区（Hydrogen Comments.vue + useCommentsPanel.js 一比一复刻）。
 *
 * 明日方舟风 UI：角标框架系统（四角 8×8 2px 描边）、半透明白底卡片、
 * 左边条（热评金色）、座位式注释框架全部还原；固定色值，与主题解耦，
 * 暗色 html.dark 覆盖变量。
 *
 * 结构：
 * - COMMENTS 标题框（角标 + 下划线）
 * - 输入区（登录后且非回复中）：CTRL+ENTER 发送 + SEND 按钮（focus 外框联动）
 * - 未登录：LOGIN REQUIRED TO COMMENT
 * - HOT COMMENTS（/comment/new sortType:2 首页并拉）
 * - LATEST COMMENTS [total]（sortType:3，cursor 分页，距底 200px 自动追加）
 * - 卡片：头像外扩框、正文（网易表情渲染 + 点击复制）、LIKE/REPLY、
 *   楼层展开（/comment/floor，5 条一页）与内联回复框（REPLY TO + @昵称）
 *
 * 评论目标 = `song:<currentSongId>`（useMusicPlayer.currentSong），切歌重建；
 * 评论总数写入模块缓存（getCommentCountBadge 供播放器切换按钮徽章）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet } from '../musicApi'
import { message } from '@/components/ui/message'
import { writeTextToClipboard } from '@/hooks/useCopyToClipboard'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { cn } from '@/lib/utils'
import { parseTextWithEmoji } from '../utils/neteaseEmoji'
import { FrameCorners, LIKE_PATH } from './comments/CommentChrome'
import { CommentsShell } from './comments/CommentsShell'
import {
  getCommentTargetKey,
  getCommentTotal,
  hasCommentTotal,
  setCommentTotal,
} from './comments/comment-total-cache'
import { formatCommentTime } from './comments/format'

/** 评论条目（/comment/new 与 /comment/floor 通用的字段子集） */
interface NcmComment {
  commentId: number
  content: string
  time: number
  liked: boolean
  likedCount?: number
  parentCommentId?: number
  user?: { nickname?: string; avatarUrl?: string }
  showFloorComment?: { replyCount?: number }
}

/** /comment/new 响应（后端通用转发原样返回 NCM 结构；新版接口包 data 层） */
interface CommentNewResponse {
  code?: number
  data?: {
    comments?: NcmComment[]
    totalCount?: number
    hasMore?: boolean
    cursor?: string
  }
  comments?: NcmComment[]
  totalCount?: number
  hasMore?: boolean
  cursor?: string
}

/** /comment/floor 响应 */
interface CommentFloorResponse {
  code?: number
  data?: {
    comments?: NcmComment[]
    totalCount?: number
    hasMore?: boolean
    time?: number
  }
}

/** 楼层回复面板状态（Hydrogen createFloorState 同结构） */
interface FloorState {
  expanded: boolean
  loading: boolean
  error: string
  items: NcmComment[]
  hasMore: boolean
  nextTime: number
  total: number
}

/** 初始楼层状态（Hydrogen createFloorState） */
function createFloorState(replyCount: number): FloorState {
  return {
    expanded: false,
    loading: false,
    error: '',
    items: [],
    hasMore: replyCount > 0,
    nextTime: -1,
    total: replyCount,
  }
}

/** 回复目标（携带显式根评论 id，等价 Hydrogen __rootCommentId） */
interface ReplyTarget {
  comment: NcmComment
  __rootCommentId: number
}

const FLOOR_REPLY_LIMIT = 5
const COMMENTS_PREFETCH_PX = 200
const COMMENTS_PAGE_SIZE = 20

/** 正整数归一（Hydrogen toPositiveInt） */
const toPositiveInt = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

const getUserName = (user: NcmComment['user']) =>
  (user && user.nickname) || '未知用户'

const getUserAvatar = (user: NcmComment['user'], size = 40) => {
  if (user && user.avatarUrl) {
    return `${user.avatarUrl}?param=${size}y${size}`
  }
  return 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
}

/** 根评论 id：显式根 > parentCommentId > 自身（Hydrogen resolveReplyRootCommentId） */
function resolveRootId(comment: NcmComment, explicit?: number): number {
  if (explicit && explicit > 0) return explicit
  const parent = Number(comment.parentCommentId)
  if (Number.isFinite(parent) && parent > 0) return parent
  return comment.commentId
}

/**
 * 预取网易云评论总数（播放器评论徽章预加载）：
 * 仅拉一页最小页（pageSize=1）取 totalCount，已缓存（面板此前已加载过
 * 该歌曲）则跳过；失败静默——面板打开时仍会完整拉取并以 totalCount 覆盖。
 */
export async function prefetchSongCommentTotal(songId: number): Promise<void> {
  const targetKey = getCommentTargetKey(songId)
  if (!targetKey || hasCommentTotal(targetKey)) return
  try {
    const res = await apiGet<CommentNewResponse>(
      `/api/music/ncm/comment/new?id=${songId}&type=0&sortType=3&pageSize=1&pageNo=1&cursor=0&timestamp=${Date.now()}`
    )
    const body =
      res.data && typeof res.data === 'object'
        ? (res.data.data ?? res.data)
        : null
    if (res.data?.code === 200 && body && body.totalCount != null) {
      setCommentTotal(targetKey, toPositiveInt(body.totalCount))
    }
  } catch {
    // 静默：预取失败不打扰，打开评论区时仍会完整拉取
  }
}

// ==================== 小部件 ====================

const REPLY_PATH =
  'M853.333333 85.333333a85.333333 85.333333 0 0 1 85.333334 85.333334v469.333333a85.333333 85.333333 0 0 1-85.333334 85.333333H298.666667L128 896V170.666667a85.333333 85.333333 0 0 1 85.333333-85.333334h640z m0 85.333334H213.333333v530.773333L285.44 640H853.333333V170.666667z m-256 128v85.333333H256v-85.333333h341.333333z m0 170.666666v85.333334H256v-85.333334h341.333333z'

/** 评论文本（Hydrogen CommentText：表情渲染 + 点击复制） */
function CommentText({
  text,
  onCopy,
}: {
  text: string
  onCopy: (ok: boolean) => void
}) {
  const segments = parseTextWithEmoji(text)
  return (
    <div
      className="ac-comment-text"
      onClick={() => {
        void writeTextToClipboard(text).then(onCopy)
      }}
    >
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <span key={i}>{seg.content}</span>
        ) : seg.type === 'image' ? (
          <img
            key={i}
            className="ac-emoji-img inline-block"
            src={seg.src}
            alt={seg.canonicalName}
            title={`[${seg.canonicalName}]`}
            draggable={false}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span key={i} className="ac-emoji-text">
            {seg.content}
          </span>
        )
      )}
    </div>
  )
}

// ==================== 主组件 ====================

export function SongCommentsPanel() {
  const loginStatus = useMusicStore((s) => s.loginStatus)
  const { currentSong } = useMusicPlayer()
  const songId = currentSong?.songId ?? -1
  const commentTargetKey = getCommentTargetKey(songId)

  const [comments, setComments] = useState<NcmComment[]>([])
  const [hotComments, setHotComments] = useState<NcmComment[]>([])
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [newComment, setNewComment] = useState('')
  const [replyingTo, setReplyingTo] = useState<ReplyTarget | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [floorStates, setFloorStates] = useState<Record<string, FloorState>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollRafRef = useRef<number | null>(null)
  const replyTextareaRef = useRef<HTMLTextAreaElement | null>(null)

  /** 分页游标 / 页码（fetch 内部二进制锁） */
  const paginationRef = useRef({ cursor: '0', pageNo: 1 })
  const loadingRef = useRef(false)
  const hasMoreRef = useRef(true)
  const targetKeyRef = useRef('')

  const bumpFloorState = useCallback((key: string, next: FloorState) => {
    setFloorStates((prev) => ({ ...prev, [key]: next }))
  }, [])

  /** 数据加载（Hydrogen fetchComments：并行拉最新首页 + 热度首页，cursor 分页） */
  const fetchComments = useCallback(
    async (reset = false) => {
      if (!commentTargetKey) return
      if (loadingRef.current || (!hasMoreRef.current && !reset)) return

      loadingRef.current = true
      setLoading(true)
      let succeeded = false
      try {
        if (reset) {
          const [latest, hot] = await Promise.allSettled([
            apiGet<CommentNewResponse>(
              `/api/music/ncm/comment/new?id=${songId}&type=0&sortType=3&pageSize=${COMMENTS_PAGE_SIZE}&pageNo=1&cursor=0&timestamp=${Date.now()}`
            ),
            apiGet<CommentNewResponse>(
              `/api/music/ncm/comment/new?id=${songId}&type=0&sortType=2&pageSize=${COMMENTS_PAGE_SIZE}&pageNo=1&timestamp=${Date.now()}`
            ),
          ])
          const latestRes =
            latest.status === 'fulfilled' ? latest.value.data : null
          const hotRes = hot.status === 'fulfilled' ? hot.value.data : null

          // 归一化（Hydrogen normalizeCommentNewResponse /comment 新版接口把
          // comments/totalCount/hasMore/cursor 包在 data 字段内）
          const latestBody =
            latestRes && typeof latestRes === 'object'
              ? (latestRes.data ?? latestRes)
              : null
          const hotBody =
            hotRes && typeof hotRes === 'object'
              ? (hotRes.data ?? hotRes)
              : null

          if (
            latestRes &&
            latestRes.code === 200 &&
            latestBody &&
            Array.isArray(latestBody.comments)
          ) {
            setComments(latestBody.comments)
            setTotal(toPositiveInt(latestBody.totalCount))
            setHasMore(!!latestBody.hasMore)
            hasMoreRef.current = !!latestBody.hasMore
            paginationRef.current = {
              cursor: latestBody.cursor ?? '',
              pageNo: 2,
            }
            succeeded = true
          } else {
            setComments([])
            setTotal(0)
            setHasMore(false)
            hasMoreRef.current = false
            paginationRef.current = { cursor: '', pageNo: 1 }
          }
          if (
            hotRes &&
            hotRes.code === 200 &&
            hotBody &&
            Array.isArray(hotBody.comments)
          ) {
            setHotComments(hotBody.comments)
            succeeded = true
          } else {
            setHotComments([])
          }
        } else {
          const { cursor, pageNo } = paginationRef.current
          const res = await apiGet<CommentNewResponse>(
            `/api/music/ncm/comment/new?id=${songId}&type=0&sortType=3&pageSize=${COMMENTS_PAGE_SIZE}&pageNo=${pageNo}${cursor ? `&cursor=${cursor}` : ''}&timestamp=${Date.now()}`
          )
          const outer = res.data
          const body =
            outer && typeof outer === 'object' ? (outer.data ?? outer) : null
          if (
            outer &&
            outer.code === 200 &&
            body &&
            Array.isArray(body.comments)
          ) {
            const incoming = body.comments
            setComments((prev) => [...prev, ...incoming])
            setTotal(toPositiveInt(body.totalCount))
            const next = !!body.hasMore && incoming.length > 0
            setHasMore(next)
            hasMoreRef.current = next
            paginationRef.current = {
              cursor: body.cursor || cursor,
              pageNo: pageNo + 1,
            }
            succeeded = true
          }
        }
      } catch (err) {
        console.error('[SongCommentsPanel] 获取评论失败:', err)
        message.error('获取评论失败')
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
      if (succeeded) {
        // 首次填充后的接力分页由底部 AUTO-LOAD EFFECT 统一驱动（避免递归自调用）
      }
    },

    [commentTargetKey, songId]
  )

  /** 切歌重建面板（Hydrogen watch(commentTargetKey)） */
  useEffect(() => {
    if (commentTargetKey === targetKeyRef.current) return
    targetKeyRef.current = commentTargetKey
    if (!commentTargetKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部数据驱动（切歌清空面板），与 Hydrogen watch 语义一致
      setComments([])
      setHotComments([])
      setFloorStates({})
      setTotal(0)
      setHasMore(false)
      hasMoreRef.current = false
      paginationRef.current = { cursor: '0', pageNo: 1 }
      return
    }
    if (containerRef.current) containerRef.current.scrollTop = 0
    setCommentTotal(commentTargetKey, 0)

    void fetchComments(true)
  }, [commentTargetKey, fetchComments])

  // ===== 发送（Hydrogen submitComment） =====
  const submitComment = async () => {
    const content = newComment.trim()
    if (!content || submitting) return
    if (!loginStatus.loggedIn) {
      message.info('请先登录')
      return
    }
    setSubmitting(true)
    try {
      // Hydrogen postMusicComment 实际走 GET /comment（t:1 发送 / type:0 歌曲）
      const { data } = await apiGet<{ code?: number }>(
        `/api/music/ncm/comment?id=${songId}&content=${encodeURIComponent(content)}&t=1&type=0${replyingTo ? `&commentId=${replyingTo.comment.commentId}` : ''}&timestamp=${Date.now()}`
      )
      if (data && data.code === 200) {
        message.success('评论发送成功')
        setNewComment('')
        setReplyingTo(null)
        await fetchComments(true)
      } else {
        message.error('评论发送失败')
      }
    } catch (err) {
      console.error('[SongCommentsPanel] 发送评论失败:', err)
      message.error('评论发送失败')
    } finally {
      setSubmitting(false)
    }
  }

  // ===== 点赞（Hydrogen toggleLikeComment） =====
  const toggleLikeComment = useCallback(
    async (comment: NcmComment) => {
      if (!loginStatus.loggedIn) {
        message.info('请先登录')
        return
      }
      const liked = comment.liked
      try {
        const { data } = await apiGet<{ code?: number }>(
          `/api/music/ncm/comment/like?id=${songId}&cid=${comment.commentId}&t=${liked ? 0 : 1}&type=0&timestamp=${Date.now()}`
        )
        if (data && data.code === 200) {
          const nextCount =
            Math.max(0, (Number(comment.likedCount) || 0) + (liked ? -1 : 1)) ||
            undefined
          const patch = (c: NcmComment): NcmComment =>
            c.commentId === comment.commentId
              ? { ...c, liked: !liked, likedCount: nextCount }
              : c
          setComments((prev) => prev.map(patch))
          setHotComments((prev) => prev.map(patch))
          setFloorStates((prev) => {
            const next: Record<string, FloorState> = {}
            for (const [k, state] of Object.entries(prev)) {
              next[k] = { ...state, items: state.items.map(patch) }
            }
            return next
          })
        }
      } catch (err) {
        console.error('[SongCommentsPanel] 点赞失败:', err)
        message.error('操作失败')
      }
    },
    [loginStatus.loggedIn, songId]
  )

  /** 楼层回复（/comment/floor 5 条一页；Hydrogen loadFloorReplies） */
  const loadFloorReplies = useCallback(
    async (
      comment: NcmComment,
      snapshot: FloorState | null,
      { forceFirstPage = false } = {}
    ) => {
      const key = String(comment.commentId)
      const base =
        snapshot ??
        createFloorState(toPositiveInt(comment.showFloorComment?.replyCount))
      if (base.loading) return

      const replyCount = toPositiveInt(comment.showFloorComment?.replyCount)
      if (!replyCount && base.items.length === 0) {
        bumpFloorState(key, {
          ...base,
          hasMore: false,
          total: 0,
          expanded: true,
        })
        return
      }
      const isFirstPage = forceFirstPage || base.items.length === 0
      if (!isFirstPage && !base.hasMore) return

      bumpFloorState(key, { ...base, loading: true, error: '' })
      try {
        const { data } = await apiGet<CommentFloorResponse>(
          `/api/music/ncm/comment/floor?id=${songId}&type=0&parentCommentId=${comment.commentId}&limit=${FLOOR_REPLY_LIMIT}&time=${isFirstPage ? -1 : base.nextTime}&timestamp=${Date.now()}`
        )
        const body = data?.data
        if (data && data.code === 200 && body) {
          const incoming = Array.isArray(body.comments) ? body.comments : []
          let merged: NcmComment[]
          if (isFirstPage) {
            merged = incoming
          } else {
            const seen = new Set(base.items.map((i) => i.commentId))
            merged = [
              ...base.items,
              ...incoming.filter((i) => !seen.has(i.commentId)),
            ]
          }
          const totalRaw = Number(body.totalCount)
          const newTotal =
            Number.isFinite(totalRaw) && totalRaw >= 0
              ? Math.floor(totalRaw)
              : base.total
          const hasMoreNow =
            !!body.hasMore && !(newTotal > 0 && merged.length >= newTotal)
          const nextTime = Number(body.time)
          bumpFloorState(key, {
            ...base,
            items: merged,
            total: newTotal,
            hasMore: hasMoreNow,
            nextTime:
              Number.isFinite(nextTime) && nextTime >= 0
                ? nextTime
                : base.nextTime,
            expanded: true,
            loading: false,
            error: '',
          })
        } else {
          bumpFloorState(key, {
            ...base,
            loading: false,
            error: '回复加载失败，点击重试',
          })
        }
      } catch (err) {
        console.error('[SongCommentsPanel] 获取楼层回复失败:', err)
        bumpFloorState(key, {
          ...base,
          loading: false,
          error: '回复加载失败，点击重试',
        })
      }
    },
    [songId, bumpFloorState]
  )

  /** 展开 / 收起（Hydrogen toggleFloorReplies） */
  const toggleFloorReplies = useCallback(
    async (comment: NcmComment, snapshot: FloorState | null) => {
      const key = String(comment.commentId)
      const state = snapshot ?? floorStates[key] ?? null
      if (state) {
        if (state.expanded) {
          bumpFloorState(key, { ...state, expanded: false })
          return
        }
        if (state.items.length > 0) {
          bumpFloorState(key, { ...state, expanded: true })
          return
        }
      }
      await loadFloorReplies(comment, state, { forceFirstPage: true })
    },
    [floorStates, bumpFloorState, loadFloorReplies]
  )

  /** 追加一页 / 重试（Hydrogen loadMoreFloorReplies / retryFloorReplies） */
  const loadMoreFloorReplies = useCallback(
    async (comment: NcmComment, snapshot: FloorState) => {
      if (snapshot.loading || !snapshot.hasMore) return
      await loadFloorReplies(comment, snapshot)
    },
    [loadFloorReplies]
  )

  const retryFloorReplies = useCallback(
    async (comment: NcmComment, snapshot: FloorState | null) => {
      await loadFloorReplies(comment, snapshot, {
        forceFirstPage: (snapshot?.items.length ?? 0) === 0,
      })
    },
    [loadFloorReplies]
  )

  // ===== 回复（Hydrogen toggleReply / cancelReply） =====
  const toggleReply = (comment: NcmComment, rootCommentId?: number) => {
    const rootId = resolveRootId(comment, rootCommentId)
    if (
      replyingTo &&
      replyingTo.comment.commentId === comment.commentId &&
      replyingTo.__rootCommentId === rootId
    ) {
      // 点击当前正在回复的对象 → 取消
      setReplyingTo(null)
      setNewComment('')
      return
    }
    setReplyingTo({ comment, __rootCommentId: rootId })
    setNewComment(`@${getUserName(comment.user)} `)
    requestAnimationFrame(() => {
      const el = replyTextareaRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(el.value.length, el.value.length)
      }
    })
  }

  const cancelReply = () => {
    setReplyingTo(null)
    setNewComment('')
  }

  const isInlineReplyVisible = useCallback(
    (comment: NcmComment) =>
      !!replyingTo && replyingTo.__rootCommentId === comment.commentId,
    [replyingTo]
  )

  // ===== 滚动（rAF 节流，距底 200px 自动分页） =====
  const handleCommentsScroll = () => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const el = containerRef.current
      if (!el) return
      if (loadingRef.current || !hasMoreRef.current) return
      const dist = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (dist <= COMMENTS_PREFETCH_PX) void fetchComments(false)
    })
  }

  /** 距底自动分页（Hydrogen tryAutoLoadMore / COMMENTS_PREFETCH_PX；
      deferred setTimeout 避免 effect 内同步 setState 告警） */
  useEffect(() => {
    if (loading || !hasMore) return
    if (comments.length === 0 && hotComments.length === 0) return
    const el = containerRef.current
    if (!el) return
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight)
    if (dist > COMMENTS_PREFETCH_PX) return
    const timer = setTimeout(() => {
      void fetchComments(false)
    }, 0)
    return () => clearTimeout(timer)
  }, [loading, hasMore, comments, hotComments, commentTargetKey, fetchComments])

  // ===== 评论总数广播（徽章缓存，external system） =====
  useEffect(() => {
    if (!commentTargetKey) return
    if (getCommentTotal(commentTargetKey) !== total) {
      setCommentTotal(commentTargetKey, total)
    }
  }, [commentTargetKey, total])

  // ==================== 渲染 ====================
  return (
    <CommentsShell
      containerRef={containerRef}
      onScroll={handleCommentsScroll}
      headerExtra={
        <>
          {/* 输入区（登录后且非回复中） */}
          {loginStatus.loggedIn && !replyingTo && (
            <div className="ac-comment-input-section">
              <div className="ac-input-frame">
                <FrameCorners />
                <div>
                  <div className="relative">
                    <textarea
                      value={newComment}
                      onChange={(e) => setNewComment(e.target.value)}
                      disabled={submitting}
                      placeholder="INPUT YOUR COMMENT..."
                      className="ac-comment-textarea"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.ctrlKey) void submitComment()
                      }}
                    />
                    <div className="ac-input-border" />
                  </div>
                  <div className="ac-input-actions">
                    <span className="ac-shortcut-hint">CTRL+ENTER</span>
                    <button
                      type="button"
                      className="ac-submit-button"
                      onClick={() => void submitComment()}
                      disabled={!newComment.trim() || submitting}
                    >
                      {submitting ? 'SENDING...' : 'SEND'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 未登录提示 */}
          {!loginStatus.loggedIn && (
            <div className="ac-login-prompt">
              <div className="ac-prompt-frame">
                <FrameCorners />
                <span className="ac-prompt-text">
                  LOGIN REQUIRED TO COMMENT
                </span>
              </div>
            </div>
          )}
        </>
      }
      hotCount={hotComments.length}
      hot={hotComments.map((c) => (
        <CommentCard
          key={c.commentId}
          comment={c}
          isHot
          floorState={floorStates[String(c.commentId)] ?? null}
          onToggleFloor={toggleFloorReplies}
          onLoadMoreFloor={loadMoreFloorReplies}
          onRetryFloor={retryFloorReplies}
          onLike={(target) => void toggleLikeComment(target)}
          onReply={toggleReply}
          inlineVisible={isInlineReplyVisible(c)}
          inlineTarget={replyingTo}
          newComment={newComment}
          onNewCommentChange={setNewComment}
          submitting={submitting}
          onSubmitComment={() => void submitComment()}
          onCancelReply={cancelReply}
          textareaRef={replyTextareaRef}
        />
      ))}
      total={total}
      listCount={comments.length}
      list={comments.map((c) => (
        <CommentCard
          key={c.commentId}
          comment={c}
          floorState={floorStates[String(c.commentId)] ?? null}
          onToggleFloor={toggleFloorReplies}
          onLoadMoreFloor={loadMoreFloorReplies}
          onRetryFloor={retryFloorReplies}
          onLike={(target) => void toggleLikeComment(target)}
          onReply={toggleReply}
          inlineVisible={isInlineReplyVisible(c)}
          inlineTarget={replyingTo}
          newComment={newComment}
          onNewCommentChange={setNewComment}
          submitting={submitting}
          onSubmitComment={() => void submitComment()}
          onCancelReply={cancelReply}
          textareaRef={replyTextareaRef}
        />
      ))}
      loading={loading}
      hasMore={hasMore}
    />
  )
}

// ==================== 评论卡片 ====================

interface CommentCardProps {
  comment: NcmComment
  isHot?: boolean
  floorState: FloorState | null
  onToggleFloor: (comment: NcmComment, snapshot: FloorState | null) => void
  onLoadMoreFloor: (comment: NcmComment, snapshot: FloorState) => void
  onRetryFloor: (comment: NcmComment, snapshot: FloorState | null) => void
  onLike: (comment: NcmComment) => void
  onReply: (comment: NcmComment, rootCommentId?: number) => void
  inlineVisible: boolean
  inlineTarget: ReplyTarget | null
  newComment: string
  onNewCommentChange: (v: string) => void
  submitting: boolean
  onSubmitComment: () => void
  onCancelReply: () => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

function CommentCard({
  comment,
  isHot,
  floorState,
  onToggleFloor,
  onLoadMoreFloor,
  onRetryFloor,
  onLike,
  onReply,
  inlineVisible,
  inlineTarget,
  newComment,
  onNewCommentChange,
  submitting,
  onSubmitComment,
  onCancelReply,
  textareaRef,
}: CommentCardProps) {
  const replyCount = toPositiveInt(comment.showFloorComment?.replyCount)
  return (
    <div className={cn('ac-comment-card relative', isHot && 'ac-hot-card')}>
      {/* 角标框架（Hydrogen card-frame） */}
      <div className="pointer-events-none absolute inset-0">
        <FrameCorners />
      </div>
      {/* 头像 + 用户信息 */}
      <div className="ac-comment-meta">
        <div className="ac-user-avatar">
          <img
            src={getUserAvatar(comment.user, 40)}
            alt={getUserName(comment.user)}
            loading="lazy"
            decoding="async"
          />
          <div className="ac-avatar-frame" />
        </div>
        <div className="ac-user-info">
          <span className="ac-username">{getUserName(comment.user)}</span>
          <span className="ac-timestamp">
            {formatCommentTime(comment.time)}
          </span>
        </div>
      </div>
      {/* 正文（表情渲染 + 点击复制） */}
      <CommentText
        text={comment.content}
        onCopy={(ok) =>
          ok
            ? message.success('评论已复制到剪贴板')
            : message.error('复制失败，请手动选择文字复制')
        }
      />
      {/* LIKE / REPLY 控制组 */}
      <div className="ac-comment-controls">
        <div
          className={cn('ac-control-item', comment.liked && 'ac-active')}
          onClick={() => onLike(comment)}
        >
          <svg viewBox="0 0 1024 1024" width={14} height={14}>
            <path d={LIKE_PATH} />
          </svg>
          <span className="ac-control-text">
            {(Number(comment.likedCount) || 0) > 0
              ? comment.likedCount
              : 'LIKE'}
          </span>
        </div>
        <div className="ac-control-item" onClick={() => onReply(comment)}>
          <svg viewBox="0 0 1024 1024" width={14} height={14}>
            <path d={REPLY_PATH} />
          </svg>
          <span className="ac-control-text">REPLY</span>
        </div>
      </div>
      {/* 楼层回复 */}
      {replyCount > 0 && (
        <div className="ac-floor-replies">
          <button
            type="button"
            className="ac-floor-toggle"
            onClick={() => onToggleFloor(comment, floorState)}
          >
            {!(floorState && floorState.expanded)
              ? `展开${replyCount}条回复`
              : '收起回复'}
          </button>
          {floorState && floorState.expanded && (
            <div className="ac-floor-panel">
              {floorState.items.length > 0 &&
                floorState.items.map((reply) => (
                  <div
                    key={`floor-${comment.commentId}-${reply.commentId}`}
                    className="ac-floor-item"
                  >
                    <div className="flex items-center gap-2">
                      <div className="ac-floor-avatar">
                        <img
                          src={getUserAvatar(reply.user, 24)}
                          alt={getUserName(reply.user)}
                          loading="lazy"
                          decoding="async"
                        />
                      </div>
                      <div className="ac-floor-meta">
                        <span className="ac-floor-username">
                          {getUserName(reply.user)}
                        </span>
                        <span className="ac-floor-time">
                          {formatCommentTime(reply.time)}
                        </span>
                      </div>
                    </div>
                    <div className="ac-floor-main">
                      <CommentText
                        text={reply.content || ''}
                        onCopy={(ok) =>
                          ok
                            ? message.success('评论已复制到剪贴板')
                            : message.error('复制失败，请手动选择文字复制')
                        }
                      />
                      <div className="ac-floor-controls">
                        <div
                          className={cn(
                            'ac-floor-control-item',
                            reply.liked && 'ac-active'
                          )}
                          onClick={() => onLike(reply)}
                        >
                          <svg viewBox="0 0 1024 1024" width={10} height={10}>
                            <path d={LIKE_PATH} />
                          </svg>
                          <span className="ac-control-text">
                            {(Number(reply.likedCount) || 0) > 0
                              ? reply.likedCount
                              : 'LIKE'}
                          </span>
                        </div>
                        <div
                          className="ac-floor-control-item"
                          onClick={() => onReply(reply, comment.commentId)}
                        >
                          <svg viewBox="0 0 1024 1024" width={10} height={10}>
                            <path d={REPLY_PATH} />
                          </svg>
                          <span className="ac-control-text">REPLY</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              {floorState.error && (
                <div
                  className="ac-floor-status ac-floor-error"
                  onClick={() => onRetryFloor(comment, floorState)}
                >
                  {floorState.error}
                </div>
              )}
              {!floorState.error &&
                !floorState.loading &&
                floorState.items.length === 0 && (
                  <div className="ac-floor-status">暂无回复</div>
                )}
              {floorState.hasMore && (
                <button
                  type="button"
                  className="ac-floor-more"
                  disabled={floorState.loading}
                  onClick={() => onLoadMoreFloor(comment, floorState)}
                >
                  {floorState.loading ? '加载中...' : '展开更多回复'}
                </button>
              )}
              {!floorState.hasMore && floorState.items.length > 0 && (
                <div className="ac-floor-status">已展示全部回复</div>
              )}
            </div>
          )}
        </div>
      )}
      {/* 内联回复框（replyingTo 根评论 = 本卡评论） */}
      {inlineVisible && inlineTarget && (
        <div className="ac-inline-reply-box relative">
          <FrameCorners />
          <div className="ac-reply-header">
            <span className="ac-reply-prefix">REPLY TO</span>
            <span className="ac-reply-target">
              {getUserName(inlineTarget.comment.user || comment.user)}
            </span>
            <div className="ac-close-reply" onClick={() => onCancelReply()}>
              ×
            </div>
          </div>
          <div className="relative">
            <textarea
              ref={textareaRef}
              value={newComment}
              onChange={(e) => onNewCommentChange(e.target.value)}
              disabled={submitting}
              placeholder="INPUT YOUR REPLY..."
              className="ac-reply-textarea"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.ctrlKey) onSubmitComment()
              }}
            />
            <div className="ac-reply-input-border" />
          </div>
          <div className="ac-reply-actions">
            <span className="ac-shortcut-hint">CTRL+ENTER</span>
            <div className="ac-reply-buttons">
              <button
                type="button"
                className="ac-cancel-reply-btn"
                onClick={() => onCancelReply()}
              >
                CANCEL
              </button>
              <button
                type="button"
                className="ac-send-reply-btn"
                onClick={() => onSubmitComment()}
                disabled={!newComment.trim() || submitting}
              >
                {submitting ? 'SENDING...' : 'SEND'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
