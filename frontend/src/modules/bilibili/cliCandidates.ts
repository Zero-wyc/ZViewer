import type { ResolvedSource } from './types'

/**
 * 候选 CDN 地址登记：让本地 CLI 代理在主节点 5xx 时有节点可换。
 *
 * 背景：房主直链模式（服务端只解析元数据、媒体流由 CLI /proxy 直连 CDN）下，
 * CLI 的候选表不会被它自己的 /resolve 写入——某个 CDN 节点回 5xx 时无节点可换，
 * 一个分段 502 就是整段视频黑屏。解析结果里带了服务端排好序的候选列表，
 * 前端在包装代理 URL 时顺手登记给 CLI，换节点能力才真正闭环。
 *
 * 这里刻意不依赖任何 UI / i18n 模块，纯函数 + 一次 fire-and-forget 请求，
 * 便于单测，也保证「登记失败不影响播放」这条约束不被其他依赖破坏。
 */

/** 单条轨道登记给 CLI 的候选表。 */
export interface CliCandidateItem {
  /** 媒体原始地址（非代理地址），作为 CLI 候选缓存的 key。 */
  primaryUrl: string
  /** 同一轨道的候选地址，包含 primaryUrl 本身。 */
  backupUrls: string[]
}

/** 已登记过的主 URL，避免同一结果反复 POST。 */
const registeredCandidateKeys = new Set<string>()

/** 上限防止长时间播放把 Set 撑大（签名 URL 每次解析都不同）。 */
const REGISTERED_CANDIDATE_LIMIT = 512

/** 从 CLI 代理地址里还原原始媒体地址（非代理地址原样返回）。 */
export function unwrapCliProxyUrl(proxyPrefix: string, raw: string): string {
  if (!raw.startsWith(proxyPrefix)) return raw
  const rest = raw.slice(proxyPrefix.length)
  const amp = rest.indexOf('&')
  const encoded = amp >= 0 ? rest.slice(0, amp) : rest
  try {
    return decodeURIComponent(encoded)
  } catch {
    return raw
  }
}

/**
 * 把解析结果整理成 CLI 需要的候选表。
 *
 * 规则：
 * - 没有候选（或候选只有主地址自己）时跳过，等于没有回退能力；
 * - 一律还原成原始 CDN 地址：CLI 的缓存 key 是原始 URL，代理地址匹配不上；
 * - 同一主地址只返回一次，重复调用方（缓存命中）不会重复登记。
 */
export function buildCandidateItems(
  proxyUrl: string,
  resolved: Pick<
    ResolvedSource,
    'videoUrl' | 'audioUrl' | 'videoBackupUrls' | 'audioBackupUrls'
  >
): CliCandidateItem[] {
  const proxyPrefix = `${proxyUrl.replace(/\/$/, '')}/proxy?url=`
  const items: CliCandidateItem[] = []

  const collect = (primary?: string, backups?: string[]) => {
    if (!primary || !backups || backups.length === 0) return
    const primaryUrl = unwrapCliProxyUrl(proxyPrefix, primary)
    const unique = [
      ...new Set(
        backups.filter(Boolean).map((u) => unwrapCliProxyUrl(proxyPrefix, u))
      ),
    ]
    if (unique.length === 0) return
    if (unique.length === 1 && unique[0] === primaryUrl) return
    const key = `${proxyUrl}|${primaryUrl}`
    if (registeredCandidateKeys.has(key)) return
    if (registeredCandidateKeys.size >= REGISTERED_CANDIDATE_LIMIT) {
      registeredCandidateKeys.clear()
    }
    registeredCandidateKeys.add(key)
    items.push({ primaryUrl, backupUrls: unique })
  }

  collect(resolved.videoUrl, resolved.videoBackupUrls)
  collect(resolved.audioUrl, resolved.audioBackupUrls)
  return items
}

/** 仅供单测重置登记状态。 */
export function resetRegisteredCandidates(): void {
  registeredCandidateKeys.clear()
}

/**
 * 把候选表 POST 给 CLI。失败静默：CLI 未启动、旧版 CLI 没有该接口都很常见。
 */
export function registerCliCandidates(
  proxyUrl: string,
  resolved: Pick<
    ResolvedSource,
    'videoUrl' | 'audioUrl' | 'videoBackupUrls' | 'audioBackupUrls'
  >
): void {
  const items = buildCandidateItems(proxyUrl, resolved)
  if (items.length === 0) return

  const base = proxyUrl.replace(/\/$/, '')
  void fetch(`${base}/candidates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items }),
  })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    })
    .catch((err) => {
      // 登记失败就撤销标记，下次解析还有机会补上。
      for (const item of items) {
        registeredCandidateKeys.delete(`${proxyUrl}|${item.primaryUrl}`)
      }
      console.debug('[cliCandidates] 候选地址登记失败（不影响播放）:', err)
    })
}
