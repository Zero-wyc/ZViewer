// 房间悬浮层（Live2D）的常量。
//
// 事件名与后端 backend-go/internal/room/live2d_handlers.go 一一对应，
// 改名字必须两边同步（events-parity 只校验上行事件是否注册，不改名就查不出来）。

export const LIVE2D_EVENT = {
  /** C→S：声明/清空自己的模型（低频，有 ack） */
  CONFIG: 'live2d-config',
  /** C→S：指针位置（高频，无 ack） */
  STATE: 'live2d-state',
  /**
   * C→S：拖拽偏移。
   *
   * 客户端**不再发送**（位置已改成本机偏好）。事件名保留是因为服务端仍在
   * 注册与转发（老客户端会发），前端收到也会直接丢掉（见 useLive2DSync）。
   */
  DRAG: 'live2d-drag',
  /** C→S：挂载/重连后补拉全量快照 */
  REQUEST: 'live2d-request',
  /** 表情/动作：C→S 触发，S→C 立刻广播给全房间（瞬时，不走 patch 合并） */
  ACTION: 'live2d-action',
  /** S→C：全量快照（只回发起者） */
  SNAPSHOT: 'live2d-snapshot',
  /** S→C：服务端 100ms 合并后的增量 */
  PATCH: 'live2d-patch',
  /** C→S：房主修改房间级策略（有 ack） */
  POLICY_SET: 'live2d-policy-set',
  /** S→C：房间级策略变更（含下发时的回执，房主自己也会收到） */
  POLICY: 'live2d-policy',
  /**
   * S→C：正在使用的公共库模型被删掉了。
   *
   * 与 SNAPSHOT/PATCH 不同，这条不是「房间状态变了」而是「你的选择失效了」：
   * 服务端先下发 rem 行把画面清掉，再补这一条说明原因，客户端据此换回默认
   * 模型（否则本地会一直指着一个已经不存在、也永远加载不出来的模型）。
   */
  MODEL_REMOVED: 'live2d-model-removed',
  /**
   * 戳一下别人的角色：C→S 上报目标，S→C 广播给全房间。
   *
   * 上下行同名：它是一个「谁戳了谁」的事件，两端看到的是同一件事，没必要
   * 分成两个名字。服务端只做资格与频控判定，不关心里面是什么动作。
   */
  POKE: 'live2d-poke',
} as const

/** 上行频率。服务端单连接有 40ms 门限，这里留余量。 */
export const LIVE2D_STATE_HZ = 15
export const LIVE2D_STATE_INTERVAL_MS = Math.round(1000 / LIVE2D_STATE_HZ)

/** 指针移动小于该阈值就不发（归一化后 ~0.2% 屏宽，肉眼不可见）。 */
export const LIVE2D_STATE_EPSILON = 0.002

/**
 * 停手后多久把「大小」写回本机偏好。
 *
 * 滑杆是连续手势：0.5~2 每档 0.05，拖一次能经过二三十个值。画面由渲染器的
 * `setSelfScale` 实时跟手（纯本地，不碰网络也不碰 React），这里只决定什么时候
 * 落一次 localStorage——250ms 是「停手即记」与「拖动中途不停顿也不会被截断」
 * 之间的折中。以前这个提交会触发上行 live2d-config，现在没有网络参与了。
 */
export const LIVE2D_SCALE_COMMIT_MS = 250

/**
 * 面部数据的有效期。
 *
 * 超过这个时间没收到新的嘴型/睁眼数据，就认为对方不再动捕，把参数还给
 * 引擎自己的眨眼与表情——否则关掉动捕后人会永远停在最后一帧的表情上。
 * 比上报间隔（66ms）宽得多，只用于「断流」判断，正常抖动不会误判。
 */
export const LIVE2D_FACE_TTL_MS = 1200

/** 房间内模型上限，与后端 live2dMaxModels 一致。 */
export const LIVE2D_MAX_MODELS = 12

/**
 * 名字标签检查「谁在说话」的间隔。
 *
 * 语音电平本身是 200ms 一档，这里比它略慢：标签只是提示，不需要跟到每一帧；
 * 而且状态没变化时不会触发任何渲染（见 useSpeakingSids），开销只是一次遍历。
 */
export const LIVE2D_SPEAKING_POLL_MS = 300

/**
 * 「被戳」的抖动时长。
 *
 * 0.45 秒：短到像反射、长到能看清。再长就会和 idle 呼吸撞在一起，
 * 看起来像模型自己在抽搐。
 */
export const LIVE2D_POKE_MS = 450

/** 同时渲染的上限：超过这个数量只渲染最近活跃的若干个。 */
export const LIVE2D_MAX_RENDERED = 6
/** 空闲多少毫秒后进入「轻摆」本地动画（不上行，纯观感）。 */
export const LIVE2D_IDLE_MS = 3000

/** 模型在画面里的高度占比（相对视口高），半身像的常见观感。 */
export const LIVE2D_MODEL_HEIGHT_RATIO = 0.42

/**
 * 模型加载超时。
 *
 * 8 秒只够「几 MB 纹理」的普通模型；4K 素材的整套（moc3 十几 MB + 多张
 * 4096/8192 贴图）光是把 PNG 解成位图就要好几秒，再上传到 GPU 又是几秒，
 * 8 秒会把它判成失败、只留一张占位卡。宁可等久一点，也不要误报失败——
 * 真正的失败（404/CORS/模型损坏）都是立刻返回的，不会拖满超时。
 */
export const LIVE2D_LOAD_TIMEOUT_MS = 45000
