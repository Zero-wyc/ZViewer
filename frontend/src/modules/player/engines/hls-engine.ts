/**
 * HLS 引擎：通过 hls.js 将 m3u8 流挂载到 <video> 元素。
 *
 * - Safari（含 iOS）原生支持 HLS：直接设置 src，无需 hls.js；
 * - 其他浏览器通过 hls.js（MSE 封装）附加；
 * - MANIFEST_PARSED 后 resolve；cleanup 销毁 hls 实例。
 *
 * 跨域处理：通过自定义 ProxyLoader 拦截 hls.js 的所有网络请求（m3u8 主清单、
 * ts 分片、密钥等），将跨域 URL 包装为服务器代理 URL，绕过浏览器 CORS 限制。
 */
import Hls from 'hls.js'
import { getApiUrl } from '@/lib/api'
import { readHlsProxySource, buildHlsProxyRequest, isServerApiUrl } from '../services/hls-proxy'
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import {
  resolveProxyUrl,
  isLocalUrl,
  isRelativeUrl,
  buildProxyUrl,
  appendAuthToken,
} from '../services/url-proxy'

/** Safari 等原生 HLS 支持检测 */
function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/**
 * 创建自定义 ProxyLoader：拦截 hls.js 的所有网络请求，
 * 将跨域 URL 包装为服务器代理 URL，避免浏览器 CORS 限制。
 *
 * 使用 Hls.DefaultConfig.loader 作为基类（通常为 FetchLoader），
 * 仅在 load 入口处改写 context.url，其余行为保持不变。
 *
 * 关键：加载完成后需恢复 context.url 与 response.url 为原始 URL，
 * 否则 hls.js 会基于代理 URL 解析 m3u8 中的相对路径 ts 分片，导致拼接错误。
 */
function createProxyLoader(sourceUrl: string, headers?: Record<string, string>) {
  const BaseLoader = Hls.DefaultConfig.loader
  const logicalUrl = (value: string) => value
  const transportUrl = (value: string) => value
  const apiBase = getApiUrl()
  const proxySource = readHlsProxySource(logicalUrl(sourceUrl), apiBase)

  return class ProxyLoader extends BaseLoader {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    load(context: any, config: any, callbacks: any): void {
      const originalUrl = context.url
      const logical = logicalUrl(originalUrl)
      const proxyRequest = readHlsProxySource(logical, apiBase)
      const manifestBaseUrl = proxyRequest?.url ?? logical
      if (isServerApiUrl(logical, apiBase) || isLocalUrl(logical) || isRelativeUrl(logical)) {
        // Includes Kazumi/AniSubs proxies: never proxy our own authenticated API.
        context.url = transportUrl(originalUrl)
      } else if (proxySource) {
        // Child playlists, segments, maps and keys inherit the same proxy headers.
        context.url = transportUrl(buildHlsProxyRequest(manifestBaseUrl, proxySource))
      } else {
        context.url = headers ? resolveProxyUrl(originalUrl, headers, 'hls') : buildProxyUrl(originalUrl)
      }
      context.url = appendAuthToken(context.url)
      if (proxyRequest || context.url !== originalUrl || manifestBaseUrl !== originalUrl) {
        const originalOnSuccess = callbacks.onSuccess
        // hls.js callback order is response, stats, context, networkDetails.
        // Restore both URL fields before it resolves any relative playlist URI.
        callbacks.onSuccess = (response: any, stats: any, ctx: any, networkDetails: any) => {
          if (response) response.url = manifestBaseUrl
          if (ctx) ctx.url = manifestBaseUrl
          originalOnSuccess(response, stats, ctx, networkDetails)
        }
      }
      super.load(context, config, callbacks)
    }
  }
}

/** 等待 hls.js 加载 m3u8 清单完成或失败，带超时 */
function waitForHlsReady(hls: Hls, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false

    const onManifestParsed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const onError = (
      _event: string,
      data: { type: string; details: string; fatal: boolean; url?: string }
    ) => {
      if (settled) return
      // 非致命错误不reject，让hls.js自行恢复
      if (!data.fatal) return
      settled = true
      cleanup()
      reject(
        new Error(
          `HLS加载失败: type=${data.type} details=${data.details} url=${data.url?.slice(0, 80)}`
        )
      )
    }

    const onTimeout = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`HLS加载超时(${timeoutMs}ms)`))
    }

    function cleanup() {
      hls.off(Hls.Events.MANIFEST_PARSED, onManifestParsed)
      hls.off(Hls.Events.ERROR, onError)
      clearTimeout(timer)
    }

    hls.on(Hls.Events.MANIFEST_PARSED, onManifestParsed)
    hls.on(Hls.Events.ERROR, onError)
    const timer = setTimeout(onTimeout, timeoutMs)
  })
}

export const hlsEngine: PlayerEngine = {
  type: 'hls',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)

    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format)
    console.log('[hls-engine] attach start', {
      originalUrl: source.url?.slice(0, 80),
      resolvedUrl: targetUrl?.slice(0, 80),
      format: source.format,
    })

    // 优先使用 hls.js：支持 MSE 的浏览器（Chrome/Firefox/Edge）通过 hls.js 附加，
    // 可利用 ProxyLoader 拦截跨域请求。仅当 hls.js 不支持时（如 iOS Safari
    // 不支持 MSE）才回退到原生 HLS。
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        loader: createProxyLoader(targetUrl, source.headers),
        // 内存控制：hls.js 默认 maxMaxBufferLength=600s、backBufferLength=Infinity——
        // 已播数据永不清理，长视频播放 1-2 小时后 MSE SourceBuffer 累积到 GB 级内存。
        // 前向缓冲 30s 保证平滑，硬上限 120s 兜底极低码率，已播仅保留 90s
        // （seek 回看 90s 内秒开，更早的位置会重新拉取分片）。
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        backBufferLength: 90,
      })

      // 先注册事件监听器，再调用 attachMedia
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('[hls-engine] MEDIA_ATTACHED, calling loadSource')
        hls.loadSource(targetUrl)
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[hls-engine] MANIFEST_PARSED')
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        console.error('[hls-engine] hls.js error', {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          url: data.url?.slice(0, 80),
          response: data.response
            ? {
                code: data.response.code,
                text: data.response.text?.slice(0, 100),
              }
            : null,
        })
      })

      hls.attachMedia(video)

      try {
        // 使用事件驱动等待替代 waitForMetadata，避免永久阻塞
        await waitForHlsReady(hls)
      } catch (err) {
        try {
          hls.destroy()
        } catch {
          /* ignore */
        }
        throw err
      }

      return {
        cleanup: () => {
          try {
            hls.destroy()
          } catch {
            /* ignore */
          }
        },
      }
    }

    // 回退：原生 HLS（Safari/iOS），无法拦截 ts 分片请求
    if (canPlayNativeHls(video)) {
      console.log('[hls-engine] using native HLS (Safari fallback)')
      video.src = targetUrl
      video.load()
      await waitForMetadata(video)
      return {
        cleanup: () => {
          try {
            video.pause()
          } catch {
            /* ignore */
          }
          video.removeAttribute('src')
          video.load()
        },
      }
    }

    throw new Error('当前浏览器不支持 HLS 播放且 hls.js 不可用')
  },
}
