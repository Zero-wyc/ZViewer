/**
 * 评论面板外壳。
 *
 * 网易云 / B站 两个面板的滚动容器、标题框、HOT/LATEST 分区与底部状态
 * 完全同构，差异只在卡片渲染与顶部输入/提示区——后者通过 headerExtra
 * 插槽传入。
 *
 * 布局契约（ac-* class 由 comments/style.ts 提供）：
 *   .arknights-comments > COMMENTS 标题 → headerExtra → HOT → LATEST → 状态
 */
import type { ReactNode, RefObject } from 'react'
import {
  CommentSectionHeader,
  CommentStatus,
  FrameCorners,
} from './CommentChrome'
import { COMMENTS_STYLE } from './style'

export interface CommentShellProps {
  /** 滚动容器（外层复用 ref 做「切目标回顶」与距底分页） */
  containerRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  /** 标题下方的补充区（输入框 / 游客提示等） */
  headerExtra?: ReactNode
  /** 热度评论条目 */
  hot: ReactNode
  hotCount: number
  /** 最新评论条目 */
  list: ReactNode
  /** 最新评论总数（分区标题右侧计数） */
  total: number
  /** 最新评论已渲染条数（决定「暂无更多 / 暂无评论」） */
  listCount: number
  loading: boolean
  hasMore: boolean
}

export function CommentsShell({
  containerRef,
  onScroll,
  headerExtra,
  hot,
  hotCount,
  list,
  total,
  listCount,
  loading,
  hasMore,
}: CommentShellProps) {
  const showEmpty = !loading && listCount === 0 && hotCount === 0
  const showNoMore = !hasMore && listCount > 0

  return (
    <div ref={containerRef} onScroll={onScroll} className="arknights-comments">
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

      {headerExtra}

      {/* HOT COMMENTS */}
      {hotCount > 0 && (
        <div>
          <CommentSectionHeader title="HOT COMMENTS" count={hotCount} />
          {hot}
        </div>
      )}

      {/* LATEST COMMENTS */}
      <div>
        <CommentSectionHeader title="LATEST COMMENTS" count={total} />
        {list}
      </div>

      {/* 状态区（加载中 / 暂无更多 / 无评论） */}
      {loading && <CommentStatus kind="loading" />}
      {showNoMore && <CommentStatus kind="noMore" />}
      {showEmpty && <CommentStatus kind="empty" />}
    </div>
  )
}
