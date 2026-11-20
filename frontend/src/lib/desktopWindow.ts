/**
 * 桌面端「独立评论窗口」的前端接入。
 *
 * 背景：浏览器里只能开内嵌浮层或 window.open 弹窗，都受浏览器窗口管理限制
 * （无法真正置顶、无法脱离标签页）。ZViewer Desktop 桌面端能开一个真正的
 * 独立窗口，但只有「浏览器与桌面端在同一台机器」时才有意义，所以能力由后端
 * 判定（见 backend-go/internal/api/desktopwindow.go），前端只做
 * 「能用就走桌面窗口，不能用就退回原浮层」。
 *
 * 另一个职责是窗口内的登录态自举：桌面窗口是独立 WebView2 进程（独立 profile），
 * 拿不到主窗口的 httpOnly cookie，后端会把一组票据放进 URL，页面在首帧之前
 * 写进本地存储，后续请求走 Bearer（HTTP 通道）。
 */

import { apiFetch, apiGet } from '@/lib/api'
import { saveAuthTokens } from '@/lib/authTransport'

export interface DesktopCapabilities {
  available: boolean
  sameMachine: boolean
  reason?: string
}

const UNAVAILABLE: DesktopCapabilities = {
  available: false,
  sameMachine: false,
}

let capabilitiesCache: Promise<DesktopCapabilities> | null = null

/** 查询当前页面能否唤起桌面端窗口（结果缓存，失败也缓存，避免每次点都请求）。 */
export function getDesktopCapabilities(
  force = false
): Promise<DesktopCapabilities> {
  if (!force && capabilitiesCache) return capabilitiesCache
  capabilitiesCache = (async () => {
    try {
      const { data, ok } = await apiGet<{
        available?: boolean
        sameMachine?: boolean
        reason?: string
      }>('/api/desktop/capabilities')
      if (!ok || !data) return UNAVAILABLE
      return {
        available: data.available === true,
        sameMachine: data.sameMachine === true,
        reason: data.reason,
      }
    } catch {
      return UNAVAILABLE
    }
  })()
  return capabilitiesCache
}

/** 让桌面端打开独立评论窗口；成功返回 true，调用方据此决定是否回退浮层。 */
export async function openDesktopCommentsWindow(
  roomId: string
): Promise<boolean> {
  if (!roomId) return false
  try {
    const caps = await getDesktopCapabilities()
    if (!caps.available) return false
    const res = await apiFetch('/api/desktop/comments-window', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * 评论窗口页面首帧之前执行：把 URL 里的票据写进本地存储并清理地址栏。
 *
 * 只在 desktopWindow=1 时生效；普通页面（含浏览器 window.open 打开的同款
 * 页面）完全不受影响。
 */
export function bootstrapDesktopWindowAuth(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('desktopWindow') !== '1') return false
  const token = params.get('desktopToken') ?? ''
  const refresh = params.get('desktopRefresh') ?? ''
  if (!token) return false
  saveAuthTokens(token, refresh || undefined)

  // 票据已经落到本地存储，URL 里没必要再留着（避免被复制外传）。
  params.delete('desktopToken')
  params.delete('desktopRefresh')
  const query = params.toString()
  const next = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`
  try {
    window.history.replaceState(null, '', next)
  } catch {
    // history 不可用时忽略：票据仍在内存里，请求照常可用
  }
  return true
}
