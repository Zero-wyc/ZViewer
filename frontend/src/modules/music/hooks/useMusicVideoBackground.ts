/**
 * 歌词模块自定义视频背景的解析 Hook（Hydrogen PlayerVideo 的 Web 复刻数据层）。
 *
 * 解析链路复用「一起看」哔哩哔哩模块：
 * - CLI 开启（音乐设置「视频背景 CLI 高画质」）且本地 zcontrol-cli 已连接：
 *   resolveBilibiliViaCli → 用户自己 Cookie 的大会员高画质 DASH 流
 *   （videoUrl + audioUrl 均已包装为 CLI 本地代理 URL）
 * - 其余情况（默认）：服务器端解析 resolveBilibiliWithOptions → 720P
 *   （qn=64）MP4 直链，播放器引擎经后端代理注入 Referer 后直连播放
 *
 * 背景 video 元素始终静音（音频由网易云音轨承担，Hydrogen muteNativeVideoElement
 * 同语义），因此 DASH 场景音频流仅作为引擎 MSE 合流的输入、不参与输出。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { resolveBilibiliViaCli } from '@/modules/bilibili/cliApi'
import { getActiveCliProxyUrl } from '@/modules/room/watch-together/movie-source-resolver'
import {
  getMusicVideo,
  subscribeMusicVideo,
  type MusicVideoBinding,
} from '../musicVideoStore'

/** 服务器端解析的默认清晰度：720P（B站 qn=64） */
const DEFAULT_QN = 64

/** 解析完成后的可播放源（与 PlayerSource 的最小字段集对齐） */
export interface MusicVideoSource {
  url: string
  audioUrl?: string
  format?: 'mp4' | 'dash'
  videoCodec?: string
  audioCodec?: string
  /**
   * 视频时长（秒，来自解析结果）。DASH 流的容器 mvhd 时长为 0/缺失，
   * 引擎（DashPlayer）以此写 MPD mediaPresentationDuration——缺失时
   * video.duration 无效（0/Infinity），背景视频的进度同步会全部失效
   */
  duration?: number
}

export type MusicVideoBgStatus =
  | 'idle' // 当前歌曲无关联视频
  | 'loading' // 解析中（背景暂用封面模糊兜底）
  | 'ready' // 解析成功，source 可用
  | 'error' // 解析失败（静默降级为封面背景）

export interface MusicVideoBackgroundState {
  status: MusicVideoBgStatus
  source: MusicVideoSource | null
  binding: MusicVideoBinding | null
  /** 实际生效的解析路径（提示/调试用） */
  via: 'cli' | 'server' | null
}

export function useMusicVideoBackground(
  songId: number | null,
  cliEnabled: boolean,
  /**
   * B站 本地插播曲目（哔哩哔哩页播放）：直接以其视频作为背景，
   * 优先级高于 songId 的本地绑定（bili 存在时忽略绑定查询）
   */
  biliBvid: string | null = null,
  biliCid = 0,
  /** CLI 高画质分辨率（B站 qn，0=自动跟随账号默认；仅 CLI 路径生效） */
  qn = 0
): MusicVideoBackgroundState {
  // 关联变化（弹窗保存/删除）即时感知：外部 store 快照经 useSyncExternalStore
  // 订阅（getMusicVideo 引用稳定，见 musicVideoStore 的解析缓存）
  const getBindingSnapshot = useCallback(
    () => (biliBvid != null || songId == null ? null : getMusicVideo(songId)),
    [songId, biliBvid]
  )
  const storedBinding = useSyncExternalStore(
    subscribeMusicVideo,
    getBindingSnapshot
  )
  // B站 插播优先；否则用本地绑定（useMemo 保证引用稳定，避免解析 effect 逐帧重跑）
  const binding: MusicVideoBinding | null = useMemo(
    () => (biliBvid != null ? { bvid: biliBvid, cid: biliCid } : storedBinding),
    [biliBvid, biliCid, storedBinding]
  )

  const [state, setState] = useState<MusicVideoBackgroundState>({
    status: 'idle',
    source: null,
    binding: null,
    via: null,
  })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // 无关联歌曲：直接回退封面背景
      if (!binding) {
        setState({ status: 'idle', source: null, binding: null, via: null })
        return
      }
      setState((prev) => ({
        ...prev,
        status: 'loading',
        binding,
        via: null,
      }))
      try {
        const pageUrl = `https://www.bilibili.com/video/${binding.bvid}`
        // CLI 开启且本地代理已连接 → 高画质 DASH；否则回退 720P 直链
        const proxyUrl = cliEnabled ? getActiveCliProxyUrl() : null
        let resolved: MusicVideoSource
        let via: 'cli' | 'server'
        if (proxyUrl) {
          const r = await resolveBilibiliViaCli(
            proxyUrl,
            binding.bvid,
            binding.cid,
            qn > 0 ? qn : undefined,
            false,
            true
          )
          resolved = {
            url: r.videoUrl,
            audioUrl: r.audioUrl,
            format: (r.format as MusicVideoSource['format']) ?? 'dash',
            videoCodec: r.videoCodec,
            audioCodec: r.audioCodec,
            // DASH 流容器时长不可靠：显式传给引擎写 MPD duration，
            // 否则 video.duration 无效、背景视频进度同步全部失效
            duration: r.duration,
          }
          via = 'cli'
        } else {
          if (cliEnabled) {
            console.warn(
              '[useMusicVideoBackground] CLI 未连接，回退 720P 直链解析'
            )
          }
          const r = await resolveBilibiliWithOptions(
            pageUrl,
            DEFAULT_QN,
            undefined,
            { preferMp4: true }
          )
          resolved = {
            url: r.videoUrl,
            audioUrl: r.audioUrl,
            format: (r.format as MusicVideoSource['format']) ?? 'mp4',
            videoCodec: r.videoCodec,
            audioCodec: r.audioCodec,
            duration: r.duration,
          }
          via = 'server'
        }
        if (cancelled) return
        if (!resolved.url) {
          setState({ status: 'error', source: null, binding, via })
          return
        }
        setState({ status: 'ready', source: resolved, binding, via })
      } catch (err) {
        console.warn('[useMusicVideoBackground] 视频背景解析失败:', err)
        if (cancelled) return
        setState({ status: 'error', source: null, binding, via: null })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [songId, binding, cliEnabled, qn])

  return state
}
