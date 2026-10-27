import { isIntranetHost } from '@/lib/netAddress'

/** Mirror the mounted-movie policy: private source addresses require relay. */
export function canSwitchEmbyPlayback(movie: {
  sourceType: string
  serverUrl?: string | null
}): boolean {
  if (movie.sourceType !== 'emby' && movie.sourceType !== 'jellyfin')
    return false
  if (!movie.serverUrl) return true
  try {
    const address = /^[a-z][a-z\d+.-]*:\/\//i.test(movie.serverUrl)
      ? movie.serverUrl
      : `http://${movie.serverUrl}`
    return !isIntranetHost(new URL(address).hostname)
  } catch {
    return true
  }
}

/** Both the relay URL and the upstream URL can carry a selected version. */
export function getEmbyMediaSourceId(url: string): string | undefined {
  try {
    const query = new URL(url, 'http://local.invalid').searchParams
    return query.get('ms') || query.get('MediaSourceId') || undefined
  } catch {
    return undefined
  }
}
