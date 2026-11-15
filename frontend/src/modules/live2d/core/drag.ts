// 拖拽偏移的取值规则（纯函数，单测覆盖）。
//
// 偏移是「相对槽位基准位置的比例」：0.1 表示向右挪了视口宽度的 10%。
// 为什么用比例而不是像素：各端视口尺寸不同，只有比例才能让「我把角色挪到
// 左边一点」在所有人眼里都是同样的相对位置——这与指针坐标的处理同一套理由。
//
// 基准位置始终由服务端下发的 ord 决定，偏移只是加在它上面的位移：有人进出
// 房间时槽位会重排，偏移跟着人走，不会出现「角色被钉死在屏幕 20% 处、
// 和别人的相对关系全乱」的情况。
//
// 范围与后端 internal/room/live2d_state.go 的 live2dDrag* 常量是同一组值，
// 改一处必须同步另一处。这一层只是**数据合法性**的外圈（防越权/防旧版本乱发），
// 真正的手感边界是下面按模型尺寸算的 clampBoxToView——视口比例与模型大小无关，
// 拿它当边界会让「高度只占 42% 视口的角色」向上挪 55% 后整只出画。
export const LIVE2D_DRAG_X_LIMIT = 0.45
export const LIVE2D_DRAG_Y_MIN = -0.55
export const LIVE2D_DRAG_Y_MAX = 0.1

/**
 * 模型至少要在视口里留下的比例（按模型自身尺寸算）。
 *
 * 水平 0.5：至少一半宽度在画面里，不会只剩一条边。
 * 垂直 0.75：至少 3/4 高度可见，配合下面的「头不许出屏」，杜绝「只剩一个头」。
 * 视口比例做不到这件事：同一个 0.3 的偏移，对矮模型是轻微下移，对高模型
 * 就是把人一半推出屏幕。只有拿模型自己的包围盒算，边界才跟着模型走。
 */
export const LIVE2D_KEEP_X_RATIO = 0.5
export const LIVE2D_KEEP_Y_RATIO = 0.75

export interface DragOffset {
  /** 正数向右（视口宽度的比例） */
  x: number
  /** 正数向下（视口高度的比例） */
  y: number
}

export interface BoxRect {
  x: number
  y: number
  width: number
  height: number
}

export function clampDragOffset(x: number, y: number): DragOffset {
  return {
    x: clampAxis(x, -LIVE2D_DRAG_X_LIMIT, LIVE2D_DRAG_X_LIMIT),
    y: clampAxis(y, LIVE2D_DRAG_Y_MIN, LIVE2D_DRAG_Y_MAX),
  }
}

/**
 * 把模型包围盒压回「可见」的范围，返回需要的位移。
 *
 * 垂直方向有两条规则：
 * 1. 模型放得下时（高度 ≤ 视口）**顶边不许出屏**——头顶就是脸，脸一被裁
 *    观众就认不出是谁了；这条同时给出「往上最多挪到头顶贴边」的自由度，
 *    比一味禁止上移好用。
 * 2. 放不下时（放大过或超长模型）只保证 3/4 视口高有内容，否则一帧都画不出。
 * 底边随便出：脚被裁不影响观感，而模型锚点本来就在脚底。
 *
 * 返回位移而不是直接给坐标：调用方一侧是渲染位置（要就地修正），另一侧是
 * 拖拽偏移（要换算成比例），两者需要的形态不同。
 */
export function clampBoxToView(
  box: BoxRect,
  viewW: number,
  viewH: number
): { dx: number; dy: number } {
  const w = box.width
  const h = box.height
  if (!(w > 0) || !(h > 0) || !(viewW > 0) || !(viewH > 0)) {
    return { dx: 0, dy: 0 }
  }
  // 可见量 = min(右边界, 视口右) − max(左边界, 0)，解出 box.x 的允许区间
  const keepX = Math.min(w, viewW) * LIVE2D_KEEP_X_RATIO
  const keepY = Math.min(h, viewH) * LIVE2D_KEEP_Y_RATIO
  const xLo = keepX - w
  const xHi = viewW - keepX
  const yLo = h <= viewH ? 0 : keepY - h
  const yHi = viewH - keepY
  const nx = clampAxis(box.x, xLo, xHi)
  const ny = clampAxis(box.y, yLo, yHi)
  return { dx: nx - box.x, dy: ny - box.y }
}

/**
 * 模型锚点是 (0.5, 1)（脚底中点），先把锚点还原成包围盒再约束。
 */
export function clampAnchorToView(
  anchorX: number,
  anchorY: number,
  width: number,
  height: number,
  viewW: number,
  viewH: number
): { x: number; y: number } {
  const { dx, dy } = clampBoxToView(
    { x: anchorX - width / 2, y: anchorY - height, width, height },
    viewW,
    viewH
  )
  return { x: anchorX + dx, y: anchorY + dy }
}

/**
 * 把一次拖拽偏移压回「模型仍在画面里」的范围。
 *
 * 拖拽层必须用它而不是只做比例 clamp：否则偏移会继续增长到 -0.55，
 * 而画面早就在 -0.1 处停住了，用户会感觉「手拖了很远模型才动一下」。
 */
export function clampDragToView(input: {
  offset: DragOffset
  /** 未加偏移时的锚点像素坐标（脚底中点） */
  baseX: number
  baseY: number
  /** 模型像素尺寸 */
  width: number
  height: number
  viewW: number
  viewH: number
}): DragOffset {
  const first = clampDragOffset(input.offset.x, input.offset.y)
  const { baseX, baseY, width, height, viewW, viewH } = input
  if (!(width > 0) || !(height > 0) || !(viewW > 0) || !(viewH > 0)) {
    return first
  }
  const anchor = clampAnchorToView(
    baseX + first.x * viewW,
    baseY + first.y * viewH,
    width,
    height,
    viewW,
    viewH
  )
  return clampDragOffset((anchor.x - baseX) / viewW, (anchor.y - baseY) / viewH)
}

function clampAxis(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  if (lo > hi) return (lo + hi) / 2
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}
