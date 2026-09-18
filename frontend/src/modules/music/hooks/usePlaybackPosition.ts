/**
 * 播放进度（positionSec）的按需订阅 hook。
 *
 * positionSec 由音频 timeupdate 以 4-8Hz 高频写入 store。组件若直接订阅
 * 整值，整棵组件树会跟着每秒重渲染 4-8 次。本 hook 用
 * useSyncExternalStore 的**量化快照**：仅当量化后的值变化时才重渲染，
 * 消费方按 UI 粒度选择档位（进度条 0.25s / 歌词行 0.5s / 倒计时 1s——
 * 只用 2 的幂次，避免二进制浮点取整噪声破坏 Object.is 比较）。
 */
import { useSyncExternalStore } from 'react'
import { useMusicStore } from '../store'

/** store 订阅器（任何状态变化都通知，由快照函数决定是否真的重渲染） */
export const subscribePositionSec = (onStoreChange: () => void) =>
  useMusicStore.subscribe(onStoreChange)

/** 量化读取当前进度（getSnapshot） */
const quantized = (quantumSec: number): number => {
  const p = useMusicStore.getState().positionSec
  return Math.round(p / quantumSec) * quantumSec
}

/**
 * 订阅播放进度（量化）。
 * @param quantumSec 快照档位（秒）：仅当跨过一档时触发重渲染。默认 0.25s。
 */
export function usePlaybackPosition(quantumSec: 0.25 | 0.5 | 1 = 0.25): number {
  return useSyncExternalStore(
    subscribePositionSec,
    () => quantized(quantumSec),
    () => 0
  )
}

/** 命令式读取当前播放进度（事件回调 / interval 内使用，不触发渲染） */
export function getPositionSec(): number {
  return useMusicStore.getState().positionSec
}
