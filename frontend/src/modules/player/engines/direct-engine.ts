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
 * 链接获取层（URL 决策 / 前置校验 / 降级与代理备选 / 时长探测）抽离至
 * direct-route.ts，与 videojs10 引擎共享；本引擎保留原生执行层：
 * video.src / video.load() / metadata 等待。
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
import { resetVideoElement } from '../utils'
import { buildProxyUrl } from '../services/url-proxy'
import {
  probeContentDuration,
  resolveDirectLoadPlan,
  waitForMetadataOrError,
  normalizeMkvTimeoutError,
} from './direct-route'

export const directEngine: PlayerEngine = {
  type: 'direct',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)
    // 链接获取：URL 决策 + 前置校验 + http 降级备选（见 direct-route.ts）
    const plan = resolveDirectLoadPlan(source)
    const targetUrl = plan.targetUrl

    // 原生执行层：设置 src 并等待 metadata（直连失败时换 URL 重试）
    const loadOnce = async (
      url: string,
      noReferrer: boolean
    ): Promise<void> => {
      // referrerPolicy 必须在 src 赋值前设置才对该次媒体请求生效；
      // B站 CDN 拒绝携带跨站 Referer 的请求（403 → ORB 拦截 → 直连必败）
      // 经 content attribute 设置（lib.dom 未在 HTMLVideoElement 声明 IDL 属性）
      if (noReferrer) {
        video.setAttribute('referrerpolicy', 'no-referrer')
      } else {
        video.removeAttribute('referrerpolicy')
      }
      video.src = url
      video.load()
      await waitForMetadataOrError(video)
    }

    try {
      await loadOnce(targetUrl, plan.noReferrer)
    } catch (err) {
      // MKV 原生直连超时：极大概率是编码不被浏览器原生支持而非源站无
      // 响应，命中时短路后续降级 / 回退，直接给出可操作指引
      const mkvErr = normalizeMkvTimeoutError(err, source)
      if (mkvErr) {
        throw mkvErr
      }
      if (plan.httpDowngradeUrl) {
        console.warn(
          '[direct-engine] https 直链加载失败（疑为失效的协议升级：源站 TLS 已移除），降级 http 直链重试:',
          err
        )
        resetVideoElement(video)
        try {
          await loadOnce(plan.httpDowngradeUrl, plan.noReferrer)
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
      if (!plan.fallback) {
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
        await loadOnce(buildProxyUrl(source.url), false)
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
