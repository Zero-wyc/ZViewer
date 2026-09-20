/**
 * Direct 引擎：直接设置 video.src 播放原生支持的格式（mp4/webm/mov/mkv）。
 *
 * 无需 MSE / hls.js / flv.js，浏览器原生解码。
 * Chrome 91+ 支持 MKV 容器（需 H.264/AAC 编码）。
 *
 * 代理策略由 url-proxy.ts 统一控制（分离式架构）：
 * - B站 DASH m4s / 带防盗链 headers 的源走服务器代理
 * - 其他源（B站 MP4 直链 / webdav / ftp / 用户直链）直连
 * - 直连失败时（跨域防盗链 / CORS / 403），自动回退到服务器代理重试；
 *   挂载直链模式（noProxyFallback）不回退，直接抛可读错误
 *
 * attach 在 metadata 就绪后 resolve。metadata 等待带超时保护：网络挂起
 * （连接 hang 住不返回也不报错）时 reject 兜底，避免永久 pending 卡死
 * 上层的串行操作队列（换源 / 重载全部排队等待）。
 *
 * 对于转码流（fragmented MP4），video.duration 可能为 Infinity。
 * HEAD 时长探测采用惰性策略：普通源 99% 没有 X-Content-Duration header，
 * 无条件探测属于浪费请求；仅在检测到 Infinity 后对最终加载 URL（回退
 * 代理后为 proxyUrl）补发 HEAD，结果写入 video.dataset.serverDuration
 * 供 useVideoDuration 回退使用。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, formatVideoLoadError } from '../utils'
import { resolveMediaRoute, buildProxyUrl } from '../services/url-proxy'

/** metadata 等待超时（毫秒）：网络挂起时兜底，避免 attach 永久 pending */
const METADATA_TIMEOUT_MS = 30_000

/** HEAD 时长探测超时（毫秒） */
const HEAD_TIMEOUT_MS = 5_000

/**
 * 等待 video metadata 就绪或 error 事件，带超时保护。
 *
 * 与 utils.waitForMetadata 不同，本函数额外处理两类异常路径：
 * - error 事件：加载失败时 reject 而非永久 pending（文案经
 *   formatVideoLoadError 映射，直链模式下直接展示给用户）
 * - 超时：网络挂起（无 error 也无 metadata）时 reject 兜底，
 *   让上层串行队列得以继续、代理回退链路得以执行
 */
function waitForMetadataOrError(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
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
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
    }
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      // 抛出面向用户的可读文案：直链模式（noProxyFallback）不回退代理，
      // 该错误会经 message.error 直接展示给用户
      reject(new Error(formatVideoLoadError(video.error?.code)))
    }
    video.addEventListener('loadedmetadata', onLoaded, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

/**
 * 补发 HEAD 请求探测 X-Content-Duration（转码流时长兜底）。
 *
 * 惰性探测：仅在加载完成后发现 duration 为 Infinity 时调用——
 * 普通源没有该 header，无条件探测属于浪费请求；对最终加载的 URL
 * （回退代理后为 proxyUrl）发请求，避免对直连 URL 探测因 CORS 失败
 * 导致结果丢失。失败或超时静默跳过。
 */
async function probeContentDuration(
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
    // HEAD 请求失败（CORS 限制 / 超时），静默跳过
  }
}

/**
 * 挂载直链源的前置校验：HTTPS 页面下的 http 直链必然失败。
 *
 * 浏览器混合内容策略会把 http 资源强制升级到同端口 https，源站不支持
 * TLS 时 TLS 握手必然失败（ERR_SSL_PROTOCOL_ERROR）——与其静默等浏览器
 * 报一个泛化的 media error，不如在发请求前直接给出可操作的修复指引
 * （直链模式不回退服务器中转）。
 *
 * @throws Error 带修复指引的错误；非该场景正常返回
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

export const directEngine: PlayerEngine = {
  type: 'direct',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    // 统一代理策略：由 url-proxy.ts 根据 URL 特征与源格式一次性决策
    // 「最终请求地址」与「直连失败是否允许回退服务器代理」。
    // 挂载直链模式（noProxyFallback）跳过混合内容代理分支，保持源站直传语义；
    // http 源的 TLS 能力已在挂载配置期探测（httpsDirect），http 直链到达
    // 播放层即源站不支持 TLS，由 url-proxy 决策走服务器代理
    const route = resolveMediaRoute(source.url, source.headers, source.format, {
      noProxyFallback: source.noProxyFallback === true,
    })
    const targetUrl = route.url

    // 挂载直链源前置校验：HTTPS 页面下的 http 直链必然失败，
    // 发请求前直接给出可操作的修复指引（零网络往返，不回退中转）
    assertDirectLinkReachable(targetUrl, source.noProxyFallback === true)

    // 尝试加载视频：直连失败时回退到服务器代理（绕过跨域防盗链 / CORS）。
    // 挂载直链模式（noProxyFallback）例外：设计意图是源站直传、服务器零
    // 媒体流量，静默转代理会让服务器带宽跑满并掩盖直链本身的问题，
    // 失败直接抛错由调用方提示用户。
    const fallback = source.noProxyFallback !== true && route.allowFallback

    // 陈旧 https 升级自愈（仅 http 页面 + 挂载直链）：直链的 https 协议
    // 升级来自后端配置期探测缓存，源站 TLS 事后被移除时存量影片仍持有
    // https 直链（浏览器连不上，表现为「源不可用」/连接失败）。http 页面
    // 不受混合内容限制，降级回 http 直链即可重新直连源站——仍是直链
    // 直传、不经服务器。https 页面下降级不可行（混合内容硬限制），
    // 127.0.0.1/localhost 信任源无需降级。
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
        /* 非法 URL，无降级路径 */
      }
    }

    const loadOnce = async (url: string): Promise<void> => {
      video.src = url
      video.load()
      await waitForMetadataOrError(video)
    }

    try {
      await loadOnce(targetUrl)
    } catch (err) {
      // MKV 原生直连超时：30s 内 metadata 都没出来，极大概率是编码不被
      // 浏览器原生支持（x265/HEVC、FLAC 组合在 Firefox 上完全无解），
      // 而非源站无响应——原文案误导排查方向。此处只改提示文案给出可操作
      // 指引，不自动回退（尊重直链语义与影片级开关的用户显式选择）。
      if (
        err instanceof Error &&
        err.message.startsWith('加载超时') &&
        source.format === 'mkv' &&
        source.playsvideoEnabled === false
      ) {
        throw new Error(
          '加载超时：该 MKV 的编码（如 HEVC 视频 / FLAC 音轨）大概率不被当前浏览器原生支持，' +
            '可在该影片的解析设置中开启「浏览器转码引擎」后重试',
          { cause: err }
        )
      }
      if (httpDowngradeUrl) {
        console.warn(
          '[direct-engine] https 直链加载失败（疑为失效的协议升级：源站 TLS 已移除），降级 http 直链重试:',
          err
        )
        resetVideoElement(video)
        try {
          await loadOnce(httpDowngradeUrl)
          return {
            cleanup: () => {
              delete video.dataset.serverDuration
            },
          }
        } catch (downgradeErr) {
          throw new Error(
            `直链播放失败：${
              downgradeErr instanceof Error
                ? downgradeErr.message
                : String(downgradeErr)
            }。https/http 直链均加载失败，请检查源站可达性，或重新保存挂载后重新添加影片`,
            { cause: downgradeErr }
          )
        }
      }
      if (!fallback) {
        if (source.noProxyFallback === true) {
          console.warn(
            '[direct-engine] 直链模式：直连失败，不回退服务器代理:',
            err
          )
        }
        throw err
      }
      console.warn('[direct-engine] 直连失败，回退到服务器代理:', err)
      resetVideoElement(video)
      try {
        await loadOnce(buildProxyUrl(source.url))
      } catch (proxyErr) {
        // 包装两次失败上下文：cause 挂回退代理的错误（symptom 因果），
        // 首次直连错误已由上方 console.warn 记录
        throw new Error(
          `直连失败且回退代理仍失败：${
            proxyErr instanceof Error ? proxyErr.message : String(proxyErr)
          }`,
          { cause: proxyErr }
        )
      }
    }

    // 惰性时长探测：仅当原生时长不可用（转码流 duration=Infinity）时补发
    // HEAD；对最终加载的 URL（video.src 解析后的绝对地址）探测，普通源
    // 不发任何额外请求
    if (!Number.isFinite(video.duration) || video.duration === Infinity) {
      await probeContentDuration(video.src, video)
    }

    return {
      cleanup: () => {
        delete video.dataset.serverDuration
      },
    }
  },
}
