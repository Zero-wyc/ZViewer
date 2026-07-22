import type { BilibiliCodec, BilibiliParseOptions } from './types'

/** localStorage 持久化 key */
const STORAGE_KEY = 'zcontrol:bilibili-parse-options'

/** 编码偏好到 B站 fnval 的映射；`auto` 表示由后端决定 */
const codecToFnval: Record<BilibiliCodec, number | undefined> = {
  auto: undefined,
  avc: 80,
  hevc: 2128,
  av1: 1104,
}

/**
 * B站 DASH 流 CDN 提供商可选项。
 *
 * B站 playurl 返回的 DASH 轨道 baseUrl 形如：
 *   https://upos-sz-mirrorcosbilibili.bilivideo.com/...
 *   https://upos-sz-mirroralibilibili.bilivideo.com/...
 *   https://upos-sz-mirrorhwbilibili.bilivideo.com/...
 *   https://upos-sz-mirrorcos.bilivideo.com/...
 *   https://xxxxx.mcdn.bilivideo.cn:8082/...
 *
 * 后端 `sortTracksByPreferredCdn` 通过 URL 子串匹配（大小写不敏感）重排轨道，
 * 因此 value 即为子串匹配关键词。新增 CDN 时只需在此追加选项。
 */
export interface BilibiliCdnOption {
  label: string
  value: string
  description?: string
}

export const BILIBILI_CDN_OPTIONS: BilibiliCdnOption[] = [
  { label: '自动', value: '', description: '由后端按可达性自动选择' },
  {
    label: '阿里云',
    value: 'ali',
    description: '匹配 mirrorali / alibilibili 节点',
  },
  {
    label: '腾讯云',
    value: 'cos',
    description: '匹配 mirrorcos / cosbilibili 节点',
  },
  {
    label: '华为云',
    value: 'hw',
    description: '匹配 mirrorhw / hwbilibili 节点',
  },
  {
    label: 'P2P CDN',
    value: 'mcdn',
    description: '匹配 .mcdn.bilivideo.cn 节点',
  },
  {
    label: '主站 CDN',
    value: 'upos-sz',
    description: '匹配 upos-sz-mirror* 默认主域名',
  },
]

function readBilibiliParseOptions(): BilibiliParseOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as BilibiliParseOptions
  } catch {
    // 忽略 localStorage 读取异常
  }
  return {}
}

export function getBilibiliParseOptions(): BilibiliParseOptions & {
  codec: BilibiliCodec
} {
  const stored = readBilibiliParseOptions()
  const codec = stored.codec || 'auto'
  return {
    ...stored,
    codec,
    fnval: stored.fnval ?? codecToFnval[codec],
  }
}

export function setBilibiliParseOptions(
  options: Partial<BilibiliParseOptions>
): void {
  const current = readBilibiliParseOptions()
  const next: BilibiliParseOptions = { ...current, ...options }
  if (options.codec) {
    next.fnval = codecToFnval[options.codec]
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // 忽略写入异常（例如隐私模式）
  }
}

export { codecToFnval }
