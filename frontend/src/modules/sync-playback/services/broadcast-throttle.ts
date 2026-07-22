/**
 * 广播节流服务
 *
 * 提供房主广播的节流与防抖工具函数，避免高频事件（timeupdate ~250ms）
 * 导致 Socket 流量过大。
 *
 * - `createThrottledBroadcaster`: 节流广播器，固定间隔内最多广播一次
 * - `createDebouncedSeek`: 防抖 seek 广播器，拖动进度条时仅在停止后广播
 */

/**
 * 创建节流广播器。
 *
 * 行为：
 * - 首次调用立即广播
 * - 后续调用若距上次广播不足 throttleMs，跳过
 * - force=true 时跳过节流，立即广播（用于 play/pause/seeked 等离散事件）
 *
 * @param broadcast 实际广播函数
 * @param throttleMs 节流间隔（毫秒）
 * @returns 节流后的广播函数，附带 `flush()` 立即广播最后被节流的调用
 */
export function createThrottledBroadcaster<TArgs extends unknown[]>(
  broadcast: (...args: TArgs) => void,
  throttleMs: number
): (...args: TArgs) => void {
  let lastBroadcastTime = 0

  return (...args: TArgs) => {
    const now = Date.now()
    if (now - lastBroadcastTime > throttleMs) {
      broadcast(...args)
      lastBroadcastTime = now
    }
  }
}

/**
 * 创建强制节流广播器（带 force 参数）。
 *
 * 与 `createThrottledBroadcaster` 的区别：
 * - 第一个参数为 boolean `force`，true 时跳过节流立即广播
 * - 用于离散事件（play/pause/seeked/ratechange）需要即时响应的场景
 *
 * @param broadcast 实际广播函数
 * @param throttleMs 节流间隔（毫秒）
 * @returns (force, ...args) => void
 */
export function createForceThrottledBroadcaster<TArgs extends unknown[]>(
  broadcast: (...args: TArgs) => void,
  throttleMs: number
): (force: boolean, ...args: TArgs) => void {
  let lastBroadcastTime = 0

  return (force: boolean, ...args: TArgs) => {
    const now = Date.now()
    if (force || now - lastBroadcastTime > throttleMs) {
      broadcast(...args)
      lastBroadcastTime = now
    }
  }
}

/**
 * 创建防抖 seek 广播器。
 *
 * 拖动进度条时 seeked 事件会高频触发，直接广播会导致观众端频繁 seek 抖动。
 * 使用防抖：仅在最后一次 seeked 后等待 debounceMs 才广播。
 *
 * @param broadcast 实际广播函数（接收 seek 时间）
 * @param debounceMs 防抖间隔（毫秒）
 * @returns 防抖后的 seek 广播函数，附带 `cancel()` 取消未执行的防抖
 */
export function createDebouncedSeek(
  broadcast: (time: number) => void,
  debounceMs: number
): {
  (time: number): void
  cancel: () => void
} {
  let timer: ReturnType<typeof setTimeout> | null = null

  const debounced = (time: number) => {
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      broadcast(time)
      timer = null
    }, debounceMs)
  }

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  return debounced
}
