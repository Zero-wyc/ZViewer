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
  /** 当前播放进度（秒；store 中 timeupdate 驱动的镜像，供进度条/歌词消费） */
  positionSec: number
  /** 是否正在播放（audio 元素 play/pause 事件镜像） */
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
