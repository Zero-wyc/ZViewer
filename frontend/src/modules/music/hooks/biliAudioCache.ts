/**
 * B站 视频音频地址缓存（`<bvid>:<cid>` → { 播放地址, 解析时间 }）。
 *
 * 从 useListenTogether 原样迁出（模块级会话缓存，无 React 依赖）。
 * playBiliSong 点击时解析写入；B站 音频不入后端队列，仅本地会话有效。
 *
 * **三层时效**（B站 签名直链不是「解析一次能用 2 小时」这么简单）：
 * - 硬 TTL（2h）：拿不到 deadline 的地址用时间兜底；能拿到 deadline 时以真实
 *   签名为准（`/api/stream/proxy?url=` 需要展开一层才读得到，见 url-expiry）；
 * - 续签窗口：距 deadline 不足 15 分钟（无 deadline 时按软 TTL 40 分钟）就在
 *   后台静默续签，把新地址存进 `standby`，播放中途失效时能立刻切换、无需等解析；
 * - 播放中失效：签名额度耗尽/CDN 拒绝，缓存里的地址可能还在续签窗口内，必须显式
 *   作废（`invalidateBiliAudioUrl`），否则会拿同一个坏地址反复重试。
 */
/**
 * 从播放地址里读签名 deadline（毫秒）。
 *
 * 播放地址是 `/api/stream/proxy?url=<CDN>`，deadline 在内层，需要展开一层。
 * 逻辑与 `playback-memory/services/url-expiry.ts` 的 `getBilibiliUrlDeadline`
 * 一致；这里内联是为了让本模块零依赖——单测用 node 原生跑源码，无法解析
 * `@/` 别名和无扩展名导入。
 */
function readBiliDeadlineMs(url: string): number | null {
  try {
    for (let depth = 0; url && depth < 4; depth++) {
      const parsed = new URL(url, 'http://zviewer.invalid')
      const raw = parsed.searchParams.get('deadline')
      if (raw && /^\d+$/.test(raw)) {
        const ms = Number(raw) * 1000
        if (Number.isSafeInteger(ms) && ms > 0) return ms
      }
      url = parsed.searchParams.get('url') ?? ''
    }
  } catch {
    // 无法解析的地址没有可用时效信息
  }
  return null
}

const BILI_AUDIO_URL_TTL_MS = 2 * 60 * 60 * 1000
/** 软过期：仍可播放，但应后台续签（避免播到一半签名到期） */
const BILI_AUDIO_SOFT_TTL_MS = 40 * 60 * 1000
/**
 * 提前续签窗口：距签名 deadline 不足这么久就预存新地址。
 *
 * 优先用 URL 里的真实 deadline，而不是「解析后过了 40 分钟」这种估算：
 * 同一个接口给的寿命并不固定（30 分钟到 2 小时都有），估算值要么来不及、
 * 要么提前太久白解析一次。
 */
const BILI_AUDIO_RENEW_WINDOW_MS = 15 * 60 * 1000

interface BiliStreamEntry {
  /** 播放地址（后端代理 URL，内含 B站 CDN 签名） */
  url: string
  /** 解析时顺带得到的视频地址（歌词页背景 MV 复用，省一次 playurl） */
  videoUrl?: string
  /** 解析时请求的清晰度（复用时要求一致，否则画质会意外降级） */
  qn?: number
  durationMs?: number
  at: number
}

const biliStreamMap = new Map<string, BiliStreamEntry>()

/**
 * 备用直链（后台续签/上次解析得到的新地址）。
 *
 * 为什么不直接覆盖缓存：正在播放的元素还指着旧地址，覆盖缓存会让预载与
 * 「同 URL 升格」判断失配；备用地址只在自愈时提升为当前地址。
 */
const biliStandbyMap = new Map<string, { url: string; at: number }>()

/** 解析代际：只允许「最后一次发起」的解析结果写缓存，防止旧解析覆盖新地址 */
const biliResolveGen = new Map<string, number>()

/** 最近一次后台续签时间（避免切回同一首时反复续签、白耗解析） */
const biliRefreshAt = new Map<string, number>()

/** 读取缓存（未过硬 TTL 返回 URL，过期/不存在返回 null 并清除条目） */
export function getCachedBiliAudioUrl(mapKey: string): string | null {
  return getBiliStreamEntry(mapKey)?.url ?? null
}

/** 读取完整缓存条目（含视频地址/清晰度，供后台续签与 MV 复用判断） */
export function getBiliStreamEntry(mapKey: string): BiliStreamEntry | null {
  const cached = biliStreamMap.get(mapKey)
  if (!cached) return null
  // 硬 TTL 兜底（拿不到 deadline 的地址）+ 真实签名已到期（能拿到 deadline）
  const deadline = readBiliDeadlineMs(cached.url)
  const expired =
    Date.now() - cached.at > BILI_AUDIO_URL_TTL_MS ||
    (deadline != null && Date.now() >= deadline - 60_000)
  if (expired) {
    biliStreamMap.delete(mapKey)
    biliRefreshAt.delete(mapKey)
    return null
  }
  return cached
}

/**
 * 是否已过软 TTL：地址还能用，但该续签了。
 *
 * 触发后台续签的时机由此判断——提前换新比「播到一半 403 再等解析」体验好得多，
 * 且续签只调用 playurl（不产生播放流请求），单曲最多一次。
 */
export function isBiliAudioStale(mapKey: string): boolean {
  const cached = biliStreamMap.get(mapKey)
  if (!cached) return false
  // 真实签名寿命优先：进入续签窗口就预存新地址，与「解析后过了多久」无关
  const deadline = readBiliDeadlineMs(cached.url)
  if (deadline != null) {
    return Date.now() >= deadline - BILI_AUDIO_RENEW_WINDOW_MS
  }
  // 续签过就以续签时间为准：否则「切走再切回」会因缓存时间没变而反复续签
  const last = biliRefreshAt.get(mapKey) ?? cached.at
  return Date.now() - last > BILI_AUDIO_SOFT_TTL_MS
}

/** 记录一次后台续签（续签不写缓存，因此需要单独记时间） */
export function noteBiliRefreshed(mapKey: string): void {
  biliRefreshAt.set(mapKey, Date.now())
}

/** 写入缓存（解析成功后调用） */
export function setCachedBiliAudioUrl(mapKey: string, url: string): void {
  const prev = biliStreamMap.get(mapKey)
  biliStreamMap.set(mapKey, {
    url,
    videoUrl: prev?.videoUrl,
    qn: prev?.qn,
    durationMs: prev?.durationMs,
    at: Date.now(),
  })
}

/** 写入完整解析结果（同时供音频播放与歌词页视频背景复用） */
export function setCachedBiliStream(
  mapKey: string,
  entry: {
    url: string
    videoUrl?: string
    qn?: number
    durationMs?: number
  }
): void {
  biliStreamMap.set(mapKey, { ...entry, at: Date.now() })
  // 刚拿到新签名：软 TTL 从这一刻重新计时，别立刻又判定「该续签了」
  biliRefreshAt.delete(mapKey)
}

/**
 * 作废缓存（播放途中直链失效时调用）。
 *
 * 连同备用地址一起丢弃：备用地址是同一批签名，源头失效时它大概率也失效了。
 */
export function invalidateBiliAudioUrl(mapKey: string): void {
  biliStreamMap.delete(mapKey)
  biliStandbyMap.delete(mapKey)
  biliRefreshAt.delete(mapKey)
}

/** 标记一次解析开始，返回本次解析的代际号 */
export function beginBiliResolve(mapKey: string): number {
  const next = (biliResolveGen.get(mapKey) ?? 0) + 1
  biliResolveGen.set(mapKey, next)
  return next
}

/**
 * 提交解析结果：只有仍是「最新一代」才写入。
 *
 * 场景：直链失效触发重解析时，上一次（失效前发起的）解析可能刚好返回，
 * 它的地址是旧的签名。若不做代际控制，旧结果会覆盖新结果，自愈就会
 * 拿着旧地址再失败一次，白白耗掉一次重试机会。
 */
export function commitBiliResolve(
  mapKey: string,
  gen: number,
  entry: { url: string; videoUrl?: string; qn?: number; durationMs?: number }
): boolean {
  if (biliResolveGen.get(mapKey) !== gen) return false
  setCachedBiliStream(mapKey, entry)
  return true
}

/** 记录备用直链（后台续签成功后调用） */
export function setBiliStandbyUrl(mapKey: string, url: string): void {
  biliStandbyMap.set(mapKey, { url, at: Date.now() })
}

/** 取出备用直链（取出即消费；未过软 TTL 才可用） */
export function takeBiliStandbyUrl(mapKey: string): string | null {
  const entry = biliStandbyMap.get(mapKey)
  biliStandbyMap.delete(mapKey)
  if (!entry) return null
  if (Date.now() - entry.at > BILI_AUDIO_SOFT_TTL_MS) return null
  return entry.url
}

/** 歌词页视频背景源缓存（同 bvid:cid:qn，10 分钟内进出歌词页不重复解析） */
const VIDEO_SOURCE_TTL_MS = 10 * 60 * 1000
const biliVideoSourceMap = new Map<
  string,
  { at: number; source: Record<string, unknown> }
>()

export function getCachedBiliVideoSource<T>(key: string): T | null {
  const cached = biliVideoSourceMap.get(key)
  if (!cached) return null
  if (Date.now() - cached.at > VIDEO_SOURCE_TTL_MS) {
    biliVideoSourceMap.delete(key)
    return null
  }
  return cached.source as T
}

export function setCachedBiliVideoSource(
  key: string,
  source: Record<string, unknown>
): void {
  biliVideoSourceMap.set(key, { at: Date.now(), source })
}

/**
 * 视频源缓存 key：`<bvid>:<cid>:<qn>`。
 *
 * 音频解析（qn=64）与歌词页背景共用同一个 key，同一次 playurl 的 videoUrl
 * 能被两边复用——否则每进一次歌词页都会重新解析，拿到一份新签名、再单开
 * 一条视频流，直链额度就这样被吃掉一半。
 */
export function biliVideoSourceKey(
  bvid: string,
  cid: number,
  qn: number
): string {
  return `${bvid}:${cid}:${qn}`
}

/** 正在懒解析中的 B站 条目（key → 解析 Promise；同 key 并发请求挂起等待） */
export const biliResolvingPromises = new Map<string, Promise<void>>()

/** B站 解析默认清晰度（无 CLI 时取 720P MP4 直链，audio 元素仅出声） */
export const BILI_DEFAULT_QN = 64
