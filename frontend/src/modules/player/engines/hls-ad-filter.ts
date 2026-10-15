/**
 * HLS m3u8 广告分片过滤（Phase 3：对应 TVBox 配置的 rules/ads 能力）。
 *
 * 采集站（CMS）的 m3u8 普遍夹带广告：典型形态是把若干广告分片
 * （通常来自与正片不同的 CDN 域名、路径含 ad/banner/promo 等特征）
 * 注入正片分片列表之间。本模块在 hls.js 解析播放列表前重写响应文本，
 * 剔除疑似广告分片。
 *
 * 仅对 CMS 代理 URL（/api/stream/cms/proxy）加载的播放列表生效——
 * B站/挂载直链等来源不做任何过滤，避免误伤合法多 CDN 分发。
 *
 * 剔除启发式（保守策略，宁漏勿误杀）：
 * 1. URL 特征命中广告模式（/ad/、banner、promo、统计域名等）→ 剔除；
 * 2. 异主分片注入：正片分片基本在同一主域（≥10 个），而某个外部域名
 *    只出现极少量分片（≤ max(2, 10%)）→ 剔除该域全部分片；
 * 3. 分片总数 < 8 的小清单不做过滤（信号不足，避免误杀）。
 */

/** 广告 URL 特征（host 或 path 命中即剔除） */
const AD_URL_PATTERN =
  /(?:^|[/._-])ads?(?:[/._-]|$)|adcdn|adservice|banner|promo(?:te|tional)?|cupid\.|cnzz|umeng|analytics|appsflyer|\/gg\/|guanggao|adview|admaster|intsig/i

/** 判定播放列表是否经 CMS 代理加载（endpoint 形如 …/api/stream/cms/proxy） */
export function isCmsProxyEndpoint(endpoint: string): boolean {
  return /\/api\/stream\/cms\/proxy$/.test(endpoint)
}

/** 解析分片 URI 的 host；相对路径按播放列表 URL 解析，失败返回 null */
function resolveHost(uri: string, baseUrl: string): string | null {
  try {
    return new URL(uri, baseUrl).host
  } catch {
    return null
  }
}

/**
 * 过滤 m3u8 播放列表中的广告分片。
 *
 * @param manifest 播放列表文本（以 #EXTM3U 开头）
 * @param baseUrl 播放列表自身的 URL（相对分片按此解析）
 * @returns 过滤后的播放列表文本；未剔除任何分片时原样返回
 */
export function filterM3u8AdSegments(
  manifest: string,
  baseUrl: string
): string {
  if (!manifest.startsWith('#EXTM3U')) return manifest

  const lines = manifest.split('\n')
  const playlistHost = resolveHost('.', baseUrl)

  // 收集分片段落：EXTINF 行索引 → URI 行索引与 host
  interface Segment {
    extinfIdx: number
    uriIdx: number
    uri: string
    host: string | null
  }
  const segments: Segment[] = []
  let pendingExtinfIdx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('#EXTINF')) {
      pendingExtinfIdx = i
      continue
    }
    if (!line || line.startsWith('#')) continue
    if (pendingExtinfIdx >= 0) {
      segments.push({
        extinfIdx: pendingExtinfIdx,
        uriIdx: i,
        uri: line,
        host: resolveHost(line, baseUrl),
      })
      pendingExtinfIdx = -1
    }
  }

  // 分片太少的清单不做过滤（信号不足）
  if (segments.length < 8) return manifest

  const baseHost = playlistHost
  // 主域正片分片数（host === 播放列表 host）
  const baseCount = segments.filter((s) => s.host === baseHost).length
  // 外部 host → 分片数
  const foreignCounts = new Map<string, number>()
  for (const s of segments) {
    if (s.host && s.host !== baseHost) {
      foreignCounts.set(s.host, (foreignCounts.get(s.host) ?? 0) + 1)
    }
  }

  const dropped = new Set<number>()
  for (const s of segments) {
    // 规则 1：URL 特征命中
    if (AD_URL_PATTERN.test(s.uri)) {
      dropped.add(s.extinfIdx)
      continue
    }
    // 规则 2：主域足够多时，极少量外部域分片视为注入广告
    if (
      s.host &&
      s.host !== baseHost &&
      baseCount >= 10 &&
      (foreignCounts.get(s.host) ?? 0) <=
        Math.max(2, Math.floor(segments.length * 0.1))
    ) {
      dropped.add(s.extinfIdx)
    }
  }

  if (dropped.size === 0) return manifest

  // 重建：剔除被标记分片的 EXTINF 行、URI 行，以及两者之间的辅助标签行
  //（如 #EXT-X-BYTERANGE；#EXT-X-DISCONTINUITY 通常位于 EXTINF 之前，保留）
  const uriIdxDropped = new Set(
    segments.filter((s) => dropped.has(s.extinfIdx)).map((s) => s.uriIdx)
  )
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (dropped.has(i) || uriIdxDropped.has(i)) continue
    // EXTINF 与 URI 之间的辅助行（罕见）一并剔除
    const owner = segments.find(
      (s) => i > s.extinfIdx && i < s.uriIdx && dropped.has(s.extinfIdx)
    )
    if (owner) continue
    out.push(lines[i])
  }

  console.log(
    `[hls-ad-filter] 剔除 ${dropped.size}/${segments.length} 个疑似广告分片 (base=${baseHost})`
  )
  return out.join('\n')
}
