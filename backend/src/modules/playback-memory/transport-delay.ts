/**
 * 写侧传输延迟补偿（Step 1：服务器权威化写入）。
 *
 * 参考 synctv 的 calculateTimeDiff + SetStatus 设计：
 * 房主上报的 currentTime 是「客户端发出时刻」的进度，到达服务器时若仍在播放，
 * 实际进度已前进了 (now - clientTs) × playbackRate。将这段在途时间补回后再
 * 写入播放记忆基线，使服务器记录的进度锚定在服务器时间轴上——这是后续
 * 「观众进度统一改读服务器推算值」(Step 2) 的前提。
 *
 * 时钟假设与钳位（与 synctv 一致）：
 * - 假设客户端时钟与服务器时钟大体同步；客户端时钟快于服务器时
 *   (now - clientTs) < 0，钳为 0（不回拨进度）。
 * - 客户端时钟偏慢或网络异常时延迟可能虚高，钳位上限 1.5s，
 *   防止异常钟差造成大跳变。典型局域网/同机房延迟远低于此。
 * - 暂停态进度凝固，无在途推进，不补偿（对应 synctv SetStatus 的 paused 分支）。
 */

/** 传输延迟补偿上限（秒） */
export const TRANSPORT_DELAY_COMPENSATION_MAX_SEC = 1.5;

export interface CompensateTransportDelayParams {
  /** 客户端上报的播放进度（秒） */
  currentTime: number;
  /** 客户端发送时刻的 Unix 毫秒时间戳；缺省或非法时不补偿 */
  clientTs?: number;
  /** 播放倍速 */
  playbackRate: number;
  /** 是否正在播放（暂停态不补偿） */
  isPlaying: boolean;
  /** 服务器当前时间（毫秒），默认 Date.now()，测试可注入 */
  now?: number;
}

/**
 * 计算补偿后的播放进度。
 *
 * 补偿公式（参考 synctv Current.SetStatus）：
 *   currentTime += clamp((now - clientTs) / 1000, 0, 1.5) × playbackRate （仅播放中）
 *
 * @returns 补偿后的进度（秒）。clientTs 缺省/非法、暂停、倍速非法时原样返回。
 */
export function compensateTransportDelay({
  currentTime,
  clientTs,
  playbackRate,
  isPlaying,
  now = Date.now(),
}: CompensateTransportDelayParams): number {
  if (clientTs == null || !Number.isFinite(clientTs) || clientTs <= 0) {
    return currentTime;
  }
  // 暂停态进度凝固：客户端发出与服务器收到之间进度不变
  if (!isPlaying) return currentTime;
  if (!Number.isFinite(currentTime) || !(playbackRate > 0)) return currentTime;

  const delaySec = (now - clientTs) / 1000;
  // 客户端时钟快于服务器（或同刻到达）：钳为 0，不回拨
  if (!Number.isFinite(delaySec) || delaySec <= 0) return currentTime;
  const clampedSec = Math.min(delaySec, TRANSPORT_DELAY_COMPENSATION_MAX_SEC);

  return currentTime + clampedSec * playbackRate;
}
