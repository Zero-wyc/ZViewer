interface BilibiliAudioSource {
  audioUrl?: string
  videoUrl?: string
  format?: string
}

interface BilibiliAudioResolveOptions {
  audioOnly: true
  forceDash?: boolean
  preferMp4?: boolean
}

/** MP4-only videos remain playable; permission/network errors keep their original meaning. */
export async function resolveBilibiliAudioWithFallback<T>(
  resolve: (options: BilibiliAudioResolveOptions) => Promise<T>
): Promise<T> {
  try {
    return await resolve({ forceDash: true, audioOnly: true })
  } catch (error) {
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'DASH_NOT_AVAILABLE') throw error
    return resolve({ preferMp4: true, audioOnly: true })
  }
}

/** A DASH video representation has no sound; only a muxed source can be a fallback. */
export function selectBilibiliAudioStream(source: BilibiliAudioSource): string {
  if (source.audioUrl) return source.audioUrl
  if (source.format !== 'dash' && source.videoUrl) return source.videoUrl
  throw new Error('未获取到 B站音轨，请重试或切换解析来源')
}
