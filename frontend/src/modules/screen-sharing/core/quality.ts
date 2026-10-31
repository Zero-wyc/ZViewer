/**
 * 房主侧采集与编码档位。
 *
 * 结构与判定顺序照搬 Piik 的 `src/client/media/quality.ts`，只删掉 ZViewer
 * 用不到的部分（编码池 carrier、相机源、质量证据上报）。
 *
 * 三条不能省的行为（Piik 侧每一条都有对应注释与行号）：
 *  1. **启动保护**：开局先按 `maintain-resolution` 编码 5 帧，等编码器把
 *     尺寸坐实再切回用户档位（`quality.ts:25,143-149`）。不这样做，首帧
 *     会在分辨率还没稳定时被 `balanced` 降一档，观众看到的是糊的开场。
 *  2. **setParameters 回读比对**：浏览器可以静默改写码率/帧率/降采样，
 *     写完必须读回来看差在哪（`quality.ts:156-160,400-424`）。
 *  3. **音频上限取协商值**：`maxaveragebitrate` 与 Opus 默认码率都可能比
 *     用户请求的低，超过协商值的 `setParameters` 会被浏览器丢掉
 *     （`quality.ts:461-489`）。
 *
 * 本文件刻意不 import 任何运行时依赖：node --experimental-strip-types 跑
 * 单测时无法解析 `@/` 别名与其它模块的副作用。
 */

/** 启动保护窗口：编码满这么多帧才允许切到用户档位。 */
export const STARTUP_VIDEO_ENCODED_FRAMES = 5

export const MIN_VIDEO_FRAMERATE = 1
export const MIN_VIDEO_BITRATE = 100_000
export const MAX_VIDEO_BITRATE = 240_000_000

/**
 * 输出边界，与 UI 档位无关。
 *
 * H.264 Level 5.2 同时约束帧面积、宏块率与码率，这里按同一口径设上限，
 * 保证「超宽屏 + 高刷」这类组合不会被静默截断成某个命名档位。
 */
export const VIDEO_CAPTURE_LIMITS = {
  maxWidth: 8192,
  maxHeight: 8192,
  maxPixels: 36_864 * 16 * 16,
  maxMacroblocksPerSecond: 2_073_600,
  maxFramerate: 240,
  maxBitrate: MAX_VIDEO_BITRATE,
}

/** 屏幕声（系统音频）三档码率。 */
export const SCREEN_AUDIO_BITRATES = {
  saver: 64_000,
  music: 128_000,
  'very-high': 192_000,
} as const

export type ScreenAudioPreset = keyof typeof SCREEN_AUDIO_BITRATES

/** 音频发送上限：20ms 一包时 320kbps 仍在 1200 字节 MTU 内。 */
export const MAX_AUDIO_SEND_BITRATE = 320_000
const MIN_AUDIO_BITRATE = 6_000
const MAX_AUDIO_BITRATE = 510_000
export const DEFAULT_AUDIO_BITRATE = SCREEN_AUDIO_BITRATES.music

/** 分辨率尺寸；null 表示跟随采集源（native 档位）。 */
export interface QualityResolution {
  width: number
  height: number
}

/**
 * 一路共享的采集/编码档位。
 *
 * 与 Piik 的 `QualitySettings` 等价，只是字段名换成 ZViewer 的口径：
 * `maxBitrate` 是 bps（不是 Mbps），`resolution` 为 null 表示不约束宽高。
 */
export interface QualityProfile {
  resolution: QualityResolution | null
  maxFramerate: number
  maxBitrate: number
  degradationPreference: RTCDegradationPreference
  maxAudioBitrate: number
}

export const DEFAULT_QUALITY_PROFILE: QualityProfile = {
  resolution: { width: 1920, height: 1080 },
  maxFramerate: 30,
  maxBitrate: 8_000_000,
  degradationPreference: 'balanced',
  maxAudioBitrate: DEFAULT_AUDIO_BITRATE,
}

/** 从 UI 的媒体设置拼出一个档位。 */
export function profileFromSettings(settings: {
  frameRate: number
  maxBitrateMbps: number
  resolution: QualityResolution | null
  maxAudioBitrate?: number
}): QualityProfile {
  return {
    resolution: settings.resolution,
    maxFramerate: settings.frameRate,
    maxBitrate: Math.round(settings.maxBitrateMbps * 1_000_000),
    degradationPreference: 'balanced',
    maxAudioBitrate: screenAudioBitrate(settings.maxAudioBitrate),
  }
}

/**
 * 给定尺寸下的帧率上限。
 *
 * 返回 0 表示这个尺寸根本不允许（奇数边长、超面积、宏块率不够）。
 */
export function captureFramerateCeiling(
  size: QualityResolution,
  limits = VIDEO_CAPTURE_LIMITS
): number {
  const validShape =
    Number.isInteger(size.width) &&
    Number.isInteger(size.height) &&
    size.width >= 4 &&
    size.height >= 4 &&
    size.width % 2 === 0 &&
    size.height % 2 === 0 &&
    size.width <= limits.maxWidth &&
    size.height <= limits.maxHeight &&
    size.width * size.height <= limits.maxPixels
  if (!validShape) return 0
  const macroblocks = Math.ceil(size.width / 16) * Math.ceil(size.height / 16)
  if (macroblocks * 256 > limits.maxPixels) return 0
  return Math.floor(
    Math.min(limits.maxFramerate, limits.maxMacroblocksPerSecond / macroblocks)
  )
}

/** 档位是否被当前实现接受（越界的档位直接拒绝，不做静默钳制）。 */
export function supportsCaptureProfile(
  profile: QualityProfile,
  limits = VIDEO_CAPTURE_LIMITS
): boolean {
  const integerFramerate = Number.isInteger(profile.maxFramerate)
  const framerate = integerFramerate
    ? Number.isInteger(profile.maxFramerate) &&
      profile.maxFramerate >= MIN_VIDEO_FRAMERATE &&
      (profile.resolution
        ? profile.maxFramerate <=
          captureFramerateCeiling(profile.resolution, limits)
        : profile.maxFramerate <= limits.maxFramerate)
    : false
  return (
    framerate &&
    profile.maxBitrate >= MIN_VIDEO_BITRATE &&
    profile.maxBitrate <= limits.maxBitrate &&
    screenAudioBitrate(profile.maxAudioBitrate) <= MAX_AUDIO_SEND_BITRATE
  )
}

/**
 * 采集约束。
 *
 * 宽高用 `max` 而不是 `ideal`：这是**上限**语义，不能让采集器为了凑目标
 * 尺寸去裁剪源画面（Piik `quality.ts:241-249`）。native 档位不下发宽高。
 */
export function captureConstraints(
  profile: QualityProfile
): MediaTrackConstraints {
  const constraints: MediaTrackConstraints = {
    frameRate: { ideal: profile.maxFramerate, max: profile.maxFramerate },
  }
  if (profile.resolution) {
    constraints.width = { max: profile.resolution.width }
    constraints.height = { max: profile.resolution.height }
  }
  return constraints
}

/** 启动阶段的档位：强制 `maintain-resolution`，先把尺寸坐实。 */
export function startupVideoProfile(profile: QualityProfile): QualityProfile {
  return profile.degradationPreference === 'maintain-resolution'
    ? profile
    : { ...profile, degradationPreference: 'maintain-resolution' }
}

/** 是否需要启动保护。 */
export function needsStartupVideoProfile(profile: QualityProfile): boolean {
  return profile.degradationPreference !== 'maintain-resolution'
}

/**
 * 缺省音频码率。
 *
 * 刻意**不做钳制**：钳制放在 `audioSenderCeiling` 里，因为真正的上限取决于
 * 协商结果。这里悄悄改数值会让 `supportsCaptureProfile` 的越界检查失效，
 * 用户填了 999kbps 却「看起来通过了」。
 */
export function screenAudioBitrate(bitrate: number | undefined): number {
  return bitrate ?? DEFAULT_AUDIO_BITRATE
}

export function qualityResolutionEqual(
  left: QualityResolution | null,
  right: QualityResolution | null
): boolean {
  if (left === null || right === null) return left === right
  return left.width === right.width && left.height === right.height
}

export function videoQualitySettingsEqual(
  left: QualityProfile,
  right: QualityProfile
): boolean {
  return (
    qualityResolutionEqual(left.resolution, right.resolution) &&
    left.maxFramerate === right.maxFramerate &&
    left.maxBitrate === right.maxBitrate &&
    left.degradationPreference === right.degradationPreference
  )
}

export function audioQualitySettingsEqual(
  left: QualityProfile,
  right: QualityProfile
): boolean {
  return (
    screenAudioBitrate(left.maxAudioBitrate) ===
    screenAudioBitrate(right.maxAudioBitrate)
  )
}

export function qualitySettingsEqual(
  left: QualityProfile,
  right: QualityProfile
): boolean {
  return (
    videoQualitySettingsEqual(left, right) &&
    audioQualitySettingsEqual(left, right)
  )
}

/** `setParameters` 的回读结果。`mismatches` 非空即浏览器改写了参数。 */
export interface VideoSenderParameterValues {
  maxBitrate: number | null
  maxFramerate: number | null
  scaleResolutionDownBy: number | null
  degradationPreference: RTCDegradationPreference | null
  scalabilityMode: string | null
}

export interface VideoSenderParameterReadback {
  requested: VideoSenderParameterValues
  applied: VideoSenderParameterValues
  mismatches: Array<keyof VideoSenderParameterValues>
}

export interface AudioSenderParameterReadback {
  requestedMaxBitrate: number
  appliedMaxBitrate: number | null
  mismatch: boolean
}

/**
 * 请求的降采样倍数。
 *
 * 只按采集源实际尺寸与档位上限的比例降采样；源本身就比档位小就保持 1，
 * 不做放大（放大只会白烧码率）。
 */
export function requestedScaleResolutionDownBy(
  sender: RTCRtpSender,
  profile: QualityProfile
): number {
  if (!profile.resolution) return 1
  const settings = sender.track?.getSettings?.()
  if (!settings?.width || !settings.height) return 1
  return Math.max(
    1,
    settings.width / profile.resolution.width,
    settings.height / profile.resolution.height
  )
}

function readVideoSenderParameters(
  parameters: RTCRtpSendParameters,
  includeAppliedScalabilityMode: boolean,
  encodingIndex = 0
): VideoSenderParameterValues {
  const encoding = parameters.encodings[encodingIndex]
  const scalabilityMode = (
    encoding as
      (RTCRtpEncodingParameters & { scalabilityMode?: unknown }) | undefined
  )?.scalabilityMode
  return {
    maxBitrate: encoding?.maxBitrate ?? null,
    maxFramerate: encoding?.maxFramerate ?? null,
    scaleResolutionDownBy: encoding?.scaleResolutionDownBy ?? null,
    degradationPreference: parameters.degradationPreference ?? null,
    scalabilityMode:
      includeAppliedScalabilityMode &&
      parameters.encodings.length === 1 &&
      typeof scalabilityMode === 'string' &&
      /^[A-Za-z0-9_-]{1,32}$/.test(scalabilityMode)
        ? scalabilityMode
        : null,
  }
}

function sameParameter(
  key: keyof VideoSenderParameterValues,
  requested: number | string | null,
  applied: number | string | null
): boolean {
  if (key === 'scalabilityMode' && requested === null) return true
  if (typeof requested === 'number' && typeof applied === 'number') {
    return key === 'scaleResolutionDownBy'
      ? Math.abs(requested - applied) < 0.01
      : requested === applied
  }
  return requested === applied
}

export function senderParameterReadback(
  requested: VideoSenderParameterValues,
  applied: VideoSenderParameterValues
): VideoSenderParameterReadback {
  const keys = Object.keys(requested) as Array<keyof VideoSenderParameterValues>
  const mismatches = keys.filter(
    (key) => !sameParameter(key, requested[key], applied[key])
  )
  return { requested, applied, mismatches }
}

/**
 * 给视频 sender 下发码率/帧率/降采样，并回读校验。
 *
 * Piik 用 `encodings.length - 1` 定位编码层：钉住 simulcast 时编码层按空间
 * 分辨率递增排列，最后一层才是全尺寸（`quality.ts:435-436`）。
 */
export async function configureVideoSender(
  sender: RTCRtpSender,
  profile: QualityProfile,
  carrierScale?: number
): Promise<VideoSenderParameterReadback> {
  const parameters = sender.getParameters()
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}]
  }
  const encodingIndex = parameters.encodings.length - 1
  const encoding = parameters.encodings[encodingIndex]!
  encoding.maxBitrate = profile.maxBitrate
  if (carrierScale === undefined) {
    encoding.maxFramerate = profile.maxFramerate
  } else {
    delete encoding.maxFramerate
  }
  if (parameters.encodings.length === 1) {
    encoding.scaleResolutionDownBy =
      carrierScale ?? requestedScaleResolutionDownBy(sender, profile)
  }
  parameters.degradationPreference =
    carrierScale === undefined
      ? profile.degradationPreference
      : 'maintain-framerate'

  const requested = readVideoSenderParameters(parameters, false, encodingIndex)
  await sender.setParameters(parameters)
  const applied = readVideoSenderParameters(
    sender.getParameters(),
    true,
    encodingIndex
  )
  return senderParameterReadback(requested, applied)
}

/**
 * 音频 sender 的实际上限。
 *
 * 三个来源取最小：用户请求、本实现的发送上限、协商出来的 Opus 上限。
 * 协商值缺失时按 libwebrtc 的默认规则推算（`quality.ts:483-486`）——
 * 缺省不能被当成「没有上限」，否则 setParameters 会请求一个对端收不了的码率。
 */
export function audioSenderCeiling(
  current: RTCRtpSendParameters,
  requestedMaxBitrate: number
): number {
  let ceiling = Math.min(requestedMaxBitrate, MAX_AUDIO_SEND_BITRATE)
  for (const codec of current.codecs ?? []) {
    if (codec.mimeType.toLowerCase() !== 'audio/opus') continue
    let receiveLimit: number | undefined
    let playbackRate = 48_000
    let channels = 1
    for (const parameter of (codec.sdpFmtpLine ?? '').split(';')) {
      const [name, value] = parameter.trim().split('=')
      const key = name?.trim().toLowerCase()
      const number = Number(value)
      if (key === 'stereo') channels = value?.trim() === '1' ? 2 : 1
      if (
        key === 'maxplaybackrate' &&
        Number.isInteger(number) &&
        number >= 8_000 &&
        number <= 48_000
      ) {
        playbackRate = number
      }
      if (
        key === 'maxaveragebitrate' &&
        Number.isInteger(number) &&
        number >= MIN_AUDIO_BITRATE &&
        number <= MAX_AUDIO_BITRATE
      ) {
        receiveLimit = Math.min(receiveLimit ?? MAX_AUDIO_BITRATE, number)
      }
    }
    const defaultBitrate =
      (playbackRate <= 8_000
        ? 12_000
        : playbackRate <= 16_000
          ? 20_000
          : 32_000) * channels
    ceiling = Math.min(ceiling, receiveLimit ?? defaultBitrate)
  }
  return ceiling
}

/** 给音频 sender 下发码率上限并回读。 */
export async function configureAudioSender(
  sender: RTCRtpSender,
  requestedMaxBitrate: number
): Promise<AudioSenderParameterReadback> {
  const current = sender.getParameters()
  const parameters: RTCRtpSendParameters = {
    ...current,
    encodings: current.encodings.map((encoding) => ({ ...encoding })),
  }
  if (parameters.encodings.length === 0) {
    parameters.encodings = [{}]
  }
  parameters.encodings[0]!.maxBitrate = audioSenderCeiling(
    current,
    requestedMaxBitrate
  )
  await sender.setParameters(parameters)
  const appliedMaxBitrate =
    sender.getParameters().encodings[0]?.maxBitrate ?? null
  return {
    requestedMaxBitrate,
    appliedMaxBitrate,
    mismatch: appliedMaxBitrate !== requestedMaxBitrate,
  }
}
