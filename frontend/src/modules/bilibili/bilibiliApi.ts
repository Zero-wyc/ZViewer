import { apiFetch } from '@/lib/api'
import type {
  BilibiliQrData,
  BilibiliUserInfo,
  QualityOption,
  ResolveProgressLine,
  ResolvedSource,
} from './types'

/** VIP 专属清晰度 qn 列表（非会员不可用） */
export const VIP_ONLY_QNS = [112, 116, 120, 125, 126, 127]

/** 一起听「哔哩哔哩」页的视频条目（分区/收藏通用） */
export interface BilibiliVideoItem {
  bvid: string
  title: string
  pic: string
  /** 时长（秒） */
  duration: number
  upName: string
  /** 第一 P 的 cid（收藏列表无 cid，点击时经 view 接口补取） */
  cid?: number
  /** 播放量 */
  view?: number
  /** 弹幕数 */
  danmaku?: number
  /** 发布时间（分区）/ 收藏时间（收藏夹），秒级时间戳 */
  date?: number
  /** 空格分隔的视频标签（搜索接口返回；屏蔽词过滤用） */
  tag?: string
}

/**
 * 音乐分区最新视频（后端透传 x/web-interface/dynamic/region，rid=3 音乐）。
 */
export async function getBilibiliRegionNew(
  rid = 3,
  ps = 20,
  pn = 1
): Promise<{ items: BilibiliVideoItem[]; total: number | null }> {
  const res = await apiFetch(
    `/api/stream/bilibili/region-new?rid=${rid}&ps=${ps}&pn=${pn}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    items?: BilibiliVideoItem[]
    total?: number
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取分区视频失败')
  }
  return { items: data.items ?? [], total: data.total ?? null }
}

/**
 * 登录用户的收藏视频列表（后端取指定收藏夹或默认收藏夹 → resource/list）。
 * 未登录 B站 时后端返回 401。
 */
export async function getBilibiliFavVideos(
  ps = 20,
  mediaId?: number,
  pn = 1
): Promise<{
  folderTitle: string
  items: BilibiliVideoItem[]
  total: number | null
}> {
  const res = await apiFetch(
    `/api/stream/bilibili/fav-videos?ps=${ps}&pn=${pn}${
      mediaId ? `&mediaId=${mediaId}` : ''
    }`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    folderTitle?: string
    items?: BilibiliVideoItem[]
    total?: number
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取收藏视频失败')
  }
  return {
    folderTitle: data.folderTitle ?? '',
    items: data.items ?? [],
    total: data.total ?? null,
  }
}

/** 收藏夹条目（created/list-all；该接口无封面，cover 一般为空） */
export interface BilibiliFavFolder {
  id: number
  title: string
  mediaCount: number
  cover: string
}

/**
 * 登录用户的收藏夹列表（我的收藏右列切换用）。
 * 未登录 B站 时后端返回 401。
 */
export async function getBilibiliFavFolders(): Promise<BilibiliFavFolder[]> {
  const res = await apiFetch('/api/stream/bilibili/fav-folders')
  const data = (await res.json()) as {
    success: boolean
    message?: string
    folders?: BilibiliFavFolder[]
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取收藏夹列表失败')
  }
  return data.folders ?? []
}

/**
 * B站 视频搜索（哔哩哔哩页顶栏搜索框）：后端复用弹幕搜索同款 searchVideos
 * 服务。返回与 BilibiliVideoItem 兼容的条目（无 cid，点击时前端经 view 补取）。
 */
/** 音乐种类数据源模式：关键词搜索 / B站标签检索 / 两者混合 */
export type BiliRegionSource = 'search' | 'tag' | 'mixed'

export async function searchBilibiliVideos(
  keyword: string,
  pn = 1,
  mode: BiliRegionSource = 'search'
): Promise<{ items: BilibiliVideoItem[]; total: number | null }> {
  const res = await apiFetch(
    `/api/stream/bilibili/search?keyword=${encodeURIComponent(
      keyword
    )}&pn=${pn}&mode=${mode}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    items?: BilibiliVideoItem[]
    total?: number
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '搜索失败')
  }
  return { items: data.items ?? [], total: data.total ?? null }
}

/**
 * B站 相关推荐视频（自动连播用）：后端 view 拿 aid → archive/related
 * 公开接口。返回与 BilibiliVideoItem 兼容的条目（含 cid，可直接插播）。
 */
export async function getBilibiliRelated(
  bvid: string
): Promise<BilibiliVideoItem[]> {
  const res = await apiFetch(
    `/api/stream/bilibili/related?bvid=${encodeURIComponent(bvid)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    items?: BilibiliVideoItem[]
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取相关推荐失败')
  }
  return data.items ?? []
}

/** B站 AI 字幕行（from/to 秒） */
export interface BilibiliAiSubtitleLine {
  from: number
  to: number
  content: string
}

/**
 * 视频 AI 字幕（后端 WBI 签名 conclusion/get + 字幕 JSON 拉取）。
 * 无字幕/未登录时返回空数组。
 */
export async function getBilibiliAiSubtitle(
  bvid: string,
  cid: number
): Promise<BilibiliAiSubtitleLine[]> {
  const res = await apiFetch(
    `/api/stream/bilibili/ai-subtitle?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    lines?: BilibiliAiSubtitleLine[]
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取 AI 字幕失败')
  }
  return data.lines ?? []
}

/**
 * 根据会员状态过滤清晰度列表。
 * 非会员严格过滤 VIP 专属清晰度，过滤后为空时回退到 1080P。
 */
export function filterQualitiesByVip(
  list: QualityOption[] | undefined,
  isVip: boolean
): QualityOption[] {
  const original = list ?? []
  if (isVip) return original
  const filtered = original.filter((q) => !VIP_ONLY_QNS.includes(q.id))
  if (filtered.length === 0) {
    return [{ id: 80, label: '1080P', resolution: '1920x1080' }]
  }
  return filtered
}

/**
 * 将 B站 返回的图片地址统一补全为 HTTPS 完整 URL。
 * 兼容协议相对地址（//...）和缺少协议的相对地址。
 */
function normalizeBilibiliImageUrl(url: string): string {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (!/^https?:\/\//i.test(url)) return `https://${url}`
  return url
}

export async function getBilibiliQrCode(): Promise<BilibiliQrData> {
  const res = await apiFetch('/api/stream/bilibili/qr')
  const data = (await res.json()) as {
    success: boolean
    message?: string
    qrcodeKey?: string
    qrUrl?: string
    qrDataUrl?: string
  }
  if (!res.ok || !data.success || !data.qrcodeKey || !data.qrDataUrl) {
    throw new Error(data.message || '获取二维码失败')
  }
  return {
    qrcodeKey: data.qrcodeKey,
    qrUrl: data.qrUrl || '',
    qrDataUrl: data.qrDataUrl,
  }
}

export async function pollBilibiliQrCode(
  qrcodeKey: string
): Promise<{ status: number; message: string; loggedIn: boolean }> {
  const res = await apiFetch(
    `/api/stream/bilibili/qr/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    status?: number
    loggedIn?: boolean
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '轮询二维码状态失败')
  }
  return {
    status: data.status ?? -1,
    message: data.message || '',
    loggedIn: !!data.loggedIn,
  }
}

export async function getBilibiliLoginStatus(): Promise<boolean> {
  try {
    const res = await apiFetch('/api/stream/bilibili/login-status')
    const data = (await res.json()) as { success: boolean; loggedIn?: boolean }
    return !!data.loggedIn
  } catch {
    return false
  }
}

export async function logoutBilibili(): Promise<void> {
  await apiFetch('/api/stream/bilibili/logout', {
    method: 'POST',
  })
}

/**
 * 获取当前绑定的 B站 Cookie（用户自己的凭据，供「复制 Cookie」使用）。
 * 未登录时返回空字符串。
 */
export async function getBilibiliCookie(): Promise<string> {
  try {
    const res = await apiFetch('/api/stream/bilibili/cookie')
    const data = (await res.json()) as { success: boolean; cookie?: string }
    return data.success && data.cookie ? data.cookie : ''
  } catch {
    return ''
  }
}

/**
 * 使用 Cookie 字符串登录 B站。
 *
 * 用户手动粘贴从浏览器复制的 B站 Cookie，
 * 后端验证有效性后保存凭证。
 */
export async function loginBilibiliWithCookie(
  cookie: string
): Promise<{ name: string; avatar: string }> {
  const res = await apiFetch('/api/stream/bilibili/cookie-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  })
  // 防止非 JSON 响应（如 404 HTML 页面）导致 JSON 解析报错
  const contentType = res.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      `服务器返回了非 JSON 响应 (${res.status})，请确认后端服务已正常运行`
    )
  }
  const data = (await res.json()) as {
    success: boolean
    message?: string
    name?: string
    avatar?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || 'Cookie 登录失败')
  }
  return {
    name: data.name || '',
    avatar: data.avatar || '',
  }
}

export async function getBilibiliUserInfo(): Promise<BilibiliUserInfo | null> {
  try {
    const res = await apiFetch('/api/stream/bilibili/user-info')
    const data = (await res.json()) as {
      success: boolean
      name?: string
      face?: string
      avatar?: string
      vipStatus?: 0 | 1
      message?: string
    }
    if (!res.ok || !data.success || !data.name) {
      return null
    }
    return {
      name: data.name,
      avatar: normalizeBilibiliImageUrl(data.face || data.avatar || ''),
      vipStatus: data.vipStatus,
    }
  } catch {
    return null
  }
}

/** 「添加视频」弹窗搜索结果（x/web-interface/view 精简透传） */
export interface BilibiliVideoViewInfo {
  bvid: string
  title: string
  pic: string
  duration: number
  upName: string
  cid: number
  pages: { page: number; part: string; cid: number }[]
}

/**
 * 按 BV 号查询视频信息（添加视频弹窗「搜索」）。
 * 匿名可查；已登录 B站 时带用户 Cookie（部分视频需登录可见）。
 */
export async function getBilibiliVideoView(
  bvid: string
): Promise<BilibiliVideoViewInfo> {
  const res = await apiFetch(
    `/api/stream/bilibili/view?bvid=${encodeURIComponent(bvid)}`
  )
  const data = (await res.json()) as BilibiliVideoViewInfo & {
    success: boolean
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取视频信息失败')
  }
  return {
    bvid: data.bvid,
    title: data.title,
    pic: data.pic,
    duration: data.duration,
    upName: data.upName,
    cid: data.cid,
    pages: data.pages ?? [],
  }
}

function mapResolvedBilibili(data: ResolveProgressLine): ResolvedSource {
  return {
    title: data.title,
    videoUrl: data.videoUrl ?? '',
    audioUrl: data.audioUrl,
    videoCodec: data.videoCodec,
    audioCodec: data.audioCodec,
    duration: data.duration,
    format: data.format || 'mp4',
    loggedIn: data.loggedIn,
    cid: data.cid,
    currentQn: data.currentQn,
    acceptQuality: data.acceptQuality,
    vipStatus: data.vipStatus,
    pages: data.pages,
    currentPage: data.currentPage,
    resolvedUrl: data.resolvedUrl,
  }
}

async function parseNdjsonStream(
  res: Response,
  onProgress?: (step: string, message: string) => void
): Promise<ResolvedSource> {
  // 先完整读取 NDJSON 文本再逐行解析：
  // 部分浏览器/嵌入环境在 UI 点击触发的流式读取中会记录 net::ERR_ABORTED，
  // 一次性读取文本可避免该问题，同时仍能按顺序回调进度信息。
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    console.warn('[resolveBilibili] 读取响应体失败:', err)
    throw new Error('解析响应失败', { cause: err })
  }

  let resolved: ResolvedSource | null = null
  let streamError: Error | null = null

  const lines = text.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const data = JSON.parse(line) as ResolveProgressLine
      if (data.status === 'parsing' && data.step && data.message) {
        onProgress?.(data.step, data.message)
      } else if (data.status === 'done' && data.videoUrl) {
        resolved = mapResolvedBilibili(data)
      } else if (data.status === 'error') {
        if (data.code === 'NO_PERMISSION') {
          streamError = new Error(data.message || '无权限播放，可能需要大会员')
        } else {
          streamError = new Error(data.message || '解析 B站 视频失败')
        }
      }
    } catch (err) {
      console.warn('[resolveBilibili] 解析进度行失败:', line, err)
    }
  }

  if (streamError) {
    throw streamError
  }

  if (resolved) {
    return resolved
  }

  throw new Error('解析 B站 视频未完成')
}

/**
 * 解析总超时（毫秒）。
 *
 * 后端流程包含 VIP 校验、视频信息、playurl、CDN 健康检查（4s 兜底）以及
 * DASH 不可达时的 MP4 降级重解析。正常情况下 10s 内完成；当 B站 API
 * 或 CDN 不响应时，后端 bilibiliFetch 已有单请求超时，这里作为整体兜底，
 * 防止 NDJSON 流式响应永不结束导致前端 await res.text() 永久挂起。
 */
const RESOLVE_TIMEOUT_MS = 30000

export async function resolveBilibili(
  url: string,
  qn?: number,
  onProgress?: (step: string, message: string) => void,
  options?: { preferMp4?: boolean; forceDash?: boolean; page?: number }
): Promise<ResolvedSource> {
  let fetchUrl = `/api/stream/resolve-bilibili?url=${encodeURIComponent(url)}`
  if (qn != null && Number.isFinite(qn)) {
    fetchUrl += `&qn=${qn}`
  }
  if (options?.preferMp4) {
    fetchUrl += `&preferMp4=true`
  }
  if (options?.forceDash) {
    fetchUrl += `&forceDash=true`
  }
  if (
    options?.page != null &&
    Number.isFinite(options.page) &&
    options.page > 0
  ) {
    fetchUrl += `&page=${options.page}`
  }

  // 整体超时兜底：后端流式响应永不结束时主动 abort，避免前端永久挂起。
  // 控制器在 parseNdjsonStream / res.json() 完成后由 finally 清理。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS)
  try {
    const res = await apiFetch(fetchUrl, { signal: controller.signal })
    const contentType = res.headers.get('content-type') || ''

    if (contentType.includes('application/x-ndjson')) {
      return await parseNdjsonStream(res, onProgress)
    }

    // 兜底：兼容旧版纯 JSON 响应
    const data = (await res.json()) as ResolveProgressLine
    if (!res.ok || !data.success || !data.videoUrl) {
      if (data.code === 'NO_PERMISSION') {
        throw new Error(data.message || '无权限播放，可能需要登录或大会员')
      }
      throw new Error(data.message || '解析 B站 视频失败')
    }
    return mapResolvedBilibili(data)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('解析 B站 视频超时，请稍后重试', { cause: err })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 使用用户本地持久化的 B站 解析偏好解析 B站 视频。
 * 该函数将偏好读取与 `resolveBilibili` 调用合并，避免调用方重复注入参数。
 *
 * 编码格式由后端自动适配，无需前端传入。
 * preferMp4 等播放模式偏好由调用方从 parseOptions 读取后显式传入。
 */
export async function resolveBilibiliWithOptions(
  url: string,
  qn?: number,
  onProgress?: (step: string, message: string) => void,
  extraOptions?: { preferMp4?: boolean; forceDash?: boolean; page?: number }
): Promise<ResolvedSource> {
  return resolveBilibili(url, qn, onProgress, {
    preferMp4: extraOptions?.preferMp4,
    forceDash: extraOptions?.forceDash,
    page: extraOptions?.page,
  })
}

/** 自定义栏目数据源类型：合集（season）/ 系列（series）/ 收藏夹（favlist） */
export type BiliCustomKind = 'season' | 'series' | 'favlist'

/** 栏目链接解析结果（后端 /bilibili/link-meta） */
export interface BiliLinkMeta {
  kind: BiliCustomKind
  /** UP 主 mid（收藏夹链接可能无） */
  mid: number | null
  /** 列表 id：合集/系列为 sid，收藏夹为 fid */
  listId: number
  /** B站 侧标题（前端预填栏目名） */
  title: string
  total: number | null
}

/**
 * 解析 B站 栏目链接（视频合集 / 系列 / 收藏夹；b23.tv 短链自动展开）。
 * 返回类型、mid、列表 id 与 B站 侧标题；链接无法识别或私密时抛错。
 */
export async function fetchBiliLinkMeta(url: string): Promise<BiliLinkMeta> {
  const res = await apiFetch(
    `/api/stream/bilibili/link-meta?url=${encodeURIComponent(url)}`
  )
  const data = (await res.json()) as BiliLinkMeta & {
    success: boolean
    message?: string
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '解析链接失败')
  }
  return {
    kind: data.kind,
    mid: data.mid,
    listId: data.listId,
    title: data.title,
    total: data.total,
  }
}

/** 合集 / 系列视频分页（自定义栏目浏览） */
export async function fetchBiliCollectionVideos(
  mid: number,
  sid: number,
  kind: 'season' | 'series',
  pn = 1,
  ps = 20
): Promise<{ items: BilibiliVideoItem[]; total: number | null }> {
  const res = await apiFetch(
    `/api/stream/bilibili/collection-videos?mid=${mid}&sid=${sid}&kind=${kind}&pn=${pn}&ps=${ps}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    items?: BilibiliVideoItem[]
    total?: number | null
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取合集视频失败')
  }
  return { items: data.items ?? [], total: data.total ?? null }
}

/** 任意公开收藏夹视频分页（media_id = 收藏夹 fid） */
export async function fetchBiliFavListVideos(
  fid: number,
  pn = 1,
  ps = 20
): Promise<{ items: BilibiliVideoItem[]; total: number | null }> {
  const res = await apiFetch(
    `/api/stream/bilibili/fav-list-videos?fid=${fid}&pn=${pn}&ps=${ps}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    items?: BilibiliVideoItem[]
    total?: number | null
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取收藏夹视频失败')
  }
  return { items: data.items ?? [], total: data.total ?? null }
}

// ==================== 视频评论区（哔哩哔哩歌词播放页） ====================

/** B站 评论条目（主楼 / 楼中楼通用归一化结构） */
export interface BiliCommentItem {
  rpid: number
  mid: number
  name: string
  /** 头像 URL（hdslb 直链，展示须走 /api/stream/proxy-image） */
  avatar: string
  content: string
  /** 发布时间（秒级 Unix） */
  time: number
  like: number
  replyCount: number
  /** 表情映射：键为 [名称] 原文，值为表情图 URL */
  emote: Record<string, string>
  /** IP 属地（可能为空） */
  location: string
}

export interface BiliCommentsPage {
  /** 评论总数（含楼中楼口径） */
  total: number
  replies: BiliCommentItem[]
  /** 下一页游标（null = 没有更多；主楼游标分页用） */
  next: number | null
  /** 未登录游客模式：B站 仅开放前 3 条主楼 */
  loginLimited: boolean
}

/** 主楼评论分页（mode: 2=按时间游标分页 / 3=按热度，游标 next 传 0 表示首页） */
export async function fetchBiliComments(
  bvid: string,
  mode: '2' | '3',
  next = 0
): Promise<BiliCommentsPage> {
  const res = await apiFetch(
    `/api/stream/bilibili/comments?bvid=${bvid}&mode=${mode}&next=${next}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    total?: number
    replies?: BiliCommentItem[]
    next?: number | null
    loginLimited?: boolean
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取评论失败')
  }
  return {
    total: data.total ?? 0,
    replies: data.replies ?? [],
    next: data.next ?? null,
    loginLimited: !!data.loginLimited,
  }
}

/** 楼中楼回复分页（pn 传统分页） */
export async function fetchBiliCommentReplies(
  bvid: string,
  rpid: number,
  pn = 1,
  ps = 10
): Promise<{ total: number; replies: BiliCommentItem[] }> {
  const res = await apiFetch(
    `/api/stream/bilibili/comment-replies?bvid=${bvid}&rpid=${rpid}&pn=${pn}&ps=${ps}`
  )
  const data = (await res.json()) as {
    success: boolean
    message?: string
    total?: number
    replies?: BiliCommentItem[]
  }
  if (!res.ok || !data.success) {
    throw new Error(data.message || '获取回复失败')
  }
  return { total: data.total ?? 0, replies: data.replies ?? [] }
}
