/**
 * 自定义帧率的取值范围与合法化。
 *
 * 上限不是 UI 随手写的数字：它来自 `VIDEO_CAPTURE_LIMITS.maxFramerate`，
 * 与编码器/宏块预算同一口径。但**每个分辨率档位能跑的上限并不相同**——
 * H.264 的宏块率上限决定 2K 只到 144fps、4K 只到 64fps，超过这个值的档位
 * 会被 `supportsCaptureProfile` 直接拒绝（采集抛 unsupported capture profile），
 * 表现是「点了开始共享直接失败」。所以界面必须先按当前分辨率收窄可填范围。
 */
// 这里的 `.ts` 后缀是刻意的：本文件要能被 `node --experimental-strip-types`
// 直接加载（单测按 ESM 解析，扩展名不能省），与 `core/quality.ts` 同规矩。
import {
  FRAME_RATE_OPTIONS,
  RESOLUTION_DIMENSIONS,
  type ResolutionPreset,
} from '../constants.ts'
import {
  MIN_VIDEO_FRAMERATE,
  VIDEO_CAPTURE_LIMITS,
  captureFramerateCeiling,
} from '../core/quality.ts'

export const MIN_CUSTOM_FRAMERATE = MIN_VIDEO_FRAMERATE
export const MAX_CUSTOM_FRAMERATE = VIDEO_CAPTURE_LIMITS.maxFramerate

/**
 * 当前分辨率档位下能用的最高帧率。
 *
 * `native` 不约束宽高（跟着采集源走），这里按全局上限算；真正发不发得出来
 * 由采集源与编码器决定，`房间状态` 里的「采集帧率」是实测值。
 */
export function maxFramerateForResolution(preset: ResolutionPreset): number {
  const size = RESOLUTION_DIMENSIONS[preset]
  if (!size) return MAX_CUSTOM_FRAMERATE
  const ceiling = captureFramerateCeiling(size)
  if (ceiling <= 0) return MAX_CUSTOM_FRAMERATE
  return Math.min(MAX_CUSTOM_FRAMERATE, ceiling)
}

/** 是不是预设档位里的值（不是就意味着走自定义）。 */
export function isPresetFramerate(value: number): boolean {
  return FRAME_RATE_OPTIONS.some((option) => option.value === value)
}

/**
 * 把输入框里的字符串变成可用的帧率。
 *
 * 越界的值夹到边界——**夹完要写回输入框**，用户看得见自己被夹到了 144，
 * 而不是填了 500 却悄悄发着别的东西。空串/非数字返回 null，由调用方回退。
 */
export function normalizeFramerateInput(
  raw: string,
  max = MAX_CUSTOM_FRAMERATE
): number | null {
  const text = raw.trim()
  if (text === '') return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return Math.min(max, Math.max(MIN_CUSTOM_FRAMERATE, Math.round(value)))
}
