import { useSyncExternalStore, useCallback } from 'react'

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const mm = m.toString().padStart(2, '0')
  const ss = s.toString().padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function getBufferedPercent(video: HTMLVideoElement) {
  if (!video.duration || !video.buffered.length) return 0
  const end = video.buffered.end(video.buffered.length - 1)
  return Math.min(100, (end / video.duration) * 100)
}

interface VideoState {
  isPlaying: boolean
  currentTime: number
  duration: number
  bufferedPercent: number
  volume: number
  isMuted: boolean
  playbackRate: number
}

const DEFAULT_VIDEO_STATE: VideoState = {
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  bufferedPercent: 0,
  volume: 1,
  isMuted: false,
  playbackRate: 1,
}

const videoStateCache = new WeakMap<HTMLVideoElement, VideoState>()

function areVideoStatesEqual(a: VideoState, b: VideoState): boolean {
  return (
    a.isPlaying === b.isPlaying &&
    a.currentTime === b.currentTime &&
    a.duration === b.duration &&
    a.bufferedPercent === b.bufferedPercent &&
    a.volume === b.volume &&
    a.isMuted === b.isMuted &&
    a.playbackRate === b.playbackRate
  )
}

function getVideoSnapshot(video: HTMLVideoElement | null): VideoState {
  if (!video) {
    return DEFAULT_VIDEO_STATE
  }
  const next: VideoState = {
    isPlaying: !video.paused,
    currentTime: video.currentTime || 0,
    duration: video.duration || 0,
    bufferedPercent: getBufferedPercent(video),
    volume: video.volume ?? 1,
    isMuted: video.muted,
    playbackRate: video.playbackRate || 1,
  }
  const prev = videoStateCache.get(video)
  if (prev && areVideoStatesEqual(prev, next)) {
    return prev
  }
  videoStateCache.set(video, next)
  return next
}

function subscribeToVideo(
  video: HTMLVideoElement | null,
  callback: () => void
) {
  if (!video) return () => {}

  const events = [
    'play',
    'pause',
    'timeupdate',
    'loadedmetadata',
    'durationchange',
    'progress',
    'ratechange',
    'volumechange',
  ]
  events.forEach((event) => video.addEventListener(event, callback))
  return () => {
    events.forEach((event) => video.removeEventListener(event, callback))
  }
}

function subscribeToFullscreen(callback: () => void) {
  document.addEventListener('fullscreenchange', callback)
  return () => {
    document.removeEventListener('fullscreenchange', callback)
  }
}

export interface VideoControlsState extends VideoState {
  isFullscreen: boolean
  formattedCurrentTime: string
  formattedDuration: string
  progressPercent: number
}

export function useVideoControls(
  video: HTMLVideoElement | null
): VideoControlsState {
  const videoState = useSyncExternalStore(
    useCallback((callback) => subscribeToVideo(video, callback), [video]),
    () => getVideoSnapshot(video),
    () => getVideoSnapshot(video)
  )

  const isFullscreen = useSyncExternalStore(
    subscribeToFullscreen,
    () => !!document.fullscreenElement,
    () => false
  )

  return {
    ...videoState,
    isFullscreen,
    formattedCurrentTime: formatTime(videoState.currentTime),
    formattedDuration: formatTime(videoState.duration),
    progressPercent: videoState.duration
      ? (videoState.currentTime / videoState.duration) * 100
      : 0,
  }
}
