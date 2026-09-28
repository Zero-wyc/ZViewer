import { useSyncExternalStore, useMemo } from 'react'
import type { BilibiliParseOptions } from './types'

/** localStorage 持久化 key */
const STORAGE_KEY = 'zcontrol:bilibili-parse-options'
/** 跨组件同步用的自定义事件名 */
const OPTIONS_CHANGE_EVENT = 'zcontrol:bilibili-parse-options-change'

/** 默认解析偏好（新影片在未配置前使用此默认值） */
export const DEFAULT_PARSE_OPTIONS = {
  preferMp4: true,
  bufferMode: false,
  cliEnabled: false,
}

/** 归一化后的解析偏好（所有字段都有确定值） */
export type NormalizedParseOptions = {
  preferMp4: boolean
  bufferMode: boolean
  cliEnabled: boolean
  /** 启用 CLI 之前保存的播放模式 */
  cliPrevPreferMp4?: boolean
}

/** 存储格式：以 movieId 字符串为 key 的配置映射 */
type ParseOptionsMap = Record<string, BilibiliParseOptions>

/**
 * 读取全部影片的配置映射。
 *
 * 兼容旧版单对象格式：若检测到旧格式（顶层含 preferMp4 等字段），
 * 视为迁移废弃数据返回空映射，避免旧全局配置污染新按影片存储。
 */
function readAllOptions(): ParseOptionsMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        // 旧格式：顶层直接含 preferMp4/bufferMode 字段
        if (
          'preferMp4' in parsed ||
          'bufferMode' in parsed ||
          'p2pEnabled' in parsed
        ) {
          return {}
        }
        return parsed as ParseOptionsMap
      }
    }
  } catch {
    // 忽略 localStorage 读取异常
  }
  return {}
}

function writeAllOptions(map: ParseOptionsMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 忽略写入异常（例如隐私模式）
  }
}

/** 归一化单个影片的配置（填充默认值） */
function normalizeOptions(
  opts: BilibiliParseOptions | undefined
): NormalizedParseOptions {
  // 未配置的字段使用 DEFAULT_PARSE_OPTIONS 的默认值，
  // 确保与 useBilibiliParsePreferences 的 fallback 行为一致。
  // 注意：必须用 ?? 而非 === true，否则 undefined 会被当作 false，
  // 导致未配置的影片 preferMp4=false（DASH），与默认 MP4 模式不一致。
  return {
    preferMp4: opts?.preferMp4 ?? DEFAULT_PARSE_OPTIONS.preferMp4,
    bufferMode: opts?.bufferMode ?? DEFAULT_PARSE_OPTIONS.bufferMode,
    cliEnabled: opts?.cliEnabled ?? DEFAULT_PARSE_OPTIONS.cliEnabled,
    cliPrevPreferMp4: opts?.cliPrevPreferMp4,
  }
}

/**
 * 读取指定影片的解析偏好（归一化后所有字段都有确定值）。
 * 未配置的影片返回默认值。
 */
export function getBilibiliParseOptions(
  movieId: number
): NormalizedParseOptions {
  const map = readAllOptions()
  return normalizeOptions(map[String(movieId)])
}

/**
 * 写入指定影片的解析偏好（合并写入）。
 * 写入后派发自定义事件，通知所有使用 useBilibiliParsePreferences 的组件更新。
 */
export function setBilibiliParseOptions(
  movieId: number,
  options: Partial<BilibiliParseOptions>
): void {
  const map = readAllOptions()
  const key = String(movieId)
  const current = map[key] || {}
  map[key] = { ...current, ...options }
  writeAllOptions(map)
  cachedSnapshot = getFullSnapshot()
  window.dispatchEvent(new Event(OPTIONS_CHANGE_EVENT))
}

// ===== 跨组件同步 hook =====
// 每个影片的解析偏好独立存储，但通过统一的 useSyncExternalStore 同步。
// cachedSnapshot 是全部影片配置的快照，任一影片配置变更都会刷新快照并触发重渲染。
// useMemo 保证只有目标影片配置真正变化时才产生新对象引用。

let cachedSnapshot: Record<string, NormalizedParseOptions> = {}

function getFullSnapshot(): Record<string, NormalizedParseOptions> {
  const map = readAllOptions()
  const result: Record<string, NormalizedParseOptions> = {}
  for (const key of Object.keys(map)) {
    result[key] = normalizeOptions(map[key])
  }
  return result
}

function subscribePreference(callback: () => void): () => void {
  window.addEventListener(OPTIONS_CHANGE_EVENT, callback)
  window.addEventListener('storage', callback)
  return () => {
    window.removeEventListener(OPTIONS_CHANGE_EVENT, callback)
    window.removeEventListener('storage', callback)
  }
}

function getPreferenceSnapshot() {
  return cachedSnapshot
}

// 初始化缓存
cachedSnapshot = getFullSnapshot()

/**
 * 读取指定影片的解析偏好（preferMp4 + bufferMode + cliEnabled），跨组件同步。
 * 任一影片配置变更后，所有使用此 hook 的组件都会更新。
 */
export function useBilibiliParsePreferences(
  movieId: number
): NormalizedParseOptions {
  const all = useSyncExternalStore(
    subscribePreference,
    getPreferenceSnapshot,
    getPreferenceSnapshot
  )
  return useMemo(
    () => all[String(movieId)] ?? DEFAULT_PARSE_OPTIONS,
    [all, movieId]
  )
}
