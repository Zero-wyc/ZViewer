/**
 * 页面级 HTTP 流量计数器（fetch + XHR 全局打点，单例安装）
 *
 * 统计口径：
 * - 下载：优先响应 content-length；缺失（分块传输等）时用
 *   PerformanceObserver 的 ResourceTiming 补记（同源/带 TAO 头时可取到）
 * - 上传：请求体的可测量大小（字符串/ArrayBuffer/Blob/URLSearchParams）；
 *   XHR 额外用 upload.progress 累加（覆盖 FormData 等）
 * - WebSocket（socket.io 控制消息、弹幕）不计入
 *
 * installTrafficCounter() 幂等，在房间页流量面板首次挂载时调用。
 * 计数从安装时刻起算，即「本次会话」的流量。
 */

export interface LocalTraffic {
  downTotal: number
  upTotal: number
}

const counters: LocalTraffic = { downTotal: 0, upTotal: 0 }

let installed = false

/** 无 content-length 的在途响应：url → 发起时刻列表（ResourceTiming 匹配用） */
const pendingNoLength = new Map<string, number[]>()

export function installTrafficCounter(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  patchFetch()
  patchXHR()

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceResourceTiming
        const starts = pendingNoLength.get(e.name)
        if (!starts || starts.length === 0) continue
        const start = starts[0]!
        // 资源条目的发起时间必须晚于我们的请求发起（留 50ms 时钟容差）
        if (e.startTime < start - 50) continue
        starts.shift()
        if (starts.length === 0) pendingNoLength.delete(e.name)
        const size = e.transferSize || e.encodedBodySize || e.decodedBodySize || 0
        if (size > 0) counters.downTotal += size
      }
    })
    observer.observe({ type: 'resource', buffered: false })
  } catch {
    // 浏览器不支持 ResourceTiming 则跳过兜底
  }
}

export function getLocalTraffic(): LocalTraffic {
  return { ...counters }
}

function estimateBodySize(body: unknown): number {
  if (body == null) return 0
  try {
    if (typeof body === 'string') {
      return new TextEncoder().encode(body).length
    }
    if (body instanceof URLSearchParams) {
      return new TextEncoder().encode(body.toString()).length
    }
    if (body instanceof Blob) return body.size
    if (body instanceof ArrayBuffer) return body.byteLength
    if (ArrayBuffer.isView(body)) return body.byteLength
  } catch {
    // 计量失败不影响请求本身
  }
  return 0
}

function noteResponse(url: string, res: Response): void {
  try {
    const cl = Number(res.headers.get('content-length') || 0)
    if (Number.isFinite(cl) && cl > 0) {
      counters.downTotal += cl
    } else {
      const arr = pendingNoLength.get(url) ?? []
      arr.push(performance.now())
      pendingNoLength.set(url, arr)
      // 防泄漏：同 URL 积压过多说明匹配不上，直接丢弃
      if (arr.length > 50) pendingNoLength.set(url, arr.slice(-50))
    }
  } catch {
    // 跨域无 TAO 头时读 headers 可能抛错，忽略
  }
}

function patchFetch(): void {
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const size = estimateBodySize(init?.body)
      if (size > 0) counters.upTotal += size
    } catch {
      // 忽略计量错误
    }
    const response = await originalFetch(input, init)
    try {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url) noteResponse(url, response)
    } catch {
      // 忽略计量错误
    }
    return response
  }
}

function patchXHR(): void {
  const proto = XMLHttpRequest.prototype as unknown as Record<
    string,
    unknown
  >
  const originalOpen = proto.open as (...args: unknown[]) => void
  const originalSend = proto.send as (body?: unknown) => void

  proto.open = function (...args: unknown[]) {
    ;(this as unknown as { __trafficMethod?: string }).__trafficMethod =
      typeof args[0] === 'string' ? args[0] : undefined
    return originalOpen.apply(this, args)
  }

  proto.send = function (body?: unknown) {
    const xhr = this as unknown as XMLHttpRequest
    try {
      const size = estimateBodySize(body)
      if (size > 0) counters.upTotal += size
      let last = 0
      const onProgress = (e: ProgressEvent) => {
        const delta = e.loaded - last
        last = e.loaded
        if (delta > 0) counters.downTotal += delta
      }
      xhr.addEventListener('progress', onProgress)
      xhr.addEventListener('load', onProgress)
    } catch {
      // 忽略计量错误
    }
    return originalSend.call(this, body)
  }
}
