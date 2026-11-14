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
// 改一处必须同步另一处。纵向只留一点点下沉余量：模型锚点在脚底，继续往下
// 推只会把人推出画面，手感上会像「拖不动」。
export const LIVE2D_DRAG_X_LIMIT = 0.45
export const LIVE2D_DRAG_Y_MIN = -0.55
export const LIVE2D_DRAG_Y_MAX = 0.1

export interface DragOffset {
  /** 正数向右（视口宽度的比例） */
  x: number
  /** 正数向下（视口高度的比例） */
  y: number
}

export function clampDragOffset(x: number, y: number): DragOffset {
  return {
    x: clampAxis(x, -LIVE2D_DRAG_X_LIMIT, LIVE2D_DRAG_X_LIMIT),
    y: clampAxis(y, LIVE2D_DRAG_Y_MIN, LIVE2D_DRAG_Y_MAX),
  }
}

function clampAxis(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}
