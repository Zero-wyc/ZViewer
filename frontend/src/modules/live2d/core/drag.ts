// 拖拽偏移的取值规则（纯函数，单测覆盖）。
//
// 偏移是「相对槽位基准位置的比例」：0.1 表示向右挪了视口宽度的 10%。
// 用的是比例而不是像素，因为窗口大小会变，只有比例才能让「我心里记的那个
// 位置」在小窗和全屏下都是「往左一点点」，而不是一会儿在画面外一会儿压住人。
//
// **这是纯本机的展示偏移，不同步给任何人**。以前它同时是房间状态：一个人拖动
// 会改掉所有人的画面，各端还得靠「服务端权威值 + 平滑」去对齐。现在每个人
// 只调自己屏幕上的摆法，于是也不需要再和各端算出同一个值。
//
// 既然只是本机观感，就没有「必须留在画面里」的理由：角色可以被拖到完全看不
// 见的地方（把画面让出来）。代价是拖出去之后右键命不中它，回位靠「角色设置 →
// 重置模型位置」或拖拽模式里的「回到原位」——所以这里只留一个防手滑的上限，
// 不再按包围盒把模型夹回可见区。

/**
 * 偏移的绝对值上限（视口宽/高的倍数）。
 *
 * 1.5 保证「足够拖到彻底看不见」（模型本身只占视口的一小部分），同时挡住
 * 拖拽事件里那种荒谬的越界值——偏移过大时 `clampAxis` 之后的数值计算仍然
 * 可信，不会因为一个 NaN/1e9 把模型扔到画布坐标的某个奇怪位置。
 */
export const LIVE2D_DRAG_LIMIT = 1.5

export interface DragOffset {
  /** 正数向右（视口宽度的比例） */
  x: number
  /** 正数向下（视口高度的比例） */
  y: number
}

export function clampDragOffset(x: number, y: number): DragOffset {
  return {
    x: clampAxis(x, -LIVE2D_DRAG_LIMIT, LIVE2D_DRAG_LIMIT),
    y: clampAxis(y, -LIVE2D_DRAG_LIMIT, LIVE2D_DRAG_LIMIT),
  }
}

function clampAxis(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  if (lo > hi) return (lo + hi) / 2
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}
