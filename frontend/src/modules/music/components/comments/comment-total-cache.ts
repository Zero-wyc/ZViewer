/**
 * 评论总数徽章缓存（播放器「评论」切换按钮消费）。
 *
 * 两个评论面板（网易云 / B站）写入，切换按钮与列表面板共读：
 * - targetKey 形如 `song:<songId>` 或 `bili:<bvid>`
 * - 写入后派发 COMMENT_TOTAL_EVENT，切换按钮监听刷新徽章文本
 *
 * 独立成模块，避免 B站 面板反向依赖网易云面板（仅为拿缓存函数）。
 */

/** targetKey → 评论总数（面板写入，切换按钮徽章读取） */
const commentTotalCache = new Map<string, number>()

/** 评论总数变更事件（同刻广播，切换按钮监听刷新徽章） */
export const COMMENT_TOTAL_EVENT = 'zviewer-comment-total'

/** 目标 key（song:<songId>） */
export function getCommentTargetKey(songId: number): string {
  return songId > 0 ? `song:${songId}` : ''
}

/** 读取已缓存的评论总数（未缓存返回 undefined） */
export function getCommentTotal(targetKey: string): number | undefined {
  return commentTotalCache.get(targetKey)
}

/** 万位缩写徽章文本（Hydrogen commentCountBadge 语义） */
export function getCommentCountBadge(targetKey: string): string {
  const n = commentTotalCache.get(targetKey) ?? 0
  if (n >= 10_000) {
    return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}w+`
  }
  return String(n)
}

/** 写入评论总数缓存并广播（B站 评论区面板复用同一徽章通道） */
export function setCommentTotal(targetKey: string, total: number): void {
  if (!targetKey) return
  commentTotalCache.set(targetKey, total)
  window.dispatchEvent(new CustomEvent(COMMENT_TOTAL_EVENT))
}

/** 徽章缓存是否已有该目标的评论总数（预取去重用） */
export function hasCommentTotal(targetKey: string): boolean {
  return commentTotalCache.has(targetKey)
}
