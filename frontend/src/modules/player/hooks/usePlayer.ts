/**
 * usePlayer Hook
 *
 * 播放器顶层编排 Hook：组合 usePlayerSource + usePlayerControls + usePlayerEvents，
 * 提供统一的播放器 API。
 *
 * 适用场景：
 * - 简单的本地播放器（不需要同步播放）
 * - 作为同步播放的底层基础（sync-playback 在此之上扩展广播/心跳等逻辑）
 *
 * 对于同步播放场景，调用方通常需要：
 * 1. 使用 usePlayer.attachSource 加载源
 * 2. 使用 usePlayer.events 监听事件并广播
 * 3. 使用 usePlayer.controls 控制播放
 *
 * 如果只需要部分能力，也可以直接使用底层的 usePlayerSource / usePlayerControls / usePlayerEvents。
 */
import type { RefObject } from 'react'
import { usePlayerSource } from './usePlayerSource'
import { usePlayerControls } from './usePlayerControls'
import { usePlayerEvents } from './usePlayerEvents'
import type { UsePlayerEventsOptions } from './usePlayerEvents'

export interface UsePlayerOptions {
  videoRef: RefObject<HTMLVideoElement | null>
  /** 是否暂停事件分发（如加载新源时） */
  suppressRef?: RefObject<boolean>
  /** 自动播放策略触发强制静音时的回调 */
  onAutoMuted?: () => void
  /** 事件回调（与 usePlayerEvents 一致） */
  events?: Omit<UsePlayerEventsOptions, 'videoRef' | 'suppressRef'>
}

export interface UsePlayerReturn {
  /** 源管理：attach / cleanup / appliedSourceUrlRef */
  source: ReturnType<typeof usePlayerSource>
  /** 播放控制：play / pause / seek / setRate / togglePlay */
  controls: ReturnType<typeof usePlayerControls>
}

export function usePlayer({
  videoRef,
  suppressRef,
  onAutoMuted,
  events,
}: UsePlayerOptions): UsePlayerReturn {
  const source = usePlayerSource({ videoRef })
  const controls = usePlayerControls({ videoRef, onAutoMuted })

  usePlayerEvents({
    videoRef,
    suppressRef,
    ...events,
  })

  return {
    source,
    controls,
  }
}
