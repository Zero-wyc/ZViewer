/**
 * 哔哩哔哩视频评论区（歌词页右侧；UI 语言与网易云评论区同款——
 * Hydrogen Comments.vue 明日方舟风复刻，ac-* 样式复用 SongCommentsPanel
 * 导出的同一份样式表）。
 *
 * 数据源：当前播放 B站 视频的评论区（后端 /bilibili/comments 匿名可查，
 * 登录态完整分页）。只读浏览：
 * - HOT COMMENTS（mode=3 热度首页）
 * - LATEST COMMENTS [total]（mode=2 时间游标分页，距底 200px 自动追加）
 * - 楼层回复展开（/bilibili/comment-replies，10 条一页 + 展开更多）
 * - 正文点击复制、B站 表情渲染（emote 图与头像均经防盗链代理）
 *
 * 未登录游客 B站 仅开放前 3 条主楼（loginLimited 提示帧）；
 * 评论目标 = `bili:<bvid>`，总数写入 commentTotalCache 供切换按钮徽章。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import {
  fetchBiliComments,
  fetchBiliCommentReplies,
  type BiliCommentItem,
} from '@/modules/bilibili/bilibiliApi'
import {
  buildBilibiliImageProxyUrl,
  isBilibiliImageUrl,
} from '@/modules/room/watch-together/resolveSource'
import {
  COMMENTS_STYLE,
  LIKE_PATH,
  hasCommentTotal,
  setCommentTotal,
} from './SongCommentsPanel'

/**
 * 预取 B站 评论总数（播放器评论徽章预加载）：复用评论接口按时间首页
 * （next=0）取 total；已缓存（面板此前已加载过该视频）则跳过；失败静默——
 * 面板打开时仍会完整拉取并以 total 覆盖。
 */
export async function prefetchBiliCommentTotal(bvid: string): Promise<void> {
  if (!bvid || hasCommentTotal(`bili:${bvid}`)) return
  try {
    const page = await fetchBiliComments(bvid, '2', 0)
    setCommentTotal(`bili:${bvid}`, page.total)
  } catch {
    // 静默：预取失败不打扰，打开评论区时仍会完整拉取
  }
}

/** 楼层回复面板状态 */
interface FloorState {
  expanded: boolean
  loading: boolean
  error: string
  items: BiliCommentItem[]
  total: number
  /** 已加载到的页码（重试同页 / 追加下一页） */
  pn: number
}

const FLOOR_REPLY_LIMIT = 10
const COMMENTS_PREFETCH_PX = 200

/** 数量缩写（>=1w 显示 x.xw） */
function formatBiliCount(n: number): string {
  if (n >= 10_000) {
    return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}w`
  }
  return String(n)
}

/** 相对时间格式化（秒级 Unix 入参，与网易云评论区同语义） */
function formatBiliCommentTime(sec: number): string {
  const ts = Number(sec) * 1000
  if (!Number.isFinite(ts) || ts <= 0) return '刚刚'
  const diff = Date.now() - ts
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day
  const year = 365 * day
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`
  if (diff < day) return `${Math.floor(diff / hour)}小时前`
  if (diff < month) return `${Math.floor(diff / day)}天前`
  if (diff < year) return `${Math.floor(diff / month)}个月前`
  return `${Math.floor(diff / year)}年前`
}

/** 头像/表情图代理（hdslb 直链应用内 403，统一走后端防盗链代理） */
function proxyBiliImage(url: string): string {
  if (!url) {
    return 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
  }
  return isBilibiliImageUrl(url) ? buildBilibiliImageProxyUrl(url) : url
}

function FrameCorners() {
  return (
    <>
      <div className="ac-frame-corner ac-frame-tl" aria-hidden="true" />
      <div className="ac-frame-corner ac-frame-tr" aria-hidden="true" />
      <div className="ac-frame-corner ac-frame-bl" aria-hidden="true" />
      <div className="ac-frame-corner ac-frame-br" aria-hidden="true" />
    </>
  )
}

/** 评论文本（[表情] 渲染 + 点击复制原文） */
function BiliCommentText({
  text,
  emote,
  onCopy,
}: {
  text: string
  emote: Record<string, string>
  onCopy: (ok: boolean) => void
}) {
  const parts = text.split(/(\[[^[\]]{1,50}\])/g)
  return (
    <div
      className="ac-comment-text"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => onCopy(true))
          .catch(() => onCopy(false))
      }}
    >
      {parts.map((part, i) => {
        const url = emote[part]
        if (url) {
          return (
            <img
              key={i}
              className="ac-emoji-img inline-block"
              src={proxyBiliImage(url)}
              alt={part}
              title={part}
              draggable={false}
            />
          )
        }
        return part ? <span key={i}>{part}</span> : null
      })}
    </div>
  )
}

const onCommentCopy = (ok: boolean) =>
  ok
    ? message.success('评论已复制到剪贴板')
    : message.error('复制失败，请手动选择文字复制')

// ==================== 主组件 ====================

export function BiliCommentsPanel({ bvid }: { bvid: string }) {
  const [hotComments, setHotComments] = useState<BiliCommentItem[]>([])
  const [comments, setComments] = useState<BiliCommentItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loginLimited, setLoginLimited] = useState(false)
  const [floorStates, setFloorStates] = useState<Record<string, FloorState>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  const scrollRafRef = useRef<number | null>(null)

  /** 游标分页游标（fetch 内部二进制锁） */
  const paginationRef = useRef({ next: 0, hasMore: false })
  const loadingRef = useRef(false)
  const targetKeyRef = useRef('')

  /** 主楼分页（reset=并行拉最新首页 + 热度首页；否则按游标追加） */
  const fetchComments = useCallback(
    async (reset = false) => {
      if (!bvid) return
      if (loadingRef.current || (!reset && !paginationRef.current.hasMore))
        return
      loadingRef.current = true
      setLoading(true)
      try {
        if (reset) {
          const [latest, hot] = await Promise.allSettled([
            fetchBiliComments(bvid, '2', 0),
            fetchBiliComments(bvid, '3', 0),
          ])
          const latestRes = latest.status === 'fulfilled' ? latest.value : null
          const hotRes = hot.status === 'fulfilled' ? hot.value : null
          if (latestRes && latestRes.replies.length > 0) {
            setComments(latestRes.replies)
            setTotal(latestRes.total)
            setLoginLimited(latestRes.loginLimited)
            paginationRef.current = {
              next: latestRes.next ?? 0,
              hasMore: latestRes.next != null,
            }
            setHasMore(latestRes.next != null)
          } else if (latestRes) {
            // 最新一页为空（评论区关闭/无主楼）：仍以热度兜底展示
            setComments([])
            setTotal(latestRes.total)
            setLoginLimited(latestRes.loginLimited)
            paginationRef.current = { next: 0, hasMore: false }
            setHasMore(false)
          } else {
            setComments([])
            setTotal(0)
            setLoginLimited(false)
            paginationRef.current = { next: 0, hasMore: false }
            setHasMore(false)
          }
          setHotComments(hotRes?.replies ?? [])
        } else {
          const page = await fetchBiliComments(
            bvid,
            '2',
            paginationRef.current.next
          )
          const incoming = page.replies
          if (incoming.length > 0) {
            setComments((prev) => [...prev, ...incoming])
            setTotal(page.total)
            setLoginLimited(page.loginLimited)
          }
          const more = page.next != null && incoming.length > 0
          paginationRef.current = { next: page.next ?? 0, hasMore: more }
          setHasMore(more)
        }
      } catch (err) {
        console.error('[BiliCommentsPanel] 获取评论失败:', err)
        message.error('获取评论失败')
      } finally {
        loadingRef.current = false
        setLoading(false)
      }
    },
    [bvid]
  )

  /** 切视频重建面板（等价网易云面板 watch(commentTargetKey)） */
  useEffect(() => {
    const targetKey = bvid ? `bili:${bvid}` : ''
    if (targetKey === targetKeyRef.current) return
    targetKeyRef.current = targetKey
    if (!targetKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 外部数据驱动（切视频清空面板）
      setComments([])
      setHotComments([])
      setFloorStates({})
      setTotal(0)
      setHasMore(false)
      setLoginLimited(false)
      paginationRef.current = { next: 0, hasMore: false }
      return
    }
    if (containerRef.current) containerRef.current.scrollTop = 0
    setCommentTotal(targetKey, 0)
    void fetchComments(true)
  }, [bvid, fetchComments])

  // ===== 评论总数广播（徽章缓存，external system） =====
  useEffect(() => {
    if (!bvid) return
    setCommentTotal(`bili:${bvid}`, total)
  }, [bvid, total])

  // ===== 楼层回复（10 条一页；pn 传统分页） =====
  const loadFloorReplies = useCallback(
    async (
      comment: BiliCommentItem,
      snapshot: FloorState | undefined,
      pn: number
    ) => {
      const key = String(comment.rpid)
      if (snapshot?.loading) return
      if (pn === 1 && snapshot?.items.length) {
        // 已有首页数据：仅展开
        setFloorStates((prev) => ({
          ...prev,
          [key]: { ...snapshot, expanded: true },
        }))
        return
      }
      setFloorStates((prev) => ({
        ...prev,
        [key]: {
          expanded: true,
          loading: true,
          error: '',
          items: snapshot?.items ?? [],
          total: snapshot?.total ?? comment.replyCount,
          pn,
        },
      }))
      try {
        const page = await fetchBiliCommentReplies(
          bvid,
          comment.rpid,
          pn,
          FLOOR_REPLY_LIMIT
        )
        setFloorStates((prev) => {
          const base = prev[key]
          const prevItems = pn === 1 ? [] : (base?.items ?? [])
          const seen = new Set(prevItems.map((i) => i.rpid))
          const merged = [
            ...prevItems,
            ...page.replies.filter((i) => !seen.has(i.rpid)),
          ]
          return {
            ...prev,
            [key]: {
              expanded: true,
              loading: false,
              error: '',
              items: merged,
              total: page.total,
              pn,
            },
          }
        })
      } catch (err) {
        console.error('[BiliCommentsPanel] 获取楼层回复失败:', err)
        setFloorStates((prev) => ({
          ...prev,
          [key]: {
            expanded: true,
            loading: false,
            error: '回复加载失败，点击重试',
            items: snapshot?.items ?? [],
            total: snapshot?.total ?? comment.replyCount,
            pn: snapshot?.pn ?? pn,
          },
        }))
      }
    },
    [bvid]
  )

  /** 展开 / 收起 / 追加 / 重试 */
  const toggleFloorReplies = useCallback(
    async (comment: BiliCommentItem) => {
      const key = String(comment.rpid)
      const state = floorStates[key]
      if (state?.expanded) {
        setFloorStates((prev) => ({
          ...prev,
          [key]: { ...state, expanded: false },
        }))
        return
      }
      if (state && state.items.length > 0) {
        setFloorStates((prev) => ({
          ...prev,
          [key]: { ...state, expanded: true },
        }))
        return
      }
      await loadFloorReplies(comment, state, 1)
    },
    [floorStates, loadFloorReplies]
  )

  const loadMoreFloorReplies = useCallback(
    async (comment: BiliCommentItem) => {
      const state = floorStates[String(comment.rpid)]
      if (!state || state.loading) return
      if (state.items.length >= state.total) return
      await loadFloorReplies(comment, state, state.pn + 1)
    },
    [floorStates, loadFloorReplies]
  )

  const retryFloorReplies = useCallback(
    async (comment: BiliCommentItem) => {
      const state = floorStates[String(comment.rpid)]
      await loadFloorReplies(comment, state, state?.pn ?? 1)
    },
    [floorStates, loadFloorReplies]
  )

  // ===== 滚动（rAF 节流，距底 200px 自动分页） =====
  const handleCommentsScroll = () => {
    if (scrollRafRef.current !== null) return
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      const el = containerRef.current
      if (!el) return
      if (loadingRef.current || !paginationRef.current.hasMore) return
      const dist = el.scrollHeight - (el.scrollTop + el.clientHeight)
      if (dist <= COMMENTS_PREFETCH_PX) void fetchComments(false)
    })
  }

  /** 距底自动分页（deferred setTimeout 避免 effect 内同步 setState 告警） */
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
  }, [loading, hasMore, comments, hotComments, bvid, fetchComments])

  // ==================== 渲染 ====================
  return (
    <div
      ref={containerRef}
      onScroll={handleCommentsScroll}
      className="arknights-comments"
    >
      <style>{COMMENTS_STYLE}</style>

      {/* COMMENTS 标题（角标框架） */}
      <div className="ac-comments-header">
        <div className="ac-header-frame">
          <FrameCorners />
          <div className="flex flex-col items-center">
            <span className="ac-header-title">COMMENTS</span>
            <div className="ac-title-underline" />
          </div>
        </div>
      </div>

      {/* 游客提示：未登录 B站 仅开放前 3 条主楼 */}
      {loginLimited && (
        <div className="ac-login-prompt">
          <div className="ac-prompt-frame">
            <FrameCorners />
            <span className="ac-prompt-text">
              LOGIN FOR FULL COMMENTS（游客仅前 3 条）
            </span>
          </div>
        </div>
      )}

      {/* HOT COMMENTS */}
      {hotComments.length > 0 && (
        <div>
          <div className="ac-section-header">
            <div>
              <span className="ac-section-title">HOT COMMENTS</span>
              <span className="ac-section-count">[{hotComments.length}]</span>
            </div>
            <div className="ac-section-line" />
          </div>
          {hotComments.map((c) => (
            <BiliCard
              key={c.rpid}
              comment={c}
              isHot
              floorState={floorStates[String(c.rpid)]}
              onToggleFloor={toggleFloorReplies}
              onLoadMoreFloor={loadMoreFloorReplies}
              onRetryFloor={retryFloorReplies}
            />
          ))}
        </div>
      )}

      {/* LATEST COMMENTS */}
      <div>
        <div className="ac-section-header">
          <div>
            <span className="ac-section-title">LATEST COMMENTS</span>
            <span className="ac-section-count">[{total}]</span>
          </div>
          <div className="ac-section-line" />
        </div>
        {comments.map((c) => (
          <BiliCard
            key={c.rpid}
            comment={c}
            floorState={floorStates[String(c.rpid)]}
            onToggleFloor={toggleFloorReplies}
            onLoadMoreFloor={loadMoreFloorReplies}
            onRetryFloor={retryFloorReplies}
          />
        ))}
      </div>

      {/* 状态区（加载中 / 暂无更多 / 无评论） */}
      {loading && (
        <div className="ac-status-section">
          <div className="ac-status-frame relative">
            <FrameCorners />
            <div className="ac-loading-content">
              <div className="ac-loading-indicator" />
              <span className="ac-status-text">LOADING...</span>
            </div>
          </div>
        </div>
      )}
      {!hasMore && comments.length > 0 && (
        <div className="ac-status-section">
          <div className="ac-status-frame relative">
            <FrameCorners />
            <span className="ac-status-text">NO MORE COMMENTS</span>
          </div>
        </div>
      )}
      {!loading && comments.length === 0 && hotComments.length === 0 && (
        <div className="ac-status-section">
          <div className="ac-status-frame relative">
            <FrameCorners />
            <span className="ac-status-text">NO COMMENTS YET</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ==================== 评论卡片 ====================

interface BiliCardProps {
  comment: BiliCommentItem
  isHot?: boolean
  floorState?: FloorState
  onToggleFloor: (comment: BiliCommentItem) => void
  onLoadMoreFloor: (comment: BiliCommentItem) => void
  onRetryFloor: (comment: BiliCommentItem) => void
}

function BiliCard({
  comment,
  isHot,
  floorState,
  onToggleFloor,
  onLoadMoreFloor,
  onRetryFloor,
}: BiliCardProps) {
  const replyCount = comment.replyCount
  return (
    <div className={cn('ac-comment-card relative', isHot && 'ac-hot-card')}>
      {/* 角标框架 */}
      <div className="pointer-events-none absolute inset-0">
        <FrameCorners />
      </div>
      {/* 头像 + 用户信息 */}
      <div className="ac-comment-meta">
        <div className="ac-user-avatar">
          <img
            src={proxyBiliImage(comment.avatar)}
            alt={comment.name || '匿名用户'}
          />
          <div className="ac-avatar-frame" />
        </div>
        <div className="ac-user-info">
          <span className="ac-username">{comment.name || '匿名用户'}</span>
          <span className="ac-timestamp">
            {formatBiliCommentTime(comment.time)}
            {comment.location ? ` · ${comment.location}` : ''}
          </span>
        </div>
      </div>
      {/* 正文（表情渲染 + 点击复制） */}
      <BiliCommentText
        text={comment.content}
        emote={comment.emote}
        onCopy={onCommentCopy}
      />
      {/* 点赞数（只读展示，B站 评论点赞/回复暂不开放） */}
      <div className="ac-comment-controls">
        <div className="ac-control-item cursor-default">
          <svg viewBox="0 0 1024 1024" width={14} height={14}>
            <path d={LIKE_PATH} />
          </svg>
          <span className="ac-control-text">
            {comment.like > 0 ? formatBiliCount(comment.like) : 'LIKE'}
          </span>
        </div>
      </div>
      {/* 楼层回复 */}
      {replyCount > 0 && (
        <div className="ac-floor-replies">
          <button
            type="button"
            className="ac-floor-toggle"
            onClick={() => onToggleFloor(comment)}
          >
            {!(floorState && floorState.expanded)
              ? `展开${replyCount}条回复`
              : '收起回复'}
          </button>
          {floorState && floorState.expanded && (
            <div className="ac-floor-panel">
              {floorState.items.length > 0 &&
                floorState.items.map((reply) => (
                  <div key={reply.rpid} className="ac-floor-item">
                    <div className="flex items-center gap-2">
                      <div className="ac-floor-avatar">
                        <img
                          src={proxyBiliImage(reply.avatar)}
                          alt={reply.name || '匿名用户'}
                        />
                      </div>
                      <div className="ac-floor-meta">
                        <span className="ac-floor-username">
                          {reply.name || '匿名用户'}
                        </span>
                        <span className="ac-floor-time">
                          {formatBiliCommentTime(reply.time)}
                          {reply.location ? ` · ${reply.location}` : ''}
                        </span>
                      </div>
                    </div>
                    <div className="ac-floor-main">
                      <BiliCommentText
                        text={reply.content}
                        emote={reply.emote}
                        onCopy={onCommentCopy}
                      />
                      <div className="ac-floor-controls">
                        <div className="ac-floor-control-item cursor-default">
                          <svg viewBox="0 0 1024 1024" width={10} height={10}>
                            <path d={LIKE_PATH} />
                          </svg>
                          <span className="ac-control-text">
                            {reply.like > 0
                              ? formatBiliCount(reply.like)
                              : 'LIKE'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              {floorState.error && (
                <div
                  className="ac-floor-status ac-floor-error"
                  onClick={() => onRetryFloor(comment)}
                >
                  {floorState.error}
                </div>
              )}
              {!floorState.error &&
                !floorState.loading &&
                floorState.items.length === 0 && (
                  <div className="ac-floor-status">暂无回复</div>
                )}
              {floorState.items.length < floorState.total && (
                <button
                  type="button"
                  className="ac-floor-more"
                  disabled={floorState.loading}
                  onClick={() => onLoadMoreFloor(comment)}
                >
                  {floorState.loading ? '加载中...' : '展开更多回复'}
                </button>
              )}
              {floorState.items.length >= floorState.total &&
                floorState.items.length > 0 && (
                  <div className="ac-floor-status">已展示全部回复</div>
                )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
