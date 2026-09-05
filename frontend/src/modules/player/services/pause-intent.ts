/**
 * 用户暂停意图标记（按 video 元素维度，WeakMap 不阻塞回收）。
 *
 * MKV 走 playsvideo 管线时 attach 需要 5-10 秒，期间用户可能按下暂停；
 * attach 完成后的自动起播（safePlay / restoreSnapshot）若不检查该标记，
 * 会按加载开始时的旧状态覆盖用户的暂停，表现为
 * 「明明已经暂停了，却还有声音输出」。
 *
 * UI 的暂停/播放动作负责维护标记；引擎异步流程在补 play 前用
 * wasUserPaused 检查，用户暂停意图未解除时不得强制起播。
 */
const marks = new WeakMap<HTMLVideoElement, boolean>()

/** 记录「用户主动暂停了该视频」（控制栏暂停按钮等用户动作调用） */
export function markUserPaused(video: HTMLVideoElement): void {
  marks.set(video, true)
}

/** 记录「用户主动恢复了播放」（清除暂停意图） */
export function clearUserPaused(video: HTMLVideoElement): void {
  marks.set(video, false)
}

/** 该视频是否处于用户主动暂停、尚未恢复的状态 */
export function wasUserPaused(video: HTMLVideoElement): boolean {
  return marks.get(video) === true
}
