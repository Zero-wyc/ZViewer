import { ICE_SERVERS } from '@/modules/p2p/constants'

// 重新导出以保持 screen-sharing 模块内向后兼容
export { ICE_SERVERS }

export const FRAME_RATE_OPTIONS = [
  { label: '15 fps', value: 15 },
  { label: '30 fps', value: 30 },
  { label: '45 fps', value: 45 },
  { label: '60 fps', value: 60 },
]

/**
 * 分辨率档位。
 * - 'native'：不约束宽高，跟随采集源本机分辨率
 * - 其余档位以 ideal 语义下发（借鉴 mirotalk/ZViewerAPP 经验：
 *   只缩小不放大、不裁剪，不用 max 硬约束避免严格匹配失败回落）
 */
export type ResolutionPreset = 'native' | '720p' | '1080p' | '2k' | '4k'

export const RESOLUTION_PRESETS: ResolutionPreset[] = [
  'native',
  '720p',
  '1080p',
  '2k',
  '4k',
]

/** 档位对应的目标宽高；native 为 null（不下发宽高约束） */
export const RESOLUTION_DIMENSIONS: Record<
  ResolutionPreset,
  { width: number; height: number } | null
> = {
  native: null,
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
}

export const RESOLUTION_OPTIONS: { label: string; value: ResolutionPreset }[] =
  [
    { label: '本机分辨率', value: 'native' },
    { label: '720P', value: '720p' },
    { label: '1080P', value: '1080p' },
    { label: '2K', value: '2k' },
    { label: '4K', value: '4k' },
  ]
