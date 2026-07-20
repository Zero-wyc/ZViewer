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
