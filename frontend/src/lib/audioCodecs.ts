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
 * 判断音轨编码是否需要浏览器端转码。
 *
 * null / 空字符串（编码未知，如后端无 ffprobe）返回 false，由调用方
 * 按容器类型决定是否启用引擎——见 `shouldUsePlaysVideo`。
 */
export function needsBrowserTranscode(
  audioCodec: string | null | undefined
): boolean {
  if (!audioCodec) return false
  return !(BROWSER_SUPPORTED_AUDIO_CODECS as readonly string[]).includes(
    audioCodec.toLowerCase()
  )
}
