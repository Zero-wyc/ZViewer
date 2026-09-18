/**
 * 一起听同步进度计算（纯函数，无运行时依赖，供 useListenTogether 与单测共用）。
 */
import type { MusicSyncState } from '../types'

/** 传输延迟补偿上限（秒）：updatedAt 与本地时钟偏差超过该值视为时钟不同源，
 *  放弃补偿（防止两台机器系统时间差导致进度被推到离谱位置） */
export const SYNC_COMPENSATION_MAX_SEC = 10

/**
 * 按 updatedAt 外推当前进度（传输延迟补偿）：
 * payload.positionSec 是房主构建快照那一刻的进度，观众收到时已过去
 * 网络传输 + 排队延迟；播放中按 elapsed 外推，暂停态原样返回。
 * updatedAt 缺失/时钟倒挂/偏差超限时退回原始值（跨设备系统时钟不同源）。
 */
export function compensatePositionSec(payload: MusicSyncState): number {
  if (!payload.isPlaying || !Number.isFinite(payload.updatedAt)) {
    return payload.positionSec
  }
  const elapsed = (Date.now() - payload.updatedAt) / 1000
  if (elapsed <= 0 || elapsed > SYNC_COMPENSATION_MAX_SEC) {
    return payload.positionSec
  }
  return payload.positionSec + elapsed
}
