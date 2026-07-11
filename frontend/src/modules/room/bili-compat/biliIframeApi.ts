/**
 * B站官方 iframe 播放器 postMessage 通信封装
 *
 * 目标 origin：https://player.bilibili.com
 * 由于 B站 iframe 跨域限制，所有 postMessage 调用均可能失败，
 * 调用方需处理返回值 false 的情况并给出降级提示。
 */

export const BILI_PLAYER_ORIGIN = 'https://player.bilibili.com'

export interface BiliIframeState {
  currentTime: number
  paused: boolean
  duration?: number
}

interface PostMessagePayload {
  action: string
  time?: number
  mode?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从 B站 iframe postMessage 数据中提取播放器状态。
 * 兼容扁平结构 { currentTime, paused, duration } 与
 * 包装结构 { cmd, data: { currentTime, paused, duration } }。
 */
function extractState(data: unknown): Partial<BiliIframeState> | null {
  if (!isPlainObject(data)) return null

  const fromObj = (
    obj: Record<string, unknown>
  ): Partial<BiliIframeState> | null => {
    const hasState =
      typeof obj.currentTime === 'number' ||
      typeof obj.paused === 'boolean'
    if (!hasState) return null
    return {
      currentTime:
        typeof obj.currentTime === 'number' ? obj.currentTime : undefined,
      paused: typeof obj.paused === 'boolean' ? obj.paused : undefined,
      duration: typeof obj.duration === 'number' ? obj.duration : undefined,
    }
  }

  const direct = fromObj(data)
  if (direct) return direct

  // 尝试包装结构
  if (isPlainObject(data.data)) {
    return fromObj(data.data)
  }

  return null
}

function postToIframe(
  iframe: HTMLIFrameElement | null,
  payload: PostMessagePayload
): boolean {
  if (!iframe || !iframe.contentWindow) {
    return false
  }
  try {
    iframe.contentWindow.postMessage(payload, BILI_PLAYER_ORIGIN)
    return true
  } catch (err) {
    console.warn('[BiliCompat] postMessage failed:', err)
    return false
  }
}

/** 通知 iframe 播放器播放 */
export function playIframe(iframe: HTMLIFrameElement | null): boolean {
  return postToIframe(iframe, { action: 'play' })
}

/** 通知 iframe 播放器暂停 */
export function pauseIframe(iframe: HTMLIFrameElement | null): boolean {
  return postToIframe(iframe, { action: 'pause' })
}

/** 通知 iframe 播放器跳转到指定时间（秒） */
export function seekIframe(
  iframe: HTMLIFrameElement | null,
  time: number
): boolean {
  return postToIframe(iframe, { action: 'seek', time })
}

/** 控制弹幕显隐 */
export function setDanmakuEnabled(
  iframe: HTMLIFrameElement | null,
  enabled: boolean
): boolean {
  return postToIframe(iframe, {
    action: 'setDanmaku',
    mode: enabled ? 'show' : 'hide',
  })
}

/**
 * 请求 iframe 当前播放状态。
 *
 * 通过 postMessage 发送 { action: 'getState' }，
 * 监听 message 事件接收响应，带 2s 超时。
 *
 * 失败场景（reject）：
 * - iframe 不可用或已卸载
 * - postMessage 抛出异常（跨域受限）
 * - 2s 内未收到有效响应
 */
export function getIframeState(
  iframe: HTMLIFrameElement | null
): Promise<BiliIframeState> {
  return new Promise((resolve, reject) => {
    if (!iframe || !iframe.contentWindow) {
      reject(new Error('iframe unavailable'))
      return
    }

    let done = false

    const timeoutId = window.setTimeout(() => {
      if (done) return
      done = true
      window.removeEventListener('message', handler)
      reject(new Error('getState timeout'))
    }, 2000)

    function handler(event: MessageEvent) {
      if (done) return
      if (event.origin !== BILI_PLAYER_ORIGIN) return

      const extracted = extractState(event.data)
      if (!extracted) return

      const currentTime = extracted.currentTime
      const paused = extracted.paused

      // 必须同时具备 currentTime 与 paused 才视为完整状态
      if (typeof currentTime !== 'number' || typeof paused !== 'boolean') {
        return
      }

      done = true
      window.clearTimeout(timeoutId)
      window.removeEventListener('message', handler)

      resolve({
        currentTime,
        paused,
        duration: extracted.duration,
      })
    }

    window.addEventListener('message', handler)

    try {
      iframe.contentWindow.postMessage(
        { action: 'getState' },
        BILI_PLAYER_ORIGIN
      )
    } catch (err) {
      done = true
      window.clearTimeout(timeoutId)
      window.removeEventListener('message', handler)
      reject(err)
    }
  })
}

export { extractState as extractBiliState }
