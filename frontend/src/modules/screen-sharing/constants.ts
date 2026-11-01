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

/**
 * 画面偏好（浏览器在带宽/CPU 不足时牺牲什么）。
 *
 * `maintain-resolution` 保清晰度降帧，`maintain-framerate` 保流畅降分辨率，
 * `balanced` 交给浏览器权衡。它只影响编码器在压力下的选择，不改变上限。
 */
export type DegradationPreferenceOption = {
  value: RTCDegradationPreference
  /** 词条 key（中文原文），渲染期走 t() */
  labelKey: string
  hintKey: string
}

export const DEGRADATION_OPTIONS: DegradationPreferenceOption[] = [
  {
    value: 'maintain-resolution',
    labelKey: '清晰',
    hintKey: '带宽不足时保分辨率、降帧率',
  },
  {
    value: 'balanced',
    labelKey: '均衡',
    hintKey: '交给浏览器权衡',
  },
  {
    value: 'maintain-framerate',
    labelKey: '流畅',
    hintKey: '带宽不足时保帧率、降分辨率',
  },
]

/** 系统声音的码率档位（与 core/quality 的 SCREEN_AUDIO_BITRATES 同源）。 */
export const AUDIO_BITRATE_OPTIONS: {
  labelKey: string
  value: number
  hintKey: string
}[] = [
  { labelKey: '普通', value: 64_000, hintKey: '人声为主，省带宽' },
  { labelKey: '音乐', value: 128_000, hintKey: '默认，音乐与视频兼顾' },
  { labelKey: '保真', value: 192_000, hintKey: '音乐为主，占用更高' },
]

/**
 * 一键画质档位。
 *
 * 三个参数一起改，避免用户自己调出「4K + 60fps + 2Mbps」这种必然糊的组合。
 * `labelKey` / `hintKey` 都是词条 key，渲染期走 t()。
 */
export type QualityPresetId = 'smooth' | 'hd' | 'high-fps'

export interface QualityPresetOption {
  id: QualityPresetId
  labelKey: string
  hintKey: string
  resolutionPreset: ResolutionPreset
  frameRate: number
  maxBitrateMbps: number
}

export const QUALITY_PRESETS: QualityPresetOption[] = [
  {
    id: 'smooth',
    labelKey: '流畅',
    hintKey: '720P · 30fps · 4Mbps，网络一般时选它',
    resolutionPreset: '720p',
    frameRate: 30,
    maxBitrateMbps: 4,
  },
  {
    id: 'hd',
    labelKey: '高清',
    hintKey: '1080P · 30fps · 8Mbps，默认档位',
    resolutionPreset: '1080p',
    frameRate: 30,
    maxBitrateMbps: 8,
  },
  {
    id: 'high-fps',
    labelKey: '高帧',
    hintKey: '1080P · 60fps · 16Mbps，画面有快速运动时选它',
    resolutionPreset: '1080p',
    frameRate: 60,
    maxBitrateMbps: 16,
  },
]

/**
 * 当前设置命中的档位；三个参数都对不上就是自定义（返回 null）。
 *
 * 只比对档位名与帧率/码率，不比分辨率尺寸：用户把档位从 1080p 改成 2K 时
 * 就是自定义，界面不该继续高亮「高清」。
 */
export function matchQualityPreset(settings: {
  resolutionPreset: ResolutionPreset
  frameRate: number
  maxBitrateMbps: number
}): QualityPresetId | null {
  const hit = QUALITY_PRESETS.find(
    (preset) =>
      preset.resolutionPreset === settings.resolutionPreset &&
      preset.frameRate === settings.frameRate &&
      preset.maxBitrateMbps === settings.maxBitrateMbps
  )
  return hit ? hit.id : null
}
