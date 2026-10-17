/**
 * B站 视频音频地址缓存（`<bvid>:<cid>` → { url, 解析时间 }）。
 *
 * 从 useListenTogether 原样迁出（模块级会话缓存，无 React 依赖）。
 * playBiliSong 点击时解析写入；B站 音频不入后端队列，仅本地会话有效。
 * **带 TTL**：B站 直链（代理 URL 背后的 CDN 地址/鉴权参数）通常 1~4 小时
 * 过期，长会话中切回旧歌若命中过期地址会 403 黑屏——超过 2 小时的条目
 * 视为失效并重新解析。
 */
const BILI_AUDIO_URL_TTL_MS = 2 * 60 * 60 * 1000
const biliAudioUrlMap = new Map<string, { url: string; at: number }>()

/** 读取缓存（未过期返回 URL，过期/不存在返回 null 并清除条目） */
export function getCachedBiliAudioUrl(mapKey: string): string | null {
  const cached = biliAudioUrlMap.get(mapKey)
  if (!cached) return null
  if (Date.now() - cached.at > BILI_AUDIO_URL_TTL_MS) {
    biliAudioUrlMap.delete(mapKey)
    return null
  }
  return cached.url
}

/** 写入缓存（解析成功后调用） */
export function setCachedBiliAudioUrl(mapKey: string, url: string): void {
  biliAudioUrlMap.set(mapKey, { url, at: Date.now() })
}

/** 正在懒解析中的 B站 条目（key → 解析 Promise；同 key 并发请求挂起等待） */
export const biliResolvingPromises = new Map<string, Promise<void>>()

/** B站 解析默认清晰度（无 CLI 时取 720P MP4 直链，audio 元素仅出声） */
export const BILI_DEFAULT_QN = 64
