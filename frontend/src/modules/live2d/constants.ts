// 房间悬浮层（Live2D）的常量。
//
// 事件名与后端 backend-go/internal/room/live2d_handlers.go 一一对应，
// 改名字必须两边同步（events-parity 只校验上行事件是否注册，不改名就查不出来）。

export const LIVE2D_EVENT = {
  /** C→S：声明/清空自己的模型（低频，有 ack） */
  CONFIG: 'live2d-config',
  /** C→S：指针位置（高频，无 ack） */
  STATE: 'live2d-state',
  /** C→S：挂载/重连后补拉全量快照 */
  REQUEST: 'live2d-request',
  /** S→C：全量快照（只回发起者） */
  SNAPSHOT: 'live2d-snapshot',
  /** S→C：服务端 100ms 合并后的增量 */
  PATCH: 'live2d-patch',
} as const

/** 上行频率。服务端单连接有 40ms 门限，这里留余量。 */
export const LIVE2D_STATE_HZ = 15
export const LIVE2D_STATE_INTERVAL_MS = Math.round(1000 / LIVE2D_STATE_HZ)

/** 指针移动小于该阈值就不发（归一化后 ~0.2% 屏宽，肉眼不可见）。 */
export const LIVE2D_STATE_EPSILON = 0.002

/** 房间内模型上限，与后端 live2dMaxModels 一致。 */
export const LIVE2D_MAX_MODELS = 12

/** 同时渲染的上限：超过这个数量只渲染最近活跃的若干个。 */
export const LIVE2D_MAX_RENDERED = 6

/** 空闲多少毫秒后进入「轻摆」本地动画（不上行，纯观感）。 */
export const LIVE2D_IDLE_MS = 3000

/** 模型在画面里的高度占比（相对视口高），半身像的常见观感。 */
export const LIVE2D_MODEL_HEIGHT_RATIO = 0.42

/** 自定义模型加载超时。CORS 预检 + 几 MB 纹理的现实上限。 */
export const LIVE2D_LOAD_TIMEOUT_MS = 8000
