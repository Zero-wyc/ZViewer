/**
 * 共享链路的开关。
 *
 * 默认走 Piik（`/signal` + Piik 控制器），旧的 socket.io + 自建拓扑留作逃生舱：
 * `?shareBackend=sfu` 或 localStorage 写 `zviewer-share-backend=sfu` 就切回去。
 *
 * 为什么还要留旧的：Piik 桥接层是进程内起的，起不来（端口被占、组件缺失）时
 * `/signal` 只回 503。默认切过去之后，这种服务端问题会变成「所有人都不能共享」，
 * 所以页面在开播前探一次能力（`useShareBackend` 里的 `probe`），探不到就自动
 * 退回旧链路；用户显式指定过就尊重用户的选择，不再覆盖。
 *
 * 这个文件保持零依赖（不碰 fetch / React）：它是纯解析，单测直接在 node 里跑。
 */
export type ShareBackend = 'sfu' | 'piik'

const STORAGE_KEY = 'zviewer-share-backend'

/** 没配过的机器走这条。 */
const DEFAULT_BACKEND: ShareBackend = 'piik'

function normalize(value: string | null): ShareBackend | null {
  if (value === 'piik') return 'piik'
  if (value === 'sfu') return 'sfu'
  return null
}

/**
 * 启动时调用：把 URL 上的开关落到 localStorage。
 *
 * `/share/<id>` 会被重定向到 `/room/<id>`，重定向之后 query 就没了；
 * 必须在路由之前抓一次，否则开关形同虚设。落盘之后
 * `shareBackendChoice()` 还能把「用户显式选的」和「默认值」区分开。
 */
export function captureShareBackendFromQuery(): void {
  try {
    const value = normalize(
      new URLSearchParams(location.search).get('shareBackend')
    )
    if (value) localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // 隐私模式：开关不生效，用默认链路。
  }
}

export interface ShareBackendChoice {
  backend: ShareBackend
  /** 用户自己选的（query / localStorage），能力探测不该覆盖它。 */
  explicit: boolean
}

/**
 * 读当前该走哪条链路。
 *
 * query 与 storage 都算「显式」：前者是本次要切换，后者是上回切过去留下的，
 * 两种情况下覆盖成旧链路都会让用户觉得开关没生效。
 */
export function shareBackendChoice(): ShareBackendChoice {
  try {
    const fromQuery = normalize(
      new URLSearchParams(location.search).get('shareBackend')
    )
    if (fromQuery) return { backend: fromQuery, explicit: true }
    const stored = normalize(localStorage.getItem(STORAGE_KEY))
    if (stored) return { backend: stored, explicit: true }
  } catch {
    // 隐私模式下 URL / localStorage 都可能抛，落到默认值。
  }
  return { backend: DEFAULT_BACKEND, explicit: false }
}

export function shareBackend(): ShareBackend {
  return shareBackendChoice().backend
}
