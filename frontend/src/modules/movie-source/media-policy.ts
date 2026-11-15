interface MovieMediaPolicy {
  sourceType: string
  directLink?: boolean
  serverProxy?: boolean
}

/** Data sources use serverProxy; mounted libraries use directLink. */
export function usesDirectMedia(movie: MovieMediaPolicy): boolean {
  if (['anime', 'kazumi', 'cms'].includes(movie.sourceType)) {
    return movie.serverProxy !== true
  }
  return movie.directLink === true
}

/** A resolved proxy URL takes precedence over the configured direct-link flag. */
export function isDirectPlayback(
  state: { sourceUrl?: string; noProxyFallback?: boolean },
  movie?: MovieMediaPolicy | null
): boolean {
  try {
    const url = new URL(state.sourceUrl ?? '', 'http://local.invalid')
    if (
      /\/api\/stream\/(?:(?:anisubs|kazumi|cms)\/)?proxy$/.test(url.pathname)
    ) {
      return false
    }
  } catch {
    return false
  }
  if (state.noProxyFallback === true) return true
  return !!movie && (movie.sourceType === 'mp4' || usesDirectMedia(movie))
}
