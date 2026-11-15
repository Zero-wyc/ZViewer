import { useState } from 'react'

/**
 * 模型条目左侧的方形缩略图。
 *
 * 图是服务端从模型自带贴图（图集）缩出来的，不是渲染好的立绘——只能看配色
 * 与画风，所以做得小、不加边框：它是「别选错」的辅助，不该抢名字的位置。
 *
 * 没有图时退回首字方块而不是留空：条目高度必须一致，否则两列网格会错位。
 */
export function ModelThumb({
  label,
  src,
  size = 26,
}: {
  label: string
  /** 缩略图地址；没有就画首字 */
  src?: string
  size?: number
}) {
  // 清单可能比磁盘旧（模型刚被删、缩略图生成失败），加载失败就退回首字。
  const [broken, setBroken] = useState(false)
  const initial = Array.from(label)[0] ?? '?'
  return (
    <span
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-[6px]"
      style={{
        width: size,
        height: size,
        background: 'var(--md-sys-color-surface-container-high)',
      }}
    >
      {src && !broken ? (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setBroken(true)}
          className="h-full w-full object-contain"
        />
      ) : (
        <span
          className="opacity-55"
          style={{ fontSize: Math.max(9, Math.round(size * 0.4)) }}
        >
          {initial}
        </span>
      )}
    </span>
  )
}
