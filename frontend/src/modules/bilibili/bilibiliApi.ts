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
