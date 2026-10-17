/**
 * 评论面板共用装饰组件。
 *
 * 网易云 / B站 两个评论面板原本各自复制了角标框架、分区标题与状态框，
 * 这里收敛为单一实现（class 名与 DOM 结构必须与 ac-* 样式表保持一致）。
 */

/** 点赞图标路径（列表卡片与楼层共用） */
export const LIKE_PATH =
  'M736.603 35.674c-87.909 0-169.647 44.1-223.447 116.819C459.387 79.756 377.665 35.674 289.708 35.674c-158.47 0-287.397 140.958-287.397 314.233 0 103.371 46.177 175.887 83.296 234.151 107.88 169.236 379.126 379.846 390.616 388.725 11.068 8.557 24.007 12.837 36.917 12.837 12.939 0 25.861-4.28 36.917-12.837 11.503-8.879 282.765-219.488 390.614-388.725C977.808 525.793 1024 453.277 1024 349.907 1023.999 176.632 895.071 35.674 736.603 35.674z'

/** 四角角标装饰（绝对定位在相对容器内） */
export function FrameCorners() {
  return (
    <>
      <div className="ac-frame-corner ac-frame-tl" aria-hidden="true" />
      <div className="ac-frame-corner ac-frame-tr" aria-hidden="true" />
      <div className="ac-frame-corner ac-frame-bl" aria-hidden="true" />
      <div className="ac-frame-corner ac-frame-br" aria-hidden="true" />
    </>
  )
}

/** 分区标题（HOT COMMENTS / LATEST COMMENTS [n] + 右侧分隔线） */
export function CommentSectionHeader({
  title,
  count,
}: {
  title: string
  count: number
}) {
  return (
    <div className="ac-section-header">
      <div>
        <span className="ac-section-title">{title}</span>
        <span className="ac-section-count">[{count}]</span>
      </div>
      <div className="ac-section-line" />
    </div>
  )
}

/** 底部状态框：加载中 / 暂无更多 / 暂无评论 */
export function CommentStatus({
  kind,
}: {
  kind: 'loading' | 'empty' | 'noMore'
}) {
  return (
    <div className="ac-status-section">
      <div className="ac-status-frame relative">
        <FrameCorners />
        {kind === 'loading' ? (
          <div className="ac-loading-content">
            <div className="ac-loading-indicator" />
            <span className="ac-status-text">LOADING...</span>
          </div>
        ) : (
          <span className="ac-status-text">
            {kind === 'noMore' ? 'NO MORE COMMENTS' : 'NO COMMENTS YET'}
          </span>
        )}
      </div>
    </div>
  )
}
