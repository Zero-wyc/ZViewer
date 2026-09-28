/**
 * 直链加载链路共享模块(链接获取层)。
 *
 * 从 direct-engine.ts 纯搬迁抽离,供 direct 引擎与 videojs10 引擎共用——
 * 两个引擎共享同一「链接获取」语义(URL 决策 / 前置校验 / 降级与代理
 * 备选 / 时长探测),仅「执行层」不同:
 * - direct 引擎:video.src / video.load() 原生执行
 * - videojs10 引擎:v10 media API(media.src / media.load())执行
 *
 * 本模块只包含链接获取与元信息获取,不包含任何播放控制。
 */
import type { PlayerSource } from '../types'
import { resolveMediaRoute } from '../services/url-proxy'
import { formatVideoLoadError } from '../utils'

/** metadata 等待超时(毫秒):网络挂起时兜底,避免 attach 永久 pending */
export const METADATA_TIMEOUT_MS = 30_000

/** HEAD 时长探测超时(毫秒) */
const HEAD_TIMEOUT_MS = 5_000

/**
 * metadata 等待目标的最小结构类型:HTMLVideoElement 与 v10 的
 * HTMLVideoAdapter(事件转发到桥接的 video 元素)均满足。
 * 不依赖任何一方具体类型,两个引擎共享同一等待实现。
 */
export interface MetadataWaitTarget {
  readonly readyState: number
  readonly error: { code?: number; message?: string } | null
  addEventListener(
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions
  ): void
  removeEventListener(type: string, listener: EventListener): void
}

/**
 * 等待 metadata 就绪或 error 事件,带超时保护。
 *
 * 与 utils.waitForMetadata 不同,本函数额外处理两类异常路径:
 * - error 事件:加载失败时 reject 而非永久 pending(文案经
 *   formatVideoLoadError 映射,直链模式下直接展示给用户)
 * - 超时:网络挂起(无 error 也无 metadata)时 reject 兜底,
 *   让上层串行队列得以继续、代理回退链路得以执行
 */
export function waitForMetadataOrError(
  target: MetadataWaitTarget
): Promise<void> {
  if (target.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `加载超时：源站 ${Math.round(METADATA_TIMEOUT_MS / 1000)}s 无响应`
        )
      )
    }, METADATA_TIMEOUT_MS)
    const cleanup = () => {
      clearTimeout(timer)
      target.removeEventListener('loadedmetadata', onLoaded)
      target.removeEventListener('error', onError)
    }
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      // 抛出面向用户的可读文案：直链模式（noProxyFallback）不回退代理，
      // 该错误会经 message.error 直接展示给用户
      reject(new Error(formatVideoLoadError(target.error?.code)))
    }
    target.addEventListener('loadedmetadata', onLoaded, { once: true })
    target.addEventListener('error', onError, { once: true })
  })
}

/**
 * 补发 HEAD 请求探测 X-Content-Duration(转码流时长兜底)。
 *
 * 惰性探测:仅在加载完成后发现 duration 为 Infinity 时调用——
 * 普通源没有该 header,无条件探测属于浪费请求;对最终加载的 URL
 * (回退代理后为 proxyUrl)发请求,避免对直连 URL 探测因 CORS 失败
 * 导致结果丢失。失败或超时静默跳过。
 */
export async function probeContentDuration(
  url: string,
  video: HTMLVideoElement
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
    })
    const contentDuration = res.headers.get('X-Content-Duration')
    if (contentDuration) {
      const d = parseFloat(contentDuration)
      if (Number.isFinite(d) && d > 0) {
        video.dataset.serverDuration = d.toString()
      }
    }
  } catch {
    // HEAD 请求失败(CORS 限制 / 超时),静默跳过
  }
}

/**
 * 挂载直链源的前置校验:HTTPS 页面下的 http 直链必然失败。
 *
 * 浏览器混合内容策略会把 http 资源强制升级到同端口 https,源站不支持
 * TLS 时 TLS 握手必然失败(ERR_SSL_PROTOCOL_ERROR)——与其静默等浏览器
 * 报一个泛化的 media error,不如在发请求前直接给出可操作的修复指引
 * (直链模式不回退服务器中转)。
 *
 * @throws Error 带修复指引的错误;非该场景正常返回
 */
function assertDirectLinkReachable(
  targetUrl: string,
  noProxyFallback: boolean
): void {
  if (!noProxyFallback) return
  if (window.location.protocol !== 'https:') return
  let u: URL
  try {
    u = new URL(targetUrl)
  } catch {
    return
  }
  if (u.protocol !== 'http:') return
  throw new Error(
    `直链播放失败：挂载源站为 HTTP（${u.host}），HTTPS 页面下浏览器会强制升级协议导致无法直连。` +
      '解决方式：为源站配置 HTTPS（如反向代理）后重新保存挂载，或删除影片后改用服务器转发模式重新添加'
  )
}

/** 直链加载计划:一次 attach 的全部链接层决策结果 */
export interface DirectLoadPlan {
  /** 首选加载地址(经代理决策与 token 附加) */
  targetUrl: string
  /** 直连失败是否允许回退服务器代理 */
  fallback: boolean
  /** 陈旧 https 升级自愈的 http 降级地址(仅 http 页面 + 挂载直链) */
  httpDowngradeUrl: string | null
}

/**
 * 直链链接获取:一次性决策「最终请求地址」与全部备选路径。
 *
 * 统一代理策略由 url-proxy.ts 根据 URL 特征与源格式决策(B站 m4s /
 * 防盗链 headers 源走服务器代理,其余直连);挂载直链模式
 * (noProxyFallback)跳过混合内容代理分支,保持源站直传语义。
 * 陈旧 https 升级自愈(仅 http 页面 + 挂载直链):源站 TLS 事后被移除
 * 时存量影片仍持有 https 直链,http 页面不受混合内容限制,降级回 http
 * 直链即可重新直连源站。
 */
export function resolveDirectLoadPlan(source: PlayerSource): DirectLoadPlan {
  const route = resolveMediaRoute(source.url, source.headers, source.format, {
    noProxyFallback: source.noProxyFallback === true,
  })
  const targetUrl = route.url

  // 挂载直链源前置校验:HTTPS 页面下的 http 直链必然失败,
  // 发请求前直接给出可操作的修复指引(零网络往返,不回退中转)
  assertDirectLinkReachable(targetUrl, source.noProxyFallback === true)

  // 尝试加载视频:直连失败时回退到服务器代理(绕过跨域防盗链 / CORS)。
  // 挂载直链模式(noProxyFallback)例外:设计意图是源站直传、服务器零
  // 媒体流量,静默转代理会让服务器带宽跑满并掩盖直链本身的问题,
  // 失败直接抛错由调用方提示用户。
  const fallback = source.noProxyFallback !== true && route.allowFallback

  let httpDowngradeUrl: string | null = null
  if (
    source.noProxyFallback === true &&
    typeof window !== 'undefined' &&
    window.location.protocol === 'http:'
  ) {
    try {
      const u = new URL(targetUrl)
      if (
        u.protocol === 'https:' &&
        !['127.0.0.1', 'localhost', '::1'].includes(u.hostname)
      ) {
        u.protocol = 'http:'
        httpDowngradeUrl = u.toString()
      }
    } catch {
      /* 非法 URL,无降级路径 */
    }
  }

  return { targetUrl, fallback, httpDowngradeUrl }
}

/**
 * MKV 原生直连超时的文案规范化。
 *
 * MKV 原生直连超时:30s 内 metadata 都没出来,极大概率是编码不被浏览器
 * 原生支持(x265/HEVC、FLAC 组合在 Firefox 上完全无解),而非源站无响应
 * ——原文案误导排查方向。命中时返回带可操作指引的错误(调用方短路后续
 * 降级 / 回退,直接向用户展示);非该场景返回 null(调用方继续原链路)。
 */
export function normalizeMkvTimeoutError(
  err: unknown,
  source: PlayerSource
): Error | null {
  if (
    err instanceof Error &&
    err.message.startsWith('加载超时') &&
    source.format === 'mkv' &&
    source.playsvideoEnabled === false
  ) {
    return new Error(
      '加载超时：该 MKV 的编码（如 HEVC 视频 / FLAC 音轨）大概率不被当前浏览器原生支持，' +
        '可在该影片的解析设置中开启「浏览器转码引擎」后重试',
      { cause: err }
    )
  }
  return null
}
