import { useEffect } from 'react'
import { apiFetch, getApiUrl } from '@/lib/api'
import { useRoomStore, mapDtoToMovie, type MovieDto } from '@/store/roomStore'

/** Refresh only image fields; never overwrite playback policy or revive a room. */
export function usePosterRefresh(roomId?: string | null): void {
 useEffect(() => {
  if (!roomId) return
  const controller = new AbortController()
  const server = getApiUrl()
  let busy = false
  const refresh = async () => {
   if (busy || controller.signal.aborted || getApiUrl() !== server) return
   const before = useRoomStore.getState()
   if (before.roomId !== roomId || !before.movies.some(movie => ['emby', 'jellyfin'].includes(movie.sourceType))) return
   busy = true
   try {
    const response = await apiFetch(`/api/rooms/${encodeURIComponent(roomId)}/movies`, { signal: controller.signal })
    const data = await response.json() as { success?: boolean; movies?: MovieDto[] }
    if (!response.ok || !data.success || !data.movies || controller.signal.aborted || getApiUrl() !== server) return
    const current = useRoomStore.getState()
    if (current.roomId !== roomId || current.movies !== before.movies) return
    const covers = new Map(data.movies.map(dto => [dto.id, mapDtoToMovie(dto).cover]))
    useRoomStore.setState({ movies: current.movies.map(movie => covers.has(movie.id) ? { ...movie, cover: covers.get(movie.id) } : movie) })
   } catch { /* Keep the last confirmed artwork and login state on network failure. */ }
   finally { busy = false }
  }
  const interval = window.setInterval(() => void refresh(), 40 * 60 * 1000)
  const visible = () => { if (document.visibilityState === 'visible') void refresh() }
  document.addEventListener('visibilitychange', visible)
  return () => { controller.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', visible) }
 }, [roomId])
}
