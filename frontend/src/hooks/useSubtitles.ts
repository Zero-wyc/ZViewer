import { useCallback, useEffect, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'

export interface SubtitleTrack {
  url: string
  label: string
  lang?: string
}

export interface SubtitleState {
  subtitleEnabled: boolean
  subtitleTracks: SubtitleTrack[]
  activeTrackIndex: number
  subtitleFontSize: number
}

interface SubtitleBroadcastPayload {
  enabled: boolean
  tracks: SubtitleTrack[]
  activeIndex: number
  fontSize: number
}

export interface UseSubtitlesOptions {
  roomId: string
  isHost: boolean
}

const DEFAULT_SUBTITLE_STATE: SubtitleState = {
  subtitleEnabled: false,
  subtitleTracks: [],
  activeTrackIndex: -1,
  subtitleFontSize: 20,
}

/**
 * 字幕状态管理 + socket 同步。
 *
 * - 房主：调用 set* 方法变更状态并广播 `subtitle-update`
 * - 观众：监听 `subtitle-update` 自动应用相同配置
 *
 * 文件上传会读取为 data URL，使 blob 内容可通过 socket 同步给观众。
 */
export function useSubtitles({ roomId, isHost }: UseSubtitlesOptions) {
  const { socket } = useSocket()
  const [state, setState] = useState<SubtitleState>(DEFAULT_SUBTITLE_STATE)

  const broadcast = useCallback(
    (next: SubtitleState) => {
      if (!socket || !isHost) return
      const payload: SubtitleBroadcastPayload = {
        enabled: next.subtitleEnabled,
        tracks: next.subtitleTracks,
        activeIndex: next.activeTrackIndex,
        fontSize: next.subtitleFontSize,
      }
      socket.emit('subtitle-update', { roomId, ...payload })
    },
    [socket, roomId, isHost]
  )

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          subtitleEnabled: enabled,
          // 启用时若没有激活轨道但有可用轨道，自动选第一轨
          activeTrackIndex:
            enabled &&
            prev.activeTrackIndex < 0 &&
            prev.subtitleTracks.length > 0
              ? 0
              : prev.activeTrackIndex,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const setActiveTrack = useCallback(
    (index: number) => {
      setState((prev) => {
        const next: SubtitleState = { ...prev, activeTrackIndex: index }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const addTrackFromUrl = useCallback(
    (url: string, label?: string, lang?: string) => {
      const trimmedUrl = url.trim()
      if (!trimmedUrl) return
      setState((prev) => {
        const track: SubtitleTrack = {
          url: trimmedUrl,
          label: label?.trim() || `字幕 ${prev.subtitleTracks.length + 1}`,
          lang: lang?.trim() || undefined,
        }
        const next: SubtitleState = {
          ...prev,
          subtitleTracks: [...prev.subtitleTracks, track],
          subtitleEnabled: true,
          activeTrackIndex: prev.subtitleTracks.length,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  const addTrackFromFile = useCallback(
    (file: File) => {
      // 读取为 data URL，使 blob 内容可随 socket 广播同步给观众
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result
        if (typeof dataUrl !== 'string') return
        const label = file.name.replace(/\.(vtt|srt)$/i, '')
        addTrackFromUrl(dataUrl, label)
      }
      reader.onerror = () => {
        console.error('[useSubtitles] read file error:', reader.error)
      }
      reader.readAsDataURL(file)
    },
    [addTrackFromUrl]
  )

  const setFontSize = useCallback(
    (size: number) => {
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleFontSize: size }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  // 观众：接收房主的字幕广播
  useEffect(() => {
    if (!socket || isHost) return
    const handler = (payload: Partial<SubtitleBroadcastPayload> | undefined) => {
      if (!payload) return
      setState((prev) => ({
        subtitleEnabled: payload.enabled ?? prev.subtitleEnabled,
        subtitleTracks: payload.tracks ?? prev.subtitleTracks,
        activeTrackIndex:
          payload.activeIndex ?? prev.activeTrackIndex,
        subtitleFontSize: payload.fontSize ?? prev.subtitleFontSize,
      }))
    }
    socket.on('subtitle-update', handler)
    return () => {
      socket.off('subtitle-update', handler)
    }
  }, [socket, isHost])

  return {
    ...state,
    setEnabled,
    setActiveTrack,
    addTrackFromUrl,
    addTrackFromFile,
    setFontSize,
  }
}
