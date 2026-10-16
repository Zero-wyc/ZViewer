/**
 * 浏览器 <video>/MSE 原生支持的音频编码白名单。
 *
 * 与旧版后端 services/ffmpeg BROWSER_SUPPORTED_AUDIO_CODECS 保持一致；
 * 不在此列表中的编码（DTS/AC3/EAC3/TrueHD 等）需由 playsvideo 引擎在
 * 浏览器内实时转码为 AAC。未知编码（audioCodec 为 null/空）同样交给引擎——
 * 它探测出真实 CodecID 后会自行决定直通还是转码，比保守回退原生播放
 * （可能无声）更符合预期。
 */

/** 浏览器原生支持的音频编码 */
export const BROWSER_SUPPORTED_AUDIO_CODECS = [
  'aac',
  'mp3',
  'opus',
  'vorbis',
  'flac',
] as const

/**
 * 归一化音频编码名为浏览器白名单口径的短名。
 *
 * B站 DASH 解析返回的 codecs 是 MP4RA 注册名（bestAudio.codecs）：
 * - `mp4a.40.*`（含 .2=AAC-LC / .5=HE-AAC）本质都是 AAC，浏览器原生支持
 * - `mp4a.67` / `mp4a.69` / `mp4a.6b` 是 MPEG-1/2 Audio（即 MP3 家族）
 * 不做归一化会被白名单误判为「不受浏览器支持」，触发 playsvideo 转码
 * 误提示（B站 DASH 实际由 dash.js 原生播放，无需任何转码）。
 */
export function normalizeAudioCodec(
  audioCodec: string | null | undefined
): string | null {
  if (!audioCodec) return null
  const lower = audioCodec.toLowerCase()
  if (lower.startsWith('mp4a.40.')) return 'aac'
  if (lower === 'mp4a.67' || lower === 'mp4a.69' || lower === 'mp4a.6b') {
    return 'mp3'
  }
  return lower
}

/**
 * 判断音轨编码是否需要浏览器端转码。
 *
 * null / 空字符串（编码未知，如后端无 ffprobe）返回 false，由调用方
 * 按容器类型决定是否启用引擎——见 `shouldUsePlaysVideo`。
 */
export function needsBrowserTranscode(
  audioCodec: string | null | undefined
): boolean {
  const normalized = normalizeAudioCodec(audioCodec)
  if (!normalized) return false
  return !(BROWSER_SUPPORTED_AUDIO_CODECS as readonly string[]).includes(
    normalized
  )
}
