/**
 * 统一 seek 服务。
 *
 * 替代旧的 mse-reload.ts + run-mse-reload.ts。
 *
 * 核心改进：
 * - 不重建 MediaSource，调用 引擎 seekTo（窗口化清理 + 缓存的 init segment + Range 下载）
 * - 统一锁管理 + UI 状态 + 事件抑制
 * - 所有 seek 场景（房主本地、观众跟随、观众控制指令）共用同一入口
 * - MSE seek 失败时（如 video.error），调用 onSeekFailed 回调让上层 forceReload
 * - 锁占用期间到达的新 seek 目标会被记录，锁释放后接续处理（连续拖拽不丢目标）
 */
import type { MutableRefObject } from 'react'
import type { WatchTogetherState } from '../types'
import { useRoomStore } from '@/store/roomStore'
import {
  getGapFromLiveEdge,
  isInBufferedRange,
  isMseStream,
  FORWARD_BUFFER_TOLERANCE_SEC,
} from './seek-strategy'

/**
 * seekTo 返回结果。
 * - success: seek 是否成功执行
 * - needReload: 是否需要上层 forceReload（video.error / InvalidStateError 等不可恢复错误）
 *   false 表示正常 abort（并发操作）/ superseded / 非 MSE 流，不需要 reload
 * - message: 失败原因（用于日志）
 */
export interface SeekToResult {
  success: boolean
  needReload?: boolean
  /** true 表示另一个执行流正在对同一 video 执行 MSE seek（本次未执行） */
  busy?: boolean
  message?: string
}

export interface ExecuteSeekParams {
  video: HTMLVideoElement
  targetTime: number
  /** 当前播放状态（用于判断是否 MSE 流） */
  state: WatchTogetherState
  /** usePlayerSource.seekTo：调用 引擎 seekTo */
  seekTo: (video: HTMLVideoElement, targetTime: number) => Promise<SeekToResult>
  /** 事件抑制 ref */
  suppressEventsRef: MutableRefObject<boolean>
  /** seek 并发锁 */
  isReloadingRef: MutableRefObject<boolean>
  /** MSE seek 失败时调用（如 video.error），上层用 forceReload 重新加载 */
  onSeekFailed?: (video: HTMLVideoElement, targetTime: number) => Promise<void>
}

/**
 * 锁占用期间到达的待处理 seek 目标（按 video 元素记录，仅保留最新值）。
 * 连续拖拽进度条时每次 mouseup 都触发 seeking，锁内到达的目标不再被丢弃，
 * 由持有锁的执行流完成后接续处理，避免视频停在无数据的中间位置。
 */
const pendingSeekTargets = new WeakMap<HTMLVideoElement, number>()

/** 设置 video.currentTime（忽略异常） */
function setCurrentTimeSafe(video: HTMLVideoElement, time: number): void {
  try {
    video.currentTime = time
  } catch {
    /* ignore */
  }
}

/**
 * 统一 seek 入口。
 *
 * 判断逻辑：
 * 1. 非 MSE 流 → 返回 false（调用方执行普通 seek）
 * 2. 目标时间在已缓冲范围内 → 返回 false（调用方执行普通 seek）
 * 3. 目标紧贴活动缓冲边缘（缺口 ≤ FORWARD_BUFFER_TOLERANCE_SEC）→ 返回 false，
 *    顺序下载很快补上缺口，避免全量 MSE 重载的清理与重建开销
 * 4. 其余（向前跳远 / 向后跳到未缓冲区域）→ 调用 seekTo 执行 MSE Range seek，
 *    直接定位到目标点下载，不再干等后台顺序下载穿过整个缺口
 *    - seek 成功 → 返回 true
 *    - seek 失败 → 调用 onSeekFailed（forceReload）→ 返回 true（已处理）
 *
 * @returns true 表示已处理（MSE seek / forceReload / 已记录待处理目标），
 *          false 表示调用方应执行普通 seek
 */
export async function executeSeek(params: ExecuteSeekParams): Promise<boolean> {
  const {
    video,
    targetTime,
    state,
    seekTo,
    suppressEventsRef,
    isReloadingRef,
    onSeekFailed,
  } = params

  // 并发：锁被占用时记录最新目标，由持有锁的执行流完成后接续处理。
  // 返回 true 表示已接管，调用方不要再设置 currentTime（等待接续的 seek 完成）。
  if (isReloadingRef.current) {
    pendingSeekTargets.set(video, targetTime)
    return true
  }

  // 非 MSE 流，普通 seek
  if (!isMseStream(state) || !state.sourceUrl) return false

  // 目标时间在已缓冲范围内，普通 seek
  if (isInBufferedRange(video, targetTime)) return false

  // 目标紧贴活动缓冲边缘：普通 seek，顺序下载自然补上小缺口。
  // 缺口过大则必须 MSE Range seek（否则要等下载穿过整个缺口，跳转极慢）。
  const liveGap = getGapFromLiveEdge(video, targetTime)
  if (liveGap !== null && liveGap <= FORWARD_BUFFER_TOLERANCE_SEC) {
    return false
  }

  /** 执行一次 MSE seek（含失败兜底），返回 true 表示已处理 */
  const attemptMseSeek = async (target: number): Promise<boolean> => {
    useRoomStore.getState().setReloadingState(true, target)
    try {
      const result = await seekTo(video, target)
      if (result.success) {
        return true
      }
      // 另一个执行流正在对同一 video 执行 MSE seek（跨锁并发）：
      // 把目标挂到共享待处理队列，由进行中的执行流完成后接续，
      // 不能走失败兜底（兜底回设 currentTime 会把进度拉回旧目标）
      if (result.busy) {
        pendingSeekTargets.set(video, target)
        return true
      }
      // seek 失败但不需要 reload（正常 abort / superseded / 并发取消）
      // → fallback 到普通 seek，不触发 forceReload
      if (!result.needReload) {
        setCurrentTimeSafe(video, target)
        return false
      }
      // needReload=true（video.error / InvalidStateError / 网络错误等不可恢复错误）
      // → 调用 onSeekFailed 让上层 forceReload 创建全新 DASH 引擎实例
      if (onSeekFailed) {
        console.warn(
          '[seek-service] MSE seek 不可恢复失败，调用 forceReload 重新加载:',
          result.message
        )
        await onSeekFailed(video, target)
        return true
      }
      // 没有 onSeekFailed 回调，fallback 到普通 seek
      setCurrentTimeSafe(video, target)
      return false
    } catch (err) {
      console.error('[seek-service] MSE seek 异常:', err)
      // 异常时也尝试 forceReload（可能是未预期的错误）
      if (onSeekFailed) {
        try {
          await onSeekFailed(video, target)
          return true
        } catch (reloadErr) {
          console.error('[seek-service] forceReload 也失败:', reloadErr)
        }
      }
      setCurrentTimeSafe(video, target)
      return false
    }
  }

  // 执行 MSE seek
  isReloadingRef.current = true
  suppressEventsRef.current = true
  // 清除可能残留的过期待处理目标（上次 seek 兜底 break 时未消费的），
  // 只接受本次锁占用期间到达的新目标
  pendingSeekTargets.delete(video)
  useRoomStore.getState().setReloadingState(true, targetTime)

  let handled = false
  let currentTarget = targetTime
  try {
    for (;;) {
      const ok = await attemptMseSeek(currentTarget)
      handled = handled || ok
      if (!ok) break

      // 检查锁占用期间到达的新目标（连续拖拽场景）
      const pending = pendingSeekTargets.get(video)
      if (pending === undefined) break
      pendingSeekTargets.delete(video)
      if (Math.abs(pending - currentTarget) < 0.5) break

      currentTarget = pending
      // 新目标已在缓冲内（例如回到了刚填好的区域）→ 普通 seek 即可，结束
      if (isInBufferedRange(video, currentTarget)) {
        setCurrentTimeSafe(video, currentTarget)
        handled = true
        break
      }
      // 新目标紧贴活动缓冲边缘 → 普通 seek 等下载补上，结束
      const pendingGap = getGapFromLiveEdge(video, currentTarget)
      if (pendingGap !== null && pendingGap <= FORWARD_BUFFER_TOLERANCE_SEC) {
        setCurrentTimeSafe(video, currentTarget)
        handled = true
        break
      }
      // 否则继续循环，对新目标再执行一次 MSE seek
    }
  } finally {
    isReloadingRef.current = false
    suppressEventsRef.current = false
    useRoomStore.getState().setReloadingState(false, null)
    // MSE seek 期间的 seeked 事件被 suppressEventsRef 吞掉（不发 seek 控制指令、
    // 不更新服务器播放记忆），房主断线后外推基线会停留在 seek 前的旧进度。
    // 此处补发一次 seeked 事件走正常广播链（handleSeeked 内有防抖与等价判断，
    // 不会重复广播；handleSeeked 只广播、不会再触发 seek，无循环风险）。
    if (handled) {
      video.dispatchEvent(new Event('seeked'))
    }
  }
  return handled
}
