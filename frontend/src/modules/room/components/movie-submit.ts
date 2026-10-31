/**
 * 各来源的「添加影片」提交器（纯搬迁自 MoviePushPanel 内联函数）。
 * 与 source-forms/ 对称：面板只做分发（handleAddMovie 按 sourceType 调用），
 * 每个来源一个提交器。共同约定：入参校验失败 message.warning 后 return；
 * 成功路径 resetForm() + message.success('影片已添加')。
 * 提交器只负责「resolve + addMovie + 解析偏好落库」，不触碰面板 UI 状态
 * （loading/进度由调用方 handleAddMovie 统一管理）。
 */
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { detectMediaFormat, type MediaFormat } from '@/lib/mediaFormat'
import { setBilibiliParseOptions } from '@/modules/bilibili/parseOptions'
import { isBilibiliPgcMovie } from '@/modules/movie-source/resolver'
import {
  resolveFTP,
  type FTPParams,
  type ResolvedSource,
} from '@/modules/movie-source/resolveSource'
import {
  resolveOpenList,
  fetchOpenListDirectUrl,
} from '@/modules/openlist/openlistApi'
import { resolveWebDAV, fetchWebDAVDirectUrl } from '@/modules/webdav/webdavApi'
import { resolveFTP as resolveFTPNew } from '@/modules/ftp/ftpApi'
import { resolveEmby } from '@/modules/emby/embyApi'
import { resolveJellyfin } from '@/modules/jellyfin/jellyfinApi'
import {
  resolveServerFile,
  buildServerFileProxyUrl,
} from '@/modules/server-files/serverFilesApi'
import type { UnionMount } from '@/modules/mounts'
import type { SourceType } from './source-forms'
import { t } from '@/i18n'

type RoomState = ReturnType<typeof useRoomStore.getState>

/** roomStore.addMovie 的 payload（playsvideoEnabled 由面板统一注入，提交器不感知） */
export type SubmitMoviePayload = Omit<
  Parameters<RoomState['addMovie']>[1],
  'playsvideoEnabled'
>

export type SubmitAddMovie = (
  roomId: string,
  payload: SubmitMoviePayload
) => Promise<Awaited<ReturnType<RoomState['addMovie']>>>

/** 提交器共享上下文：面板在 handleAddMovie 时点构建，一次性传入全部表单状态 */
export interface SubmitMovieContext {
  roomId: string
  addMovie: SubmitAddMovie
  resetForm: () => void
  setResolveProgress: (text: string) => void
  /** 当前来源类型（区分 webdav/openlist 双形态提交） */
  sourceType: SourceType
  url: string
  /** 最近一次 B站 解析结果（仅 bilibili 分支保证非空） */
  resolvedMovie: ResolvedSource | null
  /** 最近一次 B站 解析是否走 CLI 代理（持久化解析偏好用） */
  resolvedViaCli: boolean
  webdav: { serverUrl: string; path: string }
  openlist: { serverUrl: string; path: string }
  ftp: FTPParams
  serverFilePath: string
  selectedMountId: string
  mounts: UnionMount[]
  webdavDirectLink: boolean
  openlistDirectLink: boolean
  embyDirectLink: boolean
  jellyfinDirectLink: boolean
  isWebdavInternal: boolean
  isOpenlistInternal: boolean
}

export function extractTitleFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname
    const filename = pathname.split('/').pop() || url
    return decodeURIComponent(filename)
  } catch {
    return url
  }
}

export async function addBilibiliMovie(
  ctx: SubmitMovieContext & { resolvedMovie: ResolvedSource }
) {
  const { resolvedMovie } = ctx
  const title = resolvedMovie.title || ctx.url.trim()
  // 存展开后的完整地址：短链（b23.tv 等）由后端解析时 302 展开，
  // 下游 BV 号提取 / 分 P 解析 / 弹幕匹配不再依赖短链可达性
  const movieUrl = resolvedMovie.resolvedUrl || ctx.url.trim()
  const added = await ctx.addMovie(ctx.roomId, {
    url: movieUrl,
    title,
    source: 'bilibili',
    audioUrl: resolvedMovie.audioUrl,
    format: resolvedMovie.format,
    videoCodec: resolvedMovie.videoCodec,
    audioCodec: resolvedMovie.audioCodec,
    duration: resolvedMovie.duration,
    cid: resolvedMovie.cid,
    currentQn: resolvedMovie.currentQn,
    acceptQuality: resolvedMovie.acceptQuality,
    pages: resolvedMovie.pages,
    currentPage: resolvedMovie.currentPage ?? 1,
  })
  // 对齐预览与正式播放的解析语义，消除引擎翻转：
  // 添加时的解析（CLI 连接=CLI DASH，未连接=服务器默认 DASH）
  // 与播放时的重新解析若偏好不一致，引擎会在 videojs10-dash 与
  // videojs10 间翻转。此处按实际解析路径持久化偏好：
  // - CLI 路径：启用 CLI 锁定 DASH（与一起看 cliPrevPreferMp4 同语义）
  // - 服务器路径：按管理员基础设置的默认解析参数物化
  //   （普通视频走「默认解析模式」，番剧/影视走「番剧/影视默认模式」）
  // 均可在影片的解析设置中手动更改。
  if (added) {
    const sysSettings = useSystemSettingsStore.getState()
    const pgc = isBilibiliPgcMovie(added)
    // 番剧/影视默认模式为「仅 CLI」时物化 Movie.cliOnly：
    // 全体成员必须连接本机 ZViewer CLI 观看，服务器仅做同步信令
    const pgcCliOnly = pgc && sysSettings.bilibiliPgcDefaultMode === 'cliOnly'
    if (pgcCliOnly && added.cliOnly !== true) {
      void useRoomStore
        .getState()
        .updateMovie(ctx.roomId, added.id, { cliOnly: true })
    }
    if (pgcCliOnly || ctx.resolvedViaCli) {
      setBilibiliParseOptions(added.id, {
        cliEnabled: true,
        preferMp4: false,
      })
    } else {
      const defaultMode = pgc
        ? sysSettings.bilibiliPgcDefaultMode
        : sysSettings.bilibiliDefaultParseMode
      setBilibiliParseOptions(added.id, {
        preferMp4: defaultMode !== 'dash',
      })
    }
  }
  ctx.resetForm()
  message.success(t('影片已添加'))
}

export async function addMp4Movie(ctx: SubmitMovieContext) {
  if (!ctx.url.trim()) {
    message.warning(t('请输入视频地址'))
    return
  }
  const movieUrl = ctx.url.trim()
  const title = extractTitleFromUrl(movieUrl)
  // 自动检测媒体格式：m3u8 -> hls，mp4/mkv/webm -> 对应格式
  // 后端存储 format 字段，播放时据此选择 HLS/Direct 引擎
  const detectedFormat = detectMediaFormat(movieUrl)
  await ctx.addMovie(ctx.roomId, {
    url: movieUrl,
    title,
    source: 'mp4',
    format: detectedFormat !== 'unknown' ? detectedFormat : undefined,
    // 视频直链影片统一走直链模式：强制直链直连（noProxyFallback），
    // 直连失败不回退服务器代理，直接报错
    directLink: true,
  })
  ctx.resetForm()
  message.success(t('影片已添加'))
}

export async function addPathMountMovie(ctx: SubmitMovieContext) {
  // WebDAV 与 OpenList 共用同一套协议逻辑，仅 API 前缀与直链获取不同
  // 内网地址强制使用服务器转发（浏览器无法直连内网服务器）
  const isDirect =
    ctx.sourceType === 'webdav'
      ? ctx.isWebdavInternal
        ? false
        : ctx.webdavDirectLink
      : ctx.isOpenlistInternal
        ? false
        : ctx.openlistDirectLink
  const mountPath = (
    ctx.sourceType === 'webdav' ? ctx.webdav.path : ctx.openlist.path
  ).trim()
  const mountServerUrl =
    (ctx.sourceType === 'webdav'
      ? ctx.webdav.serverUrl
      : ctx.openlist.serverUrl
    ).trim() || undefined
  const label = ctx.sourceType === 'webdav' ? 'WebDAV' : 'OpenList'
  const resolveMount =
    ctx.sourceType === 'webdav' ? resolveWebDAV : resolveOpenList
  const fetchDirect =
    ctx.sourceType === 'webdav' ? fetchWebDAVDirectUrl : fetchOpenListDirectUrl

  if (!mountPath) {
    message.warning(t('请填写文件路径'))
    return
  }
  const mountId = Number(ctx.selectedMountId)
  if (!mountId) {
    message.warning(t('请选择已保存的 {{label}} 挂载', { label }))
    return
  }
  let title: string
  let movieUrl: string
  let format: MediaFormat = 'mp4'
  let duration: number | undefined

  if (isDirect) {
    // 直链模式：后端通过挂载凭证获取直链 URL（OpenList 为 AList 签名直链，WebDAV 为拼接）
    ctx.setResolveProgress(t('正在获取 {{label}} 直链...', { label }))
    movieUrl = await fetchDirect(mountId, mountPath)
    title = extractTitleFromUrl(mountPath)
  } else {
    // 代理模式：resolve 返回相对 proxy URL，后端随后用 movieId 重写为 stream URL
    ctx.setResolveProgress(t('正在解析 {{label}} 文件...', { label }))
    const resolved = await resolveMount(mountId, mountPath)
    title = resolved.title || extractTitleFromUrl(mountPath)
    movieUrl = resolved.videoUrl
    format = resolved.format
    duration = resolved.duration
  }
  await ctx.addMovie(ctx.roomId, {
    url: movieUrl,
    title,
    source: ctx.sourceType,
    format,
    duration,
    serverUrl: mountServerUrl,
    path: mountPath,
    directLink: isDirect,
  })
  ctx.resetForm()
  message.success(t('影片已添加'))
}

export async function addFtpMovie(ctx: SubmitMovieContext) {
  if (!ctx.ftp.serverUrl.trim() || !ctx.ftp.path.trim()) {
    message.warning(t('请填写服务器地址与路径'))
    return
  }
  ctx.setResolveProgress(t('正在解析 FTP 文件...'))
  // 优先使用已保存挂载的新 API；手动填写时回退到旧 API
  const mountId = Number(ctx.selectedMountId)
  let title: string
  let movieUrl: string
  let format: MediaFormat

  if (mountId) {
    const resolved = await resolveFTPNew(mountId, ctx.ftp.path.trim())
    title = resolved.title || extractTitleFromUrl(ctx.ftp.path.trim())
    movieUrl = resolved.videoUrl
    format = resolved.format
  } else {
    const resolved = await resolveFTP({
      serverUrl: ctx.ftp.serverUrl.trim(),
      path: ctx.ftp.path.trim(),
      port: ctx.ftp.port,
      username: ctx.ftp.username || undefined,
      password: ctx.ftp.password || undefined,
    })
    title = resolved.title || extractTitleFromUrl(ctx.ftp.path.trim())
    movieUrl = resolved.videoUrl
    format = resolved.format
  }
  await ctx.addMovie(ctx.roomId, {
    url: movieUrl,
    title,
    source: 'ftp',
    format,
    serverUrl: ctx.ftp.serverUrl.trim(),
    path: ctx.ftp.path.trim(),
    username: ctx.ftp.username || undefined,
    password: ctx.ftp.password || undefined,
  })
  ctx.resetForm()
  message.success(t('影片已添加'))
}

// Emby 与 Jellyfin 同构：仅服务名标签、resolve API 与直链开关不同
export async function addMediaServerMovie(
  ctx: SubmitMovieContext,
  label: 'Emby' | 'Jellyfin'
) {
  const resolveMount = label === 'Emby' ? resolveEmby : resolveJellyfin
  const directLink =
    label === 'Emby' ? ctx.embyDirectLink : ctx.jellyfinDirectLink
  const source = label === 'Emby' ? 'emby' : 'jellyfin'
  const mountId = Number(ctx.selectedMountId)
  if (!mountId) {
    message.warning(t('请选择已保存的 {{label}} 挂载', { label }))
    return
  }
  // Emby/Jellyfin 是媒体库型，需通过浏览选择条目（itemId）
  // 手动输入场景仅支持已复制的 itemId 直加
  const itemId = ctx.url.trim()
  if (!itemId) {
    message.warning(
      t('请通过「浏览 {{label}} 媒体库」选择条目，或粘贴 itemId', { label })
    )
    return
  }
  ctx.setResolveProgress(t('正在解析 {{label}} 条目...', { label }))
  const resolved = await resolveMount(mountId, itemId)
  const mount = ctx.mounts.find((m) => m.id === mountId)
  await ctx.addMovie(ctx.roomId, {
    url:
      directLink && resolved.directUrl ? resolved.directUrl : resolved.videoUrl,
    title: resolved.title || extractTitleFromUrl(itemId),
    source,
    format: resolved.format,
    duration: resolved.duration,
    serverUrl: mount?.serverUrl,
    path: itemId,
    directLink,
  })
  ctx.resetForm()
  message.success(t('影片已添加'))
}

export async function addServerFilesMovie(ctx: SubmitMovieContext) {
  if (!ctx.serverFilePath.trim()) {
    message.warning(t('请选择服务器文件'))
    return
  }
  ctx.setResolveProgress(t('正在解析服务器文件...'))
  const resolved = await resolveServerFile(ctx.serverFilePath.trim())
  const movieUrl = buildServerFileProxyUrl(ctx.serverFilePath.trim())
  // 音轨编码来自后端 resolve（ffprobe），仅作元数据存储：playsvideo
  // 的启用由播放时的 shouldUsePlaysVideo 依据容器与音轨自行判定，
  // 添加影片时不再需要前端补探测。
  await ctx.addMovie(ctx.roomId, {
    url: movieUrl,
    title: resolved.title,
    source: 'server-files',
    format: resolved.format as MediaFormat,
    path: ctx.serverFilePath.trim(),
    duration: resolved.duration ?? undefined,
    audioCodec: resolved.audioCodec ?? undefined,
  })
  ctx.resetForm()
  message.success(t('影片已添加'))
}
