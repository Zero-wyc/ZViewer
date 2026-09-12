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
import { apiGet } from '@/lib/api'
import { message } from '@/components/ui/message'
import { useMusicStore } from '../store'
import { useMusicPlayer } from '../hooks/useMusicPlayer'
import { cn } from '@/lib/utils'
import { parseTextWithEmoji } from '../utils/neteaseEmoji'

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

/** 相对时间格式化（Hydrogen commentFormat.formatCommentTime 同值） */
function formatCommentTime(timestamp: number): string {
  const ts = Number(timestamp)
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

// ==================== 评论数缓存（播放器切换按钮徽章消费） ====================

/** targetKey → 评论总数（面板写入，切换按钮徽章读取） */
const commentTotalCache = new Map<string, number>()

/** 评论总数变更事件（同刻广播，切换按钮监听刷新徽章） */
export const COMMENT_TOTAL_EVENT = 'zviewer-comment-total'

/** 目标 key（song:<songId>） */
export function getCommentTargetKey(songId: number): string {
  return songId > 0 ? `song:${songId}` : ''
}

/** 万位缩写徽章文本（Hydrogen commentCountBadge 语义） */
export function getCommentCountBadge(targetKey: string): string {
  const n = commentTotalCache.get(targetKey) ?? 0
  if (n >= 10_000) {
    return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}w+`
  }
  return String(n)
}

// ==================== 样式（Hydrogen Comments.vue scoped SCSS 平替） ====================

const COMMENTS_STYLE = `
.arknights-comments {
  --ac-border: rgba(0, 0, 0, 0.75);
  --ac-soft-bg: rgba(255, 255, 255, 0.6);
  --ac-card-bg: rgba(255, 255, 255, 0.55);
  --ac-ink: #1a1a1a;
  --ac-muted: rgba(26, 26, 26, 0.6);
  --ac-ink-contrast: #fff;
  height: 100%;
  padding: 20px;
  overflow-y: auto;
  background-color: rgba(255, 255, 255, 0.35);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  color: var(--ac-ink);
  font-family: 'Bender-Bold', 'SourceHanSansCN-Bold', sans-serif;
}
html.dark .arknights-comments {
  --ac-border: rgba(255, 255, 255, 0.85);
  --ac-soft-bg: rgba(255, 255, 255, 0.08);
  --ac-card-bg: rgba(255, 255, 255, 0.08);
  --ac-ink: #f5f5f5;
  --ac-muted: rgba(245, 245, 245, 0.6);
  --ac-ink-contrast: #000;
  background-color: rgba(0, 0, 0, 0.25);
}
.arknights-comments::-webkit-scrollbar { width: 3px; }
.arknights-comments::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.3); border-radius: 2px;
}
html.dark .arknights-comments::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
}
.ac-frame-corner {
  width: 8px; height: 8px; position: absolute; z-index: 1; pointer-events: none;
}
.ac-frame-tl { top: 0; left: 0; border-top: 2px solid var(--ac-border); border-left: 2px solid var(--ac-border); }
.ac-frame-tr { top: 0; right: 0; border-top: 2px solid var(--ac-border); border-right: 2px solid var(--ac-border); }
.ac-frame-bl { bottom: 0; left: 0; border-bottom: 2px solid var(--ac-border); border-left: 2px solid var(--ac-border); }
.ac-frame-br { bottom: 0; right: 0; border-bottom: 2px solid var(--ac-border); border-right: 2px solid var(--ac-border); }
.ac-comments-header { margin-bottom: 14px; }
.ac-header-frame {
  position: relative; height: 56px; display: flex; align-items: center; justify-content: center;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-header-title { font-size: 17px; font-weight: 800; letter-spacing: 0.3em; color: var(--ac-ink); }
.ac-title-underline { width: 64px; height: 2px; margin-top: 6px; margin-left: auto; margin-right: auto; background: var(--ac-ink); }
.ac-comment-input-section { margin-bottom: 16px; }
.ac-input-frame {
  position: relative; padding: 12px;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-comment-textarea {
  min-height: 80px; width: 100%; resize: vertical; padding: 10px 12px;
  border: none; outline: none; display: block;
  background-color: var(--ac-soft-bg); color: var(--ac-ink);
  font-size: 13px; line-height: 1.6;
}
.ac-comment-textarea::placeholder { color: var(--ac-muted); }
.ac-input-border {
  position: absolute; inset: 0;
  border: 2px solid color-mix(in srgb, var(--ac-border) 30%, transparent);
  pointer-events: none; transition: border-color 0.2s;
}
.ac-comment-textarea:focus ~ .ac-input-border { border-color: var(--ac-border); }
.ac-input-actions { margin-top: 10px; display: flex; align-items: center; justify-content: space-between; }
.ac-shortcut-hint { font-size: 10px; letter-spacing: 0.2em; color: var(--ac-muted); }
.ac-submit-button {
  padding: 10px 20px; border: none; cursor: pointer;
  background-color: var(--ac-border); color: var(--ac-ink-contrast);
  font-size: 12px; font-weight: 800; letter-spacing: 0.2em;
  transition: 0.15s;
}
.ac-submit-button:hover:not(:disabled) { transform: translateY(-1px); }
.ac-submit-button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
.ac-login-prompt { margin-bottom: 16px; }
.ac-prompt-frame {
  position: relative; padding: 14px; text-align: center;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-prompt-text { font-size: 11px; letter-spacing: 0.25em; color: var(--ac-muted); }
.ac-section-header { margin: 18px 0 12px; display: flex; align-items: center; gap: 10px; }
.ac-section-title { font-size: 13px; font-weight: 800; letter-spacing: 0.2em; color: var(--ac-ink); }
.ac-section-count { font-size: 11px; font-weight: 700; color: var(--ac-muted); margin-left: 6px; }
.ac-section-line { flex: 1; height: 1px; background: color-mix(in srgb, var(--ac-border) 30%, transparent); }
.ac-comment-card {
  position: relative; padding: 14px 16px; margin-bottom: 10px;
  background-color: var(--ac-card-bg);
  border-left: 3px solid color-mix(in srgb, var(--ac-border) 28%, transparent);
  transition: transform 0.15s, box-shadow 0.15s;
}
.ac-comment-card:hover { transform: translateY(-1px); box-shadow: 0 3px 10px rgba(0,0,0,0.12); }
.ac-hot-card { border-left-color: rgba(233, 192, 104, 0.76); }
.ac-comment-meta { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.ac-user-avatar { position: relative; width: 28px; height: 28px; }
.ac-user-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ac-avatar-frame {
  position: absolute; inset: -2px;
  border: 2px solid color-mix(in srgb, var(--ac-border) 22%, transparent);
  pointer-events: none;
}
.ac-user-info { display: flex; flex-direction: column; min-width: 0; }
.ac-username { font-size: 13px; font-weight: 800; color: var(--ac-ink); }
.ac-timestamp { font-size: 10px; color: var(--ac-muted); }
.ac-comment-text {
  font-size: 14px; line-height: 1.7; color: var(--ac-ink); cursor: text; user-select: text;
}
.ac-emoji-img { width: 22px; height: 22px; vertical-align: -6px; margin: 0 1px; }
.ac-emoji-text { font-size: 18px; vertical-align: -2px; }
.ac-comment-controls { margin-top: 10px; display: flex; align-items: center; gap: 12px; }
.ac-control-item {
  display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
  padding: 3px 8px; border-radius: 3px;
  background-color: color-mix(in srgb, var(--ac-border) 10%, transparent);
  color: var(--ac-muted); font-size: 11px; font-weight: 700;
  transition: 0.15s;
}
.ac-control-item:hover {
  background-color: color-mix(in srgb, var(--ac-border) 18%, transparent);
  color: var(--ac-ink);
}
.ac-control-item svg { fill: currentColor; opacity: 0.75; }
.ac-control-item.ac-active { color: #ff4757; }
.ac-control-item.ac-active svg { opacity: 1; }
.ac-floor-replies { margin-top: 10px; }
.ac-floor-toggle {
  padding: 4px 10px; border: none; cursor: pointer;
  background-color: color-mix(in srgb, var(--ac-border) 12%, transparent);
  color: var(--ac-ink); font-size: 11px; font-weight: 700;
  transition: 0.15s;
}
.ac-floor-toggle:hover {
  background-color: color-mix(in srgb, var(--ac-border) 22%, transparent);
}
.ac-floor-panel {
  margin-top: 8px; padding: 8px;
  background-color: color-mix(in srgb, var(--ac-soft-bg) 40%, transparent);
  border: 1px solid color-mix(in srgb, var(--ac-border) 25%, transparent);
}
.ac-floor-item {
  padding: 8px 10px;
  border-left: 2px solid color-mix(in srgb, var(--ac-border) 30%, transparent);
}
.ac-floor-item + .ac-floor-item { margin-top: 6px; }
.ac-floor-avatar { width: 22px; height: 22px; overflow: hidden; }
.ac-floor-avatar img { width: 100%; height: 100%; object-fit: cover; }
.ac-floor-meta { display: flex; align-items: baseline; gap: 8px; }
.ac-floor-username { font-size: 12px; font-weight: 800; color: var(--ac-ink); }
.ac-floor-time { font-size: 10px; color: var(--ac-muted); }
.ac-floor-main { margin-left: 30px; }
.ac-floor-controls { margin-top: 4px; display: flex; align-items: center; gap: 10px; }
.ac-floor-control-item {
  display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
  font-size: 10px; font-weight: 700; color: var(--ac-muted);
}
.ac-floor-control-item:hover { color: var(--ac-ink); }
.ac-floor-control-item svg { fill: currentColor; opacity: 0.75; }
.ac-floor-control-item.ac-active { color: #ff4757; }
.ac-floor-control-item.ac-active svg { opacity: 1; }
.ac-floor-status { margin-top: 8px; padding: 4px 10px; font-size: 11px; color: var(--ac-muted); }
.ac-floor-error { cursor: pointer; color: #ff4757; }
.ac-floor-more {
  margin-top: 8px; width: 100%; padding: 6px; border: none; cursor: pointer;
  background-color: color-mix(in srgb, var(--ac-border) 10%, transparent);
  color: var(--ac-ink); font-size: 11px; font-weight: 700;
}
.ac-floor-more:disabled { opacity: 0.6; cursor: wait; }
.ac-inline-reply-box {
  position: relative; margin-top: 10px; padding: 12px;
  border: 1px solid color-mix(in srgb, var(--ac-border) 35%, transparent);
}
.ac-reply-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 8px;
  padding-left: 8px; border-left: 2px solid var(--ac-border);
}
.ac-reply-prefix { font-size: 10px; font-weight: 800; letter-spacing: 0.15em; color: var(--ac-muted); }
.ac-reply-target {
  flex: 1; min-width: 0; font-size: 12px; font-weight: 800; color: var(--ac-ink);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ac-close-reply {
  cursor: pointer; font-size: 14px; font-weight: 700;
  color: var(--ac-muted); padding: 0 6px;
}
.ac-close-reply:hover { color: #ff4757; }
.ac-reply-textarea {
  min-height: 52px; width: 100%; resize: vertical; padding: 8px 10px;
  border: none; outline: none; display: block;
  background-color: var(--ac-soft-bg); color: var(--ac-ink); font-size: 12px;
}
.ac-reply-textarea::placeholder { color: var(--ac-muted); }
.ac-reply-input-border {
  height: 2px; margin-top: 2px;
  background-color: color-mix(in srgb, var(--ac-border) 25%, transparent);
}
.ac-reply-actions { margin-top: 8px; display: flex; align-items: center; justify-content: space-between; }
.ac-reply-buttons { display: flex; gap: 8px; }
.ac-cancel-reply-btn {
  padding: 8px 14px; border: none; cursor: pointer;
  background-color: color-mix(in srgb, var(--ac-border) 12%, transparent);
  color: var(--ac-muted); font-size: 11px; font-weight: 800;
}
.ac-cancel-reply-btn:hover { color: var(--ac-ink); }
.ac-send-reply-btn {
  padding: 8px 18px; border: none; cursor: pointer;
  background-color: var(--ac-border); color: var(--ac-ink-contrast);
  font-size: 12px; font-weight: 800;
}
.ac-send-reply-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ac-status-section { margin-top: 16px; }
.ac-status-frame {
  position: relative; padding: 14px; text-align: center; margin-bottom: 8px;
  border: 1px solid color-mix(in srgb, var(--ac-border) 40%, transparent);
}
.ac-status-text { font-size: 11px; letter-spacing: 0.2em; color: var(--ac-muted); }
.ac-loading-content { display: flex; align-items: center; justify-content: center; gap: 10px; }
.ac-loading-indicator {
  width: 16px; height: 16px;
  border: 2px solid color-mix(in srgb, var(--ac-border) 25%, transparent);
  border-top-color: var(--ac-border); border-radius: 50%;
  animation: ac-spin 0.9s linear infinite;
}
@keyframes ac-spin { to { transform: rotate(360deg); } }
`

// ==================== 小部件 ====================

const LIKE_PATH =
  'M736.603 35.674c-87.909 0-169.647 44.1-223.447 116.819C459.387 79.756 377.665 35.674 289.708 35.674c-158.47 0-287.397 140.958-287.397 314.233 0 103.371 46.177 175.887 83.296 234.151 107.88 169.236 379.126 379.846 390.616 388.725 11.068 8.557 24.007 12.837 36.917 12.837 12.939 0 25.861-4.28 36.917-12.837 11.503-8.879 282.765-219.488 390.614-388.725C977.808 525.793 1024 453.277 1024 349.907 1023.999 176.632 895.071 35.674 736.603 35.674z'
const REPLY_PATH =
  'M853.333333 85.333333a85.333333 85.333333 0 0 1 85.333334 85.333334v469.333333a85.333333 85.333333 0 0 1-85.333334 85.333333H298.666667L128 896V170.666667a85.333333 85.333333 0 0 1 85.333333-85.333334h640z m0 85.333334H213.333333v530.773333L285.44 640H853.333333V170.666667z m-256 128v85.333333H256v-85.333333h341.333333z m0 170.666666v85.333334H256v-85.333334h341.333333z'

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
        void navigator.clipboard
          ?.writeText(text)
          .then(() => onCopy(true))
          .catch(() => onCopy(false))
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
    commentTotalCache.set(commentTargetKey, 0)
    window.dispatchEvent(new CustomEvent(COMMENT_TOTAL_EVENT))

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
    if (commentTotalCache.get(commentTargetKey) !== total) {
      commentTotalCache.set(commentTargetKey, total)
      window.dispatchEvent(new CustomEvent(COMMENT_TOTAL_EVENT))
    }
  }, [commentTargetKey, total])

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
            <span className="ac-prompt-text">LOGIN REQUIRED TO COMMENT</span>
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
