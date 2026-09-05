/**
 * 影片播放源解析器（从 useWatchTogether.loadMovie 抽取）。
 *
 * 将「影片记录 → 可 attach 的播放源字段」的决策逻辑收敛为纯数据函数：
 * - B站 源：在线解析 playurl（带解析进度回调）；
 * - 房主刷新恢复（recovery）且旧 URL 可用：优先复用旧 URL，
 *   标记 reusedRecoveryUrl，attach 失败时由调用方回退到在线解析；
 * - 其他源（webdav / ftp / url 等）：直接使用影片记录字段。
 *
 * 本模块不触碰 React 状态 / store / message，所有副作用留在调用方。
 */
import type { Movie } from '@/store/roomStore'
import { detectMediaFormat, type MediaFormat } from '@/lib/mediaFormat'
import { resolveBilibiliWithOptions } from '@/modules/bilibili/bilibiliApi'
import { extractBvid, resolveBilibiliViaCli } from '@/modules/bilibili/cliApi'
import { useCliAgentStore } from '@/store/cliAgentStore'
import { getBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import type { QualityOption } from './resolveSource'
import { buildServerFileProxyUrl } from '@/modules/server-files/serverFilesApi'
import {
  resolveAniSubsEpisode,
  buildAniSubsProxyUrl,
  needsAniSubsProxy,
} from '@/modules/anisubs'

/** 房主刷新恢复时由后端返回的最近一次播放状态（源相关子集） */
export interface RecoverySourceInfo {
  currentTime: number
  playbackRate: number
  isPlaying: boolean
  duration?: number
  sourceUrl?: string
  sourceType?: string
  audioUrl?: string
  format?: MediaFormat
  videoCodec?: string
  audioCodec?: string
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  currentMovieId?: number
  headers?: Record<string, string>
}

/** 解析出的播放源字段（供构建 WatchTogetherState） */
export interface ResolvedMovieSource {
  sourceUrl: string
  audioUrl?: string
  format?: MediaFormat
  videoCodec?: string
  audioCodec?: string
  cid?: number
  duration: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  headers?: Record<string, string>
  /**
   * true 表示本次复用了 recovery 中的旧 URL（未在线解析）。
   * attach 失败（通常 403/404 deadline 过期）时调用方应回退到
   * resolveBilibiliOnline 重新解析后重试。
   */
  reusedRecoveryUrl: boolean
  /**
   * MKV 快速路径：音轨为浏览器原生友好编码（AAC/MP3/Opus）时置位，
   * 跳过 playsvideo 重封装管线直接原生播放（原生失败自动回退管线）。
   */
  mkvFastPath?: boolean
}

export interface ResolveMovieSourceOptions {
  movie: Movie
  /** 归一化后的源类型（movie.sourceType 中 'mp4' 已映射为 'url'） */
  sourceType: string
  /** 恢复信息；仅当 currentMovieId 与影片匹配时由调用方传入 */
  recovery?: RecoverySourceInfo | null
  /** B站 在线解析进度回调 */
  onProgress?: (step: string, message: string) => void
}

/**
 * 将 CLI 代理 URL 归一化为本地 127.0.0.1 地址。
 *
 * 本地 CLI 的 HTTP 服务始终运行在当前机器上，浏览器应直接请求 127.0.0.1。
 * 某些旧版 CLI 或网络环境下，后端下发的 proxyUrl 可能携带公网/内网 host，
 * 统一替换 hostname 为 127.0.0.1 可防止浏览器跨域拦截。
 */
function normalizeLocalCliProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    url.hostname = '127.0.0.1'
    return url.toString()
  } catch {
    return proxyUrl
  }
}

/**
 * 获取当前可用的 CLI 代理 URL。
 *
 * 当房间内至少有一个 CLI 代理注册（通过 socket）时返回其 proxyUrl。
 * 不再强制要求 localOnline（本地健康检查通过）：健康检查可能因 CORS、
 * 网络抖动或浏览器安全策略暂时失败，但 CLI 的 HTTP 服务实际可用。
 * 如果 HTTP 服务确实不可用，resolveBilibiliViaCli 的 fetch 会失败并报错。
 */
export function getActiveCliProxyUrl(): string | null {
  const { agents } = useCliAgentStore.getState()
  if (agents.length === 0) return null
  return normalizeLocalCliProxyUrl(agents[0].proxyUrl)
}

/**
 * 获取影片实际生效的 MP4 偏好。
 *
 * 当用户启用 CLI 高画质代理后，强制走 DASH 代理路径，不再降级到 MP4；
 * 即使本地 CLI 暂时未连接，也保持 DASH 请求，由调用方提示连接代理，
 * 避免用户开启 CLI 后因网络问题被自动切回 MP4。
 *
 * 当服务器端 DASH 被禁用（dashDisabled）且 CLI 未启用时，强制 MP4。
 */
export function getEffectivePreferMp4(movieId: number): boolean {
  const { preferMp4, cliEnabled } = getBilibiliParseOptions(movieId)
  if (cliEnabled) {
    // CLI 已启用：强制使用 DASH，不受 dashDisabled 影响
    return false
  }
  // CLI 未启用：检查服务器端是否禁用了 DASH
  const { dashDisabled } = useSystemSettingsStore.getState()
  if (dashDisabled) {
    return true
  }
  return preferMp4
}

function mapResolvedSourceToMovieSource(
  resolved: {
    videoUrl: string
    audioUrl?: string
    format?: MediaFormat
    videoCodec?: string
    audioCodec?: string
    cid?: number
    duration?: number
    currentQn?: number
    acceptQuality?: QualityOption[]
  },
  movie: Movie
): ResolvedMovieSource {
  if (!resolved.videoUrl) {
    throw new Error('未获取到对应清晰度的播放地址')
  }
  return {
    sourceUrl: resolved.videoUrl,
    audioUrl: resolved.audioUrl,
    format: resolved.format,
    videoCodec: resolved.videoCodec,
    audioCodec: resolved.audioCodec,
    cid: resolved.cid,
    duration: resolved.duration ?? movie.duration ?? 0,
    currentQn: resolved.currentQn ?? movie.currentQn,
    acceptQuality: resolved.acceptQuality ?? movie.acceptQuality,
    headers: undefined,
    reusedRecoveryUrl: false,
  }
}

/**
 * 在线解析 B站 视频 playurl。
 * 独立导出供「复用旧 URL 失败后的回退重新解析」复用。
 *
 * 若该影片启用了 CLI 代理且本地 CLI 在线，则通过 CLI 使用用户自己的 Cookie
 * 解析高画质地址；否则回退到服务端解析。
 */
export async function resolveBilibiliOnline(
  movie: Movie,
  onProgress?: (step: string, message: string) => void,
  options?: { preferMp4?: boolean }
): Promise<ResolvedMovieSource> {
  const parsePrefs = getBilibiliParseOptions(movie.id)
  const proxyUrl = parsePrefs.cliEnabled ? getActiveCliProxyUrl() : null
  // CLI 已启用时强制使用 DASH 代理，不再降级 MP4；未连接时直接报错，避免回退
  const effectivePreferMp4 =
    options?.preferMp4 ?? getEffectivePreferMp4(movie.id)
  const forceDash = parsePrefs.cliEnabled && !!proxyUrl

  if (parsePrefs.cliEnabled && !proxyUrl) {
    throw new Error('CLI 代理未连接，请先启动本地 zcontrol-cli')
  }

  if (proxyUrl) {
    const bvid = extractBvid(movie.url)
    if (bvid && movie.cid) {
      const resolved = await resolveBilibiliViaCli(
        proxyUrl,
        bvid,
        movie.cid,
        movie.currentQn,
        effectivePreferMp4,
        forceDash
      )
      return mapResolvedSourceToMovieSource(resolved, movie)
    }
  }

  const resolved = await resolveBilibiliWithOptions(
    movie.url,
    movie.currentQn,
    onProgress,
    { preferMp4: effectivePreferMp4 }
  )
  return mapResolvedSourceToMovieSource(resolved, movie)
}

/**
 * 在线解析 ani-subs 番剧源播放地址。
 *
 * ani-subs 的视频地址通常带 token/signature，短期有效（几分钟到几小时）。
 * 每次播放（含刷新恢复）都通过 sourceMeta 重新解析，确保使用最新地址。
 *
 * 防盗链处理：若返回 headers（Referer/UA 等），构建后端代理 URL。
 * 浏览器无法为 video.src 设置 Referer/UA，必须走代理。
 *
 * @throws sourceMeta 缺失或解析失败时抛错
 */
export async function resolveAnimeOnline(
  movie: Movie
): Promise<ResolvedMovieSource> {
  if (!movie.sourceMeta) {
    throw new Error('番剧源元数据缺失，请重新添加该番剧')
  }

  const { sourceId, episode } = movie.sourceMeta
  const resolved = await resolveAniSubsEpisode(sourceId, episode)

  // 防盗链处理：若返回 headers，走后端代理 URL
  const finalUrl = needsAniSubsProxy(resolved.url, resolved.headers)
    ? buildAniSubsProxyUrl(resolved.url, resolved.headers)
    : resolved.url

  return {
    sourceUrl: finalUrl,
    audioUrl: undefined,
    format: resolved.format as MediaFormat | undefined,
    videoCodec: undefined,
    audioCodec: undefined,
    duration: movie.duration ?? 0,
    headers: undefined,
    reusedRecoveryUrl: false,
  }
}

/**
 * 解析影片的播放源。
 *
 * - B站 源：在线解析 playurl（带解析进度回调）；
 * - ani-subs 番剧源：通过 sourceMeta 在线解析（URL 短期有效，每次重新解析）；
 * - 房主刷新恢复（recovery）且旧 URL 可用：优先复用旧 URL，
 *   标记 reusedRecoveryUrl，attach 失败时由调用方回退到在线解析；
 * - 其他源（webdav / ftp / url 等）：直接使用影片记录字段。
 *
 * @throws 在线解析失败且无旧 URL 可复用时抛错（调用方决定提示与重试策略）
 */
export async function resolveMovieSource({
  movie,
  sourceType,
  recovery,
  onProgress,
}: ResolveMovieSourceOptions): Promise<ResolvedMovieSource> {
  if (sourceType === 'bilibili') {
    // 恢复场景且旧 URL 可用：直接复用，跳过在线解析
    if (recovery?.sourceUrl) {
      // B站 源的防盗链由服务器代理（m4s）或直连（MP4）处理，不需要前端 headers。
      // recovery.headers 可能来自旧的非 B站 源（如 anime），复用时必须清除，
      // 否则 resolveProxyUrl 会因 hasHeaders=true 将 MP4 直链包装为服务器代理 URL。
      if (recovery.headers && Object.keys(recovery.headers).length > 0) {
        console.warn(
          '[movie-source-resolver] B站 recovery 路径中清除非 B站 headers:',
          recovery.headers
        )
      }
      return {
        sourceUrl: recovery.sourceUrl,
        audioUrl: recovery.audioUrl,
        format: recovery.format,
        videoCodec: recovery.videoCodec,
        audioCodec: recovery.audioCodec,
        cid: recovery.cid,
        duration: recovery.duration ?? movie.duration ?? 0,
        currentQn: recovery.currentQn ?? movie.currentQn,
        acceptQuality: recovery.acceptQuality ?? movie.acceptQuality,
        headers: undefined,
        reusedRecoveryUrl: true,
      }
    }
    return resolveBilibiliOnline(movie, onProgress)
  }

  if (sourceType === 'anime') {
    // ani-subs 番剧源：URL 短期有效，每次播放都通过 sourceMeta 重新解析
    // recovery 场景下也强制重新解析，因为旧 URL 大概率已过期
    return resolveAnimeOnline(movie)
  }

  // 非 B站 源：直接使用影片记录字段（Movie 类型不含 headers，见 roomStore）
  // server-files 源特殊处理：movie.url 是添加者（房主）按其自身 API 地址拼的
  // 绝对代理 URL，随影片记录广播给所有观众——外网/跨域观众的浏览器拿到的
  // 是房主的内网地址，无法访问导致播放失败。此处按「当前客户端自己」的
  // API 地址重建代理 URL（文件路径保存在 movie.path），内外网各自可达。
  //
  // MKV 快速路径：音轨为浏览器原生友好编码（AAC/MP3/Opus）时，跳过
  // playsvideo 重封装管线直接原生播放（瞬时起播、暂停即静音）；原生
  // 失败（video.error）由 usePlayerSource 自动回退管线，能力不损失。
  // 视频编码同样参与判定：Chrome 对 MKV 的原生支持仅限 H.264 视频，
  // HEVC（尤其 10bit）必然 NotSupportedError，有元数据时提前避开
  // 一次注定失败的原生尝试；videoCodec 缺失（server-files 源不探测）
  // 时不阻止快速路径，由 attach 失败回退兜底。
  // DTS/AC3/EAC3/FLAC 等编码仍走管线（重封装或浏览器端转码）。
  if (sourceType === 'server-files' && movie.path) {
    const format = movie.format || detectMediaFormat(movie.path)
    const audio = (movie.audioCodec || '').toLowerCase()
    const video = (movie.videoCodec || '').toLowerCase()
    const videoNativeSafe = !video || video.includes('avc') || video.includes('h264')
    const browserSafeAudio =
      format === 'mkv' &&
      videoNativeSafe &&
      ['aac', 'mp3', 'opus', 'vorbis'].includes(audio)
    return {
      sourceUrl: buildServerFileProxyUrl(movie.path),
      audioUrl: movie.audioUrl,
      format,
      videoCodec: movie.videoCodec,
      audioCodec: movie.audioCodec,
      cid: movie.cid,
      duration: movie.duration || 0,
      currentQn: movie.currentQn,
      acceptQuality: movie.acceptQuality,
      headers: undefined,
      reusedRecoveryUrl: false,
      mkvFastPath: browserSafeAudio,
    }
  }

  // 其余源：format 兜底从 URL 扩展名自动推断
  const inferredFormat = movie.format || detectMediaFormat(movie.url)
  return {
    sourceUrl: movie.url,
    audioUrl: movie.audioUrl,
    format: inferredFormat,
    videoCodec: movie.videoCodec,
    audioCodec: movie.audioCodec,
    cid: movie.cid,
    duration: movie.duration || 0,
    currentQn: movie.currentQn,
    acceptQuality: movie.acceptQuality,
    headers: undefined,
    reusedRecoveryUrl: false,
  }
}
