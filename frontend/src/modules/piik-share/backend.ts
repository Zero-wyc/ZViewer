/**
 * 共享链路的开关。
 *
 * 两条链路并存一段时间：旧的 socket.io + 自建拓扑（`sfu`）还在兜底，
 * 新的 `/signal` + Piik 控制器（`piik`）逐步接管。默认走旧的，
 * 用 `?shareBackend=piik` 或 localStorage 切过去，出问题时改回来即可。
 */
export type ShareBackend = 'sfu' | 'piik'

const STORAGE_KEY = 'zviewer-share-backend'

/**
 * 启动时调用：把 URL 上的开关落到 localStorage。
 *
 * `/share/<id>` 会被重定向到 `/room/<id>`，重定向之后 query 就没了；
 * 必须在路由之前抓一次，否则开关形同虚设。
 */
export function captureShareBackendFromQuery(): void {
  try {
    const value = new URLSearchParams(location.search).get('shareBackend')
    if (value === 'piik' || value === 'sfu') {
      localStorage.setItem(STORAGE_KEY, value)
    }
  } catch {
    // 隐私模式：开关不生效，默认旧链路。
  }
}

export function shareBackend(): ShareBackend {
  try {
    const params = new URLSearchParams(location.search)
    const fromQuery = params.get('shareBackend')
    if (fromQuery === 'piik' || fromQuery === 'sfu') return fromQuery
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'piik' ? 'piik' : 'sfu'
  } catch {
    // 隐私模式下 localStorage 会抛，默认旧链路总不会错。
    return 'sfu'
  }
}
