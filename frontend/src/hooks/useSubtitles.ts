import { useCallback, useEffect, useRef, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { apiFetch } from '@/lib/api'
import {
  detectFormat,
  parseSubtitle,
  getSubtitleLabel,
  type SubtitleFormat,
  type ParsedCue,
} from '@/lib/subtitleParser'
import { buildServerFileProxyUrl } from '@/modules/server-files/serverFilesApi'
import {
  probeMkvSubtitleTracks,
  streamMkvSubtitleTrack,
} from '@/modules/subtitles/mkv-embedded'
import { appendAuthToken } from '@/modules/player/services/url-proxy'

export interface SubtitleTrack {
  cues: ParsedCue[]
  label: string
  lang?: string
}

/** 服务器文件内嵌字幕轨道（含用于展示的 label）。 */
export interface EmbeddedTrackInfo {
  index: number
  codecName: string
  language: string | null
  title: string | null
  label: string
  /** MKV TrackNumber（前端 demux 提取路径的轨道标识；Emby/Jellyfin 轨道无此字段） */
  trackNumber?: number
  /** 前端 MKV demux 提取的轨道为 true；Emby/Jellyfin 轨道为 false */
  frontend?: boolean
}

/**
 * 内嵌字幕提取的源描述。
 * - server-files：后端本地文件路径
 * - webdav / openlist：中转与直链均可——前端 MKV demux 是唯一提取路径，失败静默（无回退）
 * - emby / jellyfin：直接用其自带字幕接口（PlaybackInfo / Subtitles Stream），不受直链限制
 * url：可 fetch 的中转/代理/直链 URL（提供时优先走前端 MKV demux 提取）
 * directLink：直链模式标记——前端失败时不回退
 */
export type EmbeddedSource =
  | { kind: 'server-files'; path: string; url?: string }
  | { kind: 'webdav'; movieId: number; url?: string; directLink?: boolean }
  | { kind: 'openlist'; movieId: number; url?: string; directLink?: boolean }
  | { kind: 'emby'; movieId: number }
  | { kind: 'jellyfin'; movieId: number }

/** Emby/Jellyfin 字幕接口返回的格式 → subtitleParser 的 SubtitleFormat（'webvtt' → 'vtt'）。 */
function mapOutputFormat(format: string): SubtitleFormat {
  switch (format) {
    case 'ass':
      return 'ass'
    case 'webvtt':
      return 'vtt'
    case 'smi':
      return 'smi'
    case 'sub':
      return 'sub'
    default:
      return 'srt'
  }
}

/** 生成内封字幕轨道的展示标签。 */
function embeddedTrackLabel(track: {
  title?: string | null
  language?: string | null
  index: number
}): string {
  return track.title || track.language || `轨道 ${track.index}`
}

export interface SubtitleState {
  subtitleEnabled: boolean
  subtitleTracks: SubtitleTrack[]
  activeTrackIndex: number
  subtitleFontSize: number
  /** 字幕时间偏移（秒），正值延迟显示，负值提前显示 */
  subtitleOffset: number
  /** 字幕水平位移（百分比，-50~50），正值右移 */
  subtitleShiftX: number
  /** 字幕垂直位移（百分比，-50~50），正值下移 */
  subtitleShiftY: number
  /** 字幕描边宽度（px，0~4），0 表示无描边 */
  subtitleStrokeWidth: number
  /** 字幕阴影模糊半径（px，0~12），0 表示无阴影 */
  subtitleShadowBlur: number
  /** 字幕字体族（CSS font-family），空串表示默认 */
  subtitleFontFamily: string
}

interface SubtitleBroadcastPayload {
  enabled: boolean
  tracks: SubtitleTrack[]
  activeIndex: number
  fontSize: number
  offset: number
  shiftX?: number
  shiftY?: number
  strokeWidth?: number
  shadowBlur?: number
  fontFamily?: string
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
  subtitleOffset: 0,
  subtitleShiftX: 0,
  subtitleShiftY: 0,
  subtitleStrokeWidth: 0,
  subtitleShadowBlur: 4,
  subtitleFontFamily: '',
}

/**
 * 字幕状态管理 + socket 同步。
 *
 * - 房主：调用 set* 方法变更状态并广播 `subtitle-update`
 * - 观众：监听 `subtitle-update` 自动应用相同配置
 *
 * 所有格式（SRT/ASS/SSA/VTT/SMI/SUB）解析为 ParsedCue[]，
 * 保留各格式的位置/对齐/样式信息，由自定义渲染层直接显示。
 * ParsedCue[] 是纯数据，可通过 socket 直接 JSON 序列化同步给观众。
 */
export function useSubtitles({ roomId, isHost }: UseSubtitlesOptions) {
  const { socket } = useSocket()
  const [state, setState] = useState<SubtitleState>(DEFAULT_SUBTITLE_STATE)

  // 观众本地偏好标记：观众自行修改过字幕设置（开关/轨道/字号/偏移）后，
  // 房主广播的 subtitle-update 只更新轨道数据，不再覆盖观众的本地选择。
  const viewerPrefTouchedRef = useRef(false)
  /** 最新字幕状态镜像：延迟任务/回调读取，避免闭包陈旧 */
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  /**
   * 内嵌字幕提取世代 + 取消：切影片/清空轨道时使进行中的提取流立即
   * 失效（abort 网络拉流 + epoch 丢弃 in-flight chunk），防止旧影片
   * 的流式提取继续 append 污染新影片的字幕轨道。
   */
  const embeddedEpochRef = useRef(0)
  const embeddedAbortRef = useRef<AbortController | null>(null)
  /**
   * 内嵌字幕自动加载防重入标记：
   * StrictMode 双执行 / sourceUrl·开关异步初始化会重跑加载 effect，
   * 首次加载还在 await 探测时二次调用会与首路并行、重复建轨
   * （如 2 条字幕轨变成 4 条）。相同 URL 的 loading/done 均直接跳过；
   * clearTracks 只重置 done（loading 流无法取消，保留标记防并行）。
   */
  const embeddedAutoLoadRef = useRef<{
    url: string
    status: 'loading' | 'done'
  } | null>(null)

  const broadcast = useCallback(
    (next: SubtitleState) => {
      if (!socket || !isHost) return
      const payload: SubtitleBroadcastPayload = {
        enabled: next.subtitleEnabled,
        tracks: next.subtitleTracks,
        activeIndex: next.activeTrackIndex,
        fontSize: next.subtitleFontSize,
        offset: next.subtitleOffset,
        shiftX: next.subtitleShiftX,
        shiftY: next.subtitleShiftY,
        strokeWidth: next.subtitleStrokeWidth,
        shadowBlur: next.subtitleShadowBlur,
        fontFamily: next.subtitleFontFamily,
      }
      socket.emit('subtitle-update', { roomId, ...payload })
    },
    [socket, roomId, isHost]
  )

  const setEnabled = useCallback(
    (enabled: boolean) => {
      // 观众本地切换开关：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          subtitleEnabled: enabled,
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
      // 观众本地切换轨道：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, activeTrackIndex: index }
        broadcast(next)
        return next
      })
    },
    [broadcast]
  )

  /**
   * 解析字幕内容并添加为轨道。
   *
   * 内部使用：将原始文本按格式解析为 ParsedCue[]，直接存入轨道。
   */
  const addParsedTrack = useCallback(
    (
      content: string,
      filename: string,
      format: SubtitleFormat,
      customLabel?: string,
      lang?: string
    ) => {
      const cues = parseSubtitle(content, format)
      const label = customLabel?.trim() || getSubtitleLabel(filename)

      setState((prev) => {
        const track: SubtitleTrack = {
          cues,
          label: label || `字幕 ${prev.subtitleTracks.length + 1}`,
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

  const addTrackFromUrl = useCallback(
    async (url: string, label?: string, lang?: string) => {
      const trimmedUrl = url.trim()
      if (!trimmedUrl) return

      // fetch 内容后综合文件名+内容检测格式
      try {
        const res = await fetch(trimmedUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const content = await res.text()
        const detected = detectFormat(trimmedUrl, content)
        const filename =
          trimmedUrl.split('/').pop()?.split('?')[0] || 'subtitle'
        addParsedTrack(content, filename, detected, label, lang)
      } catch (err) {
        console.error('[useSubtitles] fetch subtitle URL failed:', err)
        // fetch 失败时添加空轨道
        setState((prev) => {
          const track: SubtitleTrack = {
            cues: [],
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
      }
    },
    [broadcast, addParsedTrack]
  )

  const addTrackFromFile = useCallback(
    (file: File) => {
      const reader = new FileReader()
      reader.onload = () => {
        const content = reader.result
        if (typeof content !== 'string') return
        const format = detectFormat(file.name, content)
        addParsedTrack(content, file.name, format)
      }
      reader.onerror = () => {
        console.error('[useSubtitles] read file error:', reader.error)
      }
      reader.readAsText(file)
    },
    [addParsedTrack]
  )

  /**
   * 从字幕内容直接添加轨道（供目录浏览器使用）。
   */
  const addTrackFromContent = useCallback(
    (content: string, filename: string, format: string) => {
      const fmt = format.toLowerCase() as SubtitleFormat
      addParsedTrack(content, filename, fmt)
    },
    [addParsedTrack]
  )

  const clearTracks = useCallback(() => {
    // 使进行中的内嵌提取流失效：abort 网络拉流 + 世代递增丢弃
    // in-flight chunk，防止旧影片的流继续 append 污染新轨道列表
    embeddedEpochRef.current++
    embeddedAbortRef.current?.abort()
    embeddedAbortRef.current = null
    // 清理自动加载的 URL 标记：done（已加载完）允许下次重新加载；
    // loading（进行中）保留——正在加载的流已被 abort，标记防并行重入
    if (embeddedAutoLoadRef.current?.status === 'done') {
      embeddedAutoLoadRef.current = null
    }
    setState((prev) => {
      const next: SubtitleState = {
        ...prev,
        subtitleTracks: [],
        subtitleEnabled: false,
        activeTrackIndex: -1,
        subtitleOffset: 0,
      }
      broadcast(next)
      return next
    })
  }, [broadcast])

  /**
   * 自动搜索影片同目录下的字幕文件并加载。
   */
  const searchAutoSubtitles = useCallback(
    async (movieId: number): Promise<number> => {
      if (!isHost) return 0
      try {
        const res = await apiFetch(`/api/subtitles/search?movieId=${movieId}`)
        const data = (await res.json()) as {
          success: boolean
          subtitles?: { filename: string; format: string; content: string }[]
          message?: string
        }
        if (!res.ok || !data.success || !data.subtitles) {
          return 0
        }

        const found = data.subtitles
        if (found.length === 0) return 0

        // 解析所有字幕并构建轨道列表
        const newTracks: SubtitleTrack[] = found.map((sub) => {
          const format = sub.format as SubtitleFormat
          const cues = parseSubtitle(sub.content, format)
          const label = getSubtitleLabel(sub.filename) || sub.filename
          return { cues, label, lang: undefined }
        })

        // 一次性更新状态（清空旧轨道 + 加载新轨道）
        setState((prev) => {
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: newTracks,
            subtitleEnabled: true,
            activeTrackIndex: 0,
          }
          broadcast(next)
          return next
        })
        return found.length
      } catch (err) {
        console.error('[useSubtitles] auto search failed:', err)
        return 0
      }
    },
    [isHost, broadcast]
  )

  /**
   * 前端流式提取 MKV 字幕轨：首段到达即建轨生效（秒级可播），
   * 后台逐批补齐 cues，无需等完整提取。
   *
   * - 首段到达 → resolve（字幕已开始播放）
   * - 首段前失败 / 轨为空 → reject（调用方走回退）
   * - 首段后中断 → 已提取部分保留，仅记录错误
   * - 提取过程不广播（cues 逐批增长，全量广播代价随进度二次增长），
   *   完成后广播一次全量同步观众
   *
   * @param activate 建轨时是否激活为当前字幕轨
   */
  const streamEmbeddedTrack = useCallback(
    (
      url: string,
      track: { trackNumber: number; label: string; language: string | null },
      activate: boolean,
      getPriorityTime?: () => number | null,
      signal?: AbortSignal
    ): Promise<void> => {
      // 捕获提取世代：clearTracks/切影片递增后，本流的所有 chunk 丢弃
      const epoch = embeddedEpochRef.current
      return new Promise<void>((resolve, reject) => {
        let trackIndex = -1
        let settled = false
        let broadcastDone = false
        streamMkvSubtitleTrack(url, track.trackNumber, {
          getPriorityTime,
          signal,
          onChunk: (chunk) => {
            if (embeddedEpochRef.current !== epoch) return
            const cues = parseSubtitle(chunk.text, chunk.format)
            if (cues.length === 0) return
            setState((prev) => {
              if (trackIndex < 0) {
                // 去重：相同 label 的轨道已存在（手动重复提取 / 并行流）
                // 时复用它，避免重复建轨（如 2 条字幕轨变 4 条）
                const existing = prev.subtitleTracks.findIndex(
                  (t) => t.label === track.label
                )
                if (existing >= 0) {
                  trackIndex = existing
                  // 时间戳去重：观众本地提取与房主广播全量数据并存时，
                  // 同一轨的 cue（start 相同）只保留一份，避免重复字幕
                  const starts = new Set(
                    prev.subtitleTracks[existing]!.cues.map((c) => c.start)
                  )
                  const deduped = cues.filter((c) => !starts.has(c.start))
                  if (deduped.length === 0) return prev
                  return {
                    ...prev,
                    subtitleTracks: prev.subtitleTracks.map((t, i) =>
                      i === existing
                        ? { ...t, cues: [...t.cues, ...deduped] }
                        : t
                    ),
                  }
                }
                trackIndex = prev.subtitleTracks.length
                const next: SubtitleState = {
                  ...prev,
                  subtitleTracks: [
                    ...prev.subtitleTracks,
                    {
                      cues,
                      label: track.label,
                      lang: track.language || undefined,
                    },
                  ],
                  subtitleEnabled: true,
                  activeTrackIndex: activate
                    ? trackIndex
                    : prev.activeTrackIndex,
                }
                return next
              }
              return {
                ...prev,
                subtitleTracks: prev.subtitleTracks.map((t, i) =>
                  i === trackIndex ? { ...t, cues: [...t.cues, ...cues] } : t
                ),
              }
            })
            if (!settled) {
              settled = true
              resolve()
            }
          },
        }).then(
          () => {
            if (!settled) {
              settled = true
              reject(new Error('字幕轨为空'))
              return
            }
            // 提取完成：广播全量同步观众（updater 返回原引用不触发渲染）
            setState((prev) => {
              if (!broadcastDone) {
                broadcastDone = true
                broadcast(prev)
              }
              return prev
            })
          },
          (err) => {
            if (!settled) {
              settled = true
              reject(err)
            } else {
              console.error(
                '[useSubtitles] 流式提取中断（保留已提取部分）：',
                err instanceof Error ? err.message : err
              )
              setState((prev) => {
                if (!broadcastDone) {
                  broadcastDone = true
                  broadcast(prev)
                }
                return prev
              })
            }
          }
        )
      })
    },
    [] // setState 稳定；broadcast 不在流式过程中使用（完成时快照）
  )

  /**
   * 加载视频文件中的内嵌字幕轨道。
   * @param filePath server-files 路径
   * @param sourceUrl 挂载源（webdav/openlist，中转或直链）播放 URL
   * 全部走前端 MKV demux 提取（后端 ffmpeg 已移除，无回退链路）
   */
  const loadEmbeddedSubtitles = useCallback(
    async (
      filePath: string,
      sourceUrl?: string,
      getPriorityTime?: () => number | null
    ): Promise<number> => {
      // 观众已从房主广播获得字幕轨道时无需本地提取（广播数据优先）；
      // 房主提取中（大文件耗时数分钟）或广播缺失时观众本地提取
      if (!isHost && stateRef.current.subtitleTracks.length > 0) return 0

      // mkv-embedded 的 fetch 无法携带 Authorization 头，
      // 本站 /api/ URL 必须附加 token query（与播放引擎 appendAuthToken 一致），
      // 否则 401 → 探测失败显示「未检测到内嵌字幕」。直链 URL 原样返回。
      const url = appendAuthToken(
        sourceUrl ?? buildServerFileProxyUrl(filePath)
      )

      // 防并行重入：同一 URL 加载中（首路还在探测）或已完成时，
      // StrictMode/effect 重跑的二次调用直接跳过，避免重复建轨
      if (embeddedAutoLoadRef.current?.url === url) return 0
      embeddedAutoLoadRef.current = { url, status: 'loading' }

      // 上一次提取流若还在跑（另一影片/URL），先取消防污染
      embeddedAbortRef.current?.abort()
      const controller = new AbortController()
      embeddedAbortRef.current = controller

      const finish = (started: number): number => {
        embeddedAutoLoadRef.current = { url, status: 'done' }
        return started
      }

      try {
        const probed = await probeMkvSubtitleTracks(
          url,
          undefined,
          controller.signal
        )
        const extractable = probed.filter((t) => t.supported)
        let started = 0
        for (const track of extractable) {
          try {
            // 逐轨 await 首段（秒级），后台继续补齐后续 cues
            await streamEmbeddedTrack(
              url,
              {
                trackNumber: track.trackNumber,
                label: track.label,
                language: track.language,
              },
              started === 0, // 首条成功轨激活；后续轨保持当前激活不变
              getPriorityTime,
              controller.signal
            )
            started++
          } catch (err) {
            if (controller.signal.aborted) return 0
            console.error(
              '[useSubtitles] frontend stream embedded subtitle failed:',
              track.trackNumber,
              err
            )
          }
        }
        if (started > 0) {
          // 首段已到达、字幕轨已生效，后台继续补齐，无需等待
          return finish(started)
        }
        // 一条都没提出来（如非 MKV 容器 / 全部为位图字幕轨）
        console.info(
          '[useSubtitles] 前端提取内嵌字幕不可用（非 MKV / 位图字幕轨 / CORS 拒绝），跳过自动加载'
        )
        return finish(0)
      } catch (err) {
        if (controller.signal.aborted) return 0
        console.info(
          '[useSubtitles] 前端探测内嵌字幕失败，跳过（无后端回退）：',
          err instanceof Error ? err.message : err
        )
        embeddedAutoLoadRef.current = null
        return 0
      }
    },
    [isHost, streamEmbeddedTrack]
  )

  /**
   * 列出视频文件内的内嵌字幕轨道（仅探测，不提取内容）。
   * 供 UI 先展示可用轨道，再由用户挑选某一条提取播放。
   * - server-files / webdav / openlist：前端 MKV demux 探测（唯一路径，无后端回退）
   * - emby / jellyfin：后端调用其自带 PlaybackInfo 接口
   */
  const listEmbeddedTracks = useCallback(
    async (source: EmbeddedSource): Promise<EmbeddedTrackInfo[]> => {
      if (!isHost) return []
      // 前端探测：server-files 恒有代理 URL；挂载源（中转/直链）带 URL 时同样可探测。
      // /api/ URL 需附加 token query（同播放引擎），否则 401 探测失败
      if (source.kind !== 'emby' && source.kind !== 'jellyfin') {
        const url = appendAuthToken(
          source.kind === 'server-files'
            ? source.url || buildServerFileProxyUrl(source.path)
            : source.url
        )
        if (url) {
          try {
            const probed = await probeMkvSubtitleTracks(url)
            return probed.map((t, i) => ({
              index: i,
              codecName: t.codecId,
              language: t.language,
              title: t.title,
              label: t.label,
              trackNumber: t.trackNumber,
              frontend: true,
            }))
          } catch (err) {
            // 唯一路径失败（常见原因：直链服务器未开 CORS、非 MKV 容器），无回退
            console.info(
              '[useSubtitles] 前端探测字幕轨失败（无后端回退）：',
              err instanceof Error ? err.message : err
            )
          }
        }
        return []
      }
      try {
        // Emby/Jellyfin：后端调用其 PlaybackInfo 接口
        const res = await apiFetch(
          `/api/subtitles/embedded-tracks?movieId=${source.movieId}`
        )
        const data = (await res.json()) as {
          success: boolean
          tracks?: EmbeddedTrackInfo[]
          message?: string
        }
        if (!res.ok || !data.success || !data.tracks) {
          throw new Error(data.message || '获取内嵌字幕轨道失败')
        }
        return data.tracks
      } catch (err) {
        console.error('[useSubtitles] list embedded tracks failed:', err)
        return []
      }
    },
    [isHost]
  )

  /**
   * 提取指定一条内嵌字幕轨道并添加为可播放的字幕轨道。
   * - server-files / webdav / openlist：前端 MKV demux 流式提取（track.frontend 标记，保留 ASS 样式）
   * - emby / jellyfin：后端调用其自带 Subtitles Stream 端点
   */
  const extractEmbeddedTrack = useCallback(
    async (
      source: EmbeddedSource,
      track: EmbeddedTrackInfo
    ): Promise<number> => {
      if (!isHost) return 0

      // 前端提取路径：探测阶段标记的 MKV 轨道
      if (track.frontend && track.trackNumber != null) {
        // /api/ URL 需附加 token query（同播放引擎），否则 401 提取失败
        const rawUrl =
          source.kind === 'server-files'
            ? source.url || buildServerFileProxyUrl(source.path)
            : source.kind === 'webdav' || source.kind === 'openlist'
              ? source.url
              : undefined
        const url = rawUrl ? appendAuthToken(rawUrl) : undefined
        if (url) {
          try {
            // 流式提取：首段到达即建轨生效（秒级可播），后台补齐
            await streamEmbeddedTrack(
              url,
              {
                trackNumber: track.trackNumber,
                label: track.label,
                language: track.language,
              },
              true
            )
            return 1
          } catch (err) {
            console.error(
              '[useSubtitles] frontend extract embedded track failed:',
              track.trackNumber,
              err
            )
            return 0 // 唯一路径失败，无后端回退
          }
        }
      }

      // Emby/Jellyfin：后端调用其自带 Subtitles Stream 端点
      if (source.kind !== 'emby' && source.kind !== 'jellyfin') return 0
      try {
        const res = await apiFetch(
          `/api/subtitles/embedded-extract?movieId=${source.movieId}&index=${track.index}`
        )
        const data = (await res.json()) as {
          success: boolean
          content?: string
          format?: string
          label?: string
          language?: string | null
          message?: string
        }
        if (!res.ok || !data.success || !data.content) {
          throw new Error(data.message || '提取内嵌字幕失败')
        }
        const cues = parseSubtitle(
          data.content,
          mapOutputFormat(data.format || 'srt')
        )
        const newTrack: SubtitleTrack = {
          cues,
          label: track.label || data.label || embeddedTrackLabel(track),
          lang: data.language ?? track.language ?? undefined,
        }
        setState((prev) => {
          // 去重：相同 label 的轨道已存在（重复手动提取）时激活它而非重复建轨
          const existing = prev.subtitleTracks.findIndex(
            (t) => t.label === newTrack.label
          )
          if (existing >= 0) {
            return prev
          }
          const next: SubtitleState = {
            ...prev,
            subtitleTracks: [...prev.subtitleTracks, newTrack],
            subtitleEnabled: true,
            activeTrackIndex: prev.subtitleTracks.length,
          }
          broadcast(next)
          return next
        })
        return 1
      } catch (err) {
        console.error(
          '[useSubtitles] extract embedded track failed:',
          track.index,
          err
        )
        return 0
      }
    },
    [isHost, broadcast]
  )

  const setFontSize = useCallback(
    (size: number) => {
      // 观众本地调字号：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleFontSize: size }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setOffset = useCallback(
    (offset: number) => {
      // 观众本地调偏移：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleOffset: offset }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setShiftX = useCallback(
    (shiftX: number) => {
      // 观众本地调水平位移：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleShiftX: shiftX }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setShiftY = useCallback(
    (shiftY: number) => {
      // 观众本地调垂直位移：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleShiftY: shiftY }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setStrokeWidth = useCallback(
    (strokeWidth: number) => {
      // 观众本地调描边：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = {
          ...prev,
          subtitleStrokeWidth: strokeWidth,
        }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setShadowBlur = useCallback(
    (shadowBlur: number) => {
      // 观众本地调阴影：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleShadowBlur: shadowBlur }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  const setFontFamily = useCallback(
    (fontFamily: string) => {
      // 观众本地换字体：标记偏好，后续房主广播不覆盖此选择
      if (!isHost) viewerPrefTouchedRef.current = true
      setState((prev) => {
        const next: SubtitleState = { ...prev, subtitleFontFamily: fontFamily }
        broadcast(next)
        return next
      })
    },
    [broadcast, isHost]
  )

  // 观众：接收房主的字幕广播
  useEffect(() => {
    if (!socket || isHost) return
    const handler = (
      payload: Partial<SubtitleBroadcastPayload> | undefined
    ) => {
      if (!payload) return
      // 房主清空字幕（切影片）时，观众本地的内嵌提取流一并失效，
      // 防止旧影片的流继续 append 重建轨道
      if (Array.isArray(payload.tracks) && payload.tracks.length === 0) {
        embeddedEpochRef.current++
        embeddedAbortRef.current?.abort()
        embeddedAbortRef.current = null
      }
      // 观众改过本地偏好（开关/轨道/字号/偏移）后，房主广播只更新轨道
      // 数据；偏好字段保持观众本地选择。未改过则全量跟随房主。
      const touched = viewerPrefTouchedRef.current
      setState((prev) => ({
        subtitleEnabled: touched
          ? prev.subtitleEnabled
          : (payload.enabled ?? prev.subtitleEnabled),
        // 轨道数据：以房主广播为基准（数量/顺序/新增/清空均跟随房主，
        // 房主手动上传的轨道由此同步给观众）；仅当本地同索引轨道 label
        // 一致且 cues 更多（观众本地流式提取进度领先房主快照）时保留
        // 本地该条——本地提取有 seek 感知（房主跳转后观众跟随跳转也能
        // 秒出字幕），且避免替换打断进行中的流
        subtitleTracks: payload.tracks
          ? payload.tracks.map((t, i) => {
              const local = prev.subtitleTracks[i]
              return local &&
                local.label === t.label &&
                local.cues.length > t.cues.length
                ? local
                : t
            })
          : prev.subtitleTracks,
        activeTrackIndex: touched
          ? prev.activeTrackIndex
          : (payload.activeIndex ?? prev.activeTrackIndex),
        subtitleFontSize: touched
          ? prev.subtitleFontSize
          : (payload.fontSize ?? prev.subtitleFontSize),
        subtitleOffset: touched
          ? prev.subtitleOffset
          : (payload.offset ?? prev.subtitleOffset),
        subtitleShiftX: touched
          ? prev.subtitleShiftX
          : (payload.shiftX ?? prev.subtitleShiftX),
        subtitleShiftY: touched
          ? prev.subtitleShiftY
          : (payload.shiftY ?? prev.subtitleShiftY),
        subtitleStrokeWidth: touched
          ? prev.subtitleStrokeWidth
          : (payload.strokeWidth ?? prev.subtitleStrokeWidth),
        subtitleShadowBlur: touched
          ? prev.subtitleShadowBlur
          : (payload.shadowBlur ?? prev.subtitleShadowBlur),
        subtitleFontFamily: touched
          ? prev.subtitleFontFamily
          : (payload.fontFamily ?? prev.subtitleFontFamily),
      }))
    }
    socket.on('subtitle-update', handler)
    // 加入时后端在 request-join 处理中回发的 subtitle-update 早于此
    // 监听器挂载（组件渲染后才有 useEffect），会丢失。挂载完成后主动
    // 拉取一次房主缓存的字幕状态，确保中途加入/刷新的观众也能拿到字幕。
    socket.emit('subtitle-request', { roomId })
    return () => {
      socket.off('subtitle-update', handler)
    }
  }, [socket, isHost, roomId])

  return {
    ...state,
    setEnabled,
    setActiveTrack,
    addTrackFromUrl,
    addTrackFromFile,
    addTrackFromContent,
    clearTracks,
    searchAutoSubtitles,
    loadEmbeddedSubtitles,
    listEmbeddedTracks,
    extractEmbeddedTrack,
    setFontSize,
    setOffset,
    setShiftX,
    setShiftY,
    setStrokeWidth,
    setShadowBlur,
    setFontFamily,
  }
}
