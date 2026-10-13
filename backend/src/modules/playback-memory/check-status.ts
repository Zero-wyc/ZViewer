/**
 * 观众主动自检（CHECK_STATUS，Step 3）判定逻辑。
 *
 * 参考 synctv 的 CHECK_STATUS / needsSync 设计：客户端周期性上报自己的本地
 * 播放状态，服务端与权威推算状态比对，偏差超出容差才下发权威进度——作为
 * 服务器周期心跳（每 2s）丢失（socket 重连窗口 / 网络抖动）时的自愈通道。
 *
 * 与 synctv needsSync 的差异：
 * - 不比对 playbackRate：观众端软同步追赶会临时 +0.1 倍速，比对倍速会
 *   在追赶期误触发纠偏打断收敛；倍速分歧会很快体现为进度分歧（或被
 *   服务器心跳的倍速同步修正），无需单独判定。
 * - 容差 10s 与 synctv 的 maxInterval 一致：本通道是兜底自愈而非主校正
 *   路径（主路径为服务器心跳的两阶段校正，阈值 3s/6s），容差必须显著
 *   大于主路径阈值，避免两条通道互相触发。
 */
import { compensateTransportDelay } from './transport-delay';

/** 自检进度容差（秒）：客户端进度（经传输延迟补偿）与服务器推算值的最大允许偏差 */
export const CHECK_STATUS_TOLERANCE_SEC = 10;

export interface NeedsProgressSyncParams {
  /** 客户端上报的本地播放进度（秒） */
  clientCurrentTime: number;
  /** 客户端是否正在播放 */
  clientIsPlaying: boolean;
  /** 客户端播放倍速（仅用于延迟补偿的外推，不参与判定） */
  clientPlaybackRate: number;
  /** 客户端发送时刻的 Unix 毫秒时间戳，用于传输延迟补偿 */
  clientTs?: number;
  /** 服务器推算的权威进度（秒，已按服务器时间轴外推） */
  serverCurrentTime: number;
  /** 服务器权威播放状态 */
  serverIsPlaying: boolean;
  /** 服务器当前时间（毫秒），默认 Date.now()，测试可注入 */
  now?: number;
}

/**
 * 判断客户端状态是否与服务器权威状态分歧到需要下发纠偏。
 *
 * 判定条件（任一满足即需要同步）：
 * 1. isPlaying 分歧（播放/暂停不一致——通常意味着控制事件或心跳丢失）
 * 2. 客户端进度（经传输延迟补偿、锚定服务器时间轴）与服务器推算值
 *    偏差超过 CHECK_STATUS_TOLERANCE_SEC
 */
export function needsProgressSync({
  clientCurrentTime,
  clientIsPlaying,
  clientPlaybackRate,
  clientTs,
  serverCurrentTime,
  serverIsPlaying,
  now = Date.now(),
}: NeedsProgressSyncParams): boolean {
  if (clientIsPlaying !== serverIsPlaying) return true;

  const rate = clientPlaybackRate > 0 ? clientPlaybackRate : 1;
  const compensated = compensateTransportDelay({
    currentTime: clientCurrentTime,
    clientTs,
    playbackRate: rate,
    isPlaying: clientIsPlaying,
    now,
  });
  if (!Number.isFinite(compensated) || !Number.isFinite(serverCurrentTime)) {
    return false;
  }

  return (
    Math.abs(compensated - serverCurrentTime) > CHECK_STATUS_TOLERANCE_SEC
  );
}
