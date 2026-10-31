import type { QualityProfile } from './quality'

/**
 * 房主对上行媒体的声明（中继模式首个 description 的 `media` 载荷）。
 *
 * 服务端用它决定 SFU 侧要协商哪一路编码、分几层、每层多大——声明和实际上行
 * 不一致时 SFU 会直接拒绝这条发布（`codec does not match its declaration`），
 * 所以这里的取值必须和发布端真正发出的轨道一致：编码取发布端强制的那一个，
 * 尺寸取采集档位，码率取用户设的上限。
 *
 * ZViewer 的发布端不分层（没有 simulcast），所以 rids 恒为一个空串——
 * 服务端允许「只有一层且 RID 为空」这种形态。
 */
export interface ShareMediaDeclaration {
  codec: 'h264' | 'vp8'
  rids: string[]
  formats: { width: number; height: number; bitrate: number }[]
  audio: boolean
  audioBitrate: number
}

/** 采集档位缺省尺寸（与 DEFAULT_QUALITY_PROFILE 一致，避免循环引用）。 */
const FALLBACK_RESOLUTION = { width: 1920, height: 1080 }

/** 组装上行媒体声明。 */
export function relayMediaDeclaration(
  profile: QualityProfile,
  options: { codec: 'h264' | 'vp8'; audio: boolean }
): ShareMediaDeclaration {
  const resolution = profile.resolution ?? FALLBACK_RESOLUTION
  return {
    codec: options.codec,
    rids: [''],
    formats: [
      {
        width: resolution.width,
        height: resolution.height,
        bitrate: Math.max(1, Math.round(profile.maxBitrate)),
      },
    ],
    audio: options.audio,
    // 声明了音频就必须给码率：服务端把 0 当作非法声明整条拒掉。
    audioBitrate: options.audio
      ? Math.max(1, Math.round(profile.maxAudioBitrate))
      : 0,
  }
}
