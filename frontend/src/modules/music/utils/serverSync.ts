/**
 * 一起听服务器权威同步的纯函数工具（架构对齐一起看 useServerHeartbeat）。
 *
 * 背景：服务器每 2s 广播 music:sync-heartbeat(source='server')，state 的
 * positionSec 已按服务器时间轴外推到「当前时刻」——观众端直接使用，
 * 不再做本地时钟补偿（compensatePositionSec 的跨设备钟差隐患由此消除，
 * 该函数仅保留给房主直发 sync-state / 心跳 fallback 的旧路径）。
 */

/**
 * 判断观众本地进度是否需要向服务器目标进度对齐（seek）。
 *
 * @param currentSec 观众本地进度（audio.currentTime）
 * @param targetSec  服务器权威进度（心跳 state.positionSec，已外推）
 * @param thresholdSec 对齐阈值（秒），默认 2（小偏差自然播放，避免频繁 seek 抖动）
 */
export function needsMusicAlign(
  currentSec: number,
  targetSec: number,
  thresholdSec: number = 2
): boolean {
  if (!Number.isFinite(currentSec) || !Number.isFinite(targetSec)) return false
  return Math.abs(currentSec - targetSec) > thresholdSec
}
