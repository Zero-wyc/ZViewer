/**
 * 音乐播放器 Context 消费 Hook 与 context 定义。
 *
 * context 对象与消费者放本文件（纯 hook 文件，无组件导出），
 * Provider 组件见 ../MusicPlayerContext.tsx（保持单一组件导出，
 * 避免 react-refresh/only-export-components 警告，对齐 ui/Form.tsx 惯例）。
 */
import { createContext, useContext } from 'react'
import type { UseListenTogetherResult } from './useListenTogether'
import type { PlayMode } from '../types'

export interface MusicPlayerContextValue extends UseListenTogetherResult {
  /**
   * 是否正在播放（audio 元素 play/pause 事件镜像）。
   * 注意：positionSec 已移出 context——它由 timeupdate 以 4-8Hz 更新，
   * 放在 context value 里会让所有消费者跟着高频重渲染。需要进度的组件
   * 改用 usePlaybackPosition(quantum)（量化快照按需重渲染）或在
   * 事件回调/interval 内用 getPositionSec() 命令式读取。
   */
  isPlaying: boolean
  /** 播放模式 */
  playMode: PlayMode
}

export const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(
  null
)

/** 消费音乐播放器上下文（必须在 MusicPlayerProvider 内使用） */
export function useMusicPlayer(): MusicPlayerContextValue {
  const ctx = useContext(MusicPlayerContext)
  if (!ctx) {
    throw new Error('useMusicPlayer 必须在 MusicPlayerProvider 内使用')
  }
  return ctx
}
