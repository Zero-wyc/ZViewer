import type { MutableRefObject } from 'react'
import { refreshAccessToken } from '@/lib/api'
import { isAccessTokenExpired } from '@/lib/authTransport'
import { isBilibiliUrlExpiring } from '@/modules/playback-memory/services/url-expiry'
import { useMusicStore, musicItemKey } from '../store'
import type { MusicQueueItem } from '../types'
import {
  invalidateBiliAudioUrl,
  setCachedBiliAudioUrl,
  takeBiliStandbyUrl,
} from './biliAudioCache'
import type { AudioEngine } from './useAudioEngine'

interface RenewalOptions {
  audioRef: AudioEngine['audioRef']
  roomIdRef: MutableRefObject<string | undefined>
  socketRef: MutableRefObject<{ connected: boolean } | null>
  isHostRef: MutableRefObject<boolean>
  playSource: AudioEngine['playSource']
  resolve: (item: MusicQueueItem) => Promise<{ playUrl: string }>
  broadcast: (state: { positionSec: number; isPlaying: boolean }) => void
  onFailure: (error: unknown, exhausted: boolean) => void
}

/** Own one track's renewal attempts; stale asynchronous work cannot resume media. */
export function createBilibiliAudioRenewal(options: RenewalOptions) {
  const {
    audioRef,
    roomIdRef,
    socketRef,
    isHostRef,
    playSource,
    resolve,
    broadcast,
    onFailure,
  } = options
  let active = true
  let generation = 0
  let inFlight = false
  let attempts = 0
  let lastAttemptAt = 0
  let resumedAt = 0
  let awaitingProgress = false
  const recover = (fromError: boolean): boolean => {
    const store = useMusicStore.getState()
    const key = store.currentKey
    const item =
      store.queue.find((item) => musicItemKey(item) === key) ??
      (store.biliItem && musicItemKey(store.biliItem) === key
        ? store.biliItem
        : null)
    const audio = audioRef.current
    const room = roomIdRef.current
    if (
      !active ||
      !audio?.src ||
      !item?.biliBvid ||
      !key ||
      !room ||
      socketRef.current?.connected === false
    )
      return false
    if (!fromError && !isBilibiliUrlExpiring(audio.src)) return false
    if (inFlight) return true
    if (attempts >= 3) return false
    if (Date.now() - lastAttemptAt < 30_000) return true
    lastAttemptAt = Date.now()
    attempts++
    inFlight = true
    awaitingProgress = false
    const request = generation
    const oldUrl = audio.src
    const shouldPlay = !audio.paused || store.isPlaying
    const isCurrent = () =>
      active &&
      request === generation &&
      roomIdRef.current === room &&
      useMusicStore.getState().currentKey === key &&
      audioRef.current === audio &&
      audio.src === oldUrl &&
      socketRef.current?.connected !== false
    const mapKey = `${item.biliBvid}:${item.biliCid ?? 0}`
    // 后台预存的备用直链优先：既省一次 playurl，也不必先把正在播的地址作废
    const standby = takeBiliStandbyUrl(mapKey)
    if (standby) setCachedBiliAudioUrl(mapKey, standby)
    else invalidateBiliAudioUrl(mapKey)
    void (async () => {
      if (fromError || isAccessTokenExpired()) await refreshAccessToken()
      if (!isCurrent()) return
      const playUrl = standby ?? (await resolve(item)).playUrl
      if (!isCurrent()) return
      // Read after resolution so a seek or pause during the request is respected.
      const position = audio.currentTime
      const rate = audio.playbackRate
      const playing = shouldPlay && useMusicStore.getState().isPlaying
      playSource(playUrl, position, playing, key)
      if (audioRef.current) audioRef.current.playbackRate = rate
      resumedAt = position
      awaitingProgress = true
      if (isHostRef.current)
        broadcast({ positionSec: position, isPlaying: playing })
    })()
      .catch((error) => {
        if (isCurrent()) onFailure(error, attempts >= 3)
      })
      .finally(() => {
        inFlight = false
      })
    return true
  }
  return {
    recover,
    checkDeadline() {
      if (
        awaitingProgress &&
        !inFlight &&
        audioRef.current &&
        !audioRef.current.error &&
        audioRef.current.currentTime > resumedAt + 2
      ) {
        attempts = 0
        awaitingProgress = false
      }
      recover(false)
    },
    cancel() {
      generation++
    },
    dispose() {
      active = false
      generation++
    },
  }
}
