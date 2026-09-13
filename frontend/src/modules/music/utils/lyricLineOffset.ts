/**
 * 歌词单行时间偏移（Hydrogen utils/lyricLineOffset.js 的 React 适配版）。
 *
 * 用途：歌词行右键菜单「提前/延后 0.5 秒/重置」，修正个别行不同步。
 * 偏移按「歌曲 key + 行 key」存入 store（localStorage 持久化），应用时
 * 以原时间截去偏移得到显示时间，并强制单调（防止偏移导致行序倒乱）。
 *
 * 版本差异：Hydrogen 存在 playerStore.pick 持久化，本项目改用 localStorage。
 */
import type { LyricLine } from './lrc'

/** 右键菜单单次步长（秒） */
export const LYRIC_LINE_OFFSET_STEP_SEC = 0.5

/** 本地持久化 key */
const OFFSET_STORE_STORAGE_KEY = 'zviewer:lyricLineOffsets'
/** 偏移精度（毫秒级四舍五入） */
const OFFSET_PRECISION = 1000

/** 偏移仓库结构：{ [songKey]: { [lineKey]: offsetSec } } */
export type LyricLineOffsetStore = Record<string, Record<string, number>>

function normalizeText(value: string | undefined | null): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
}

function roundSeconds(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * OFFSET_PRECISION) / OFFSET_PRECISION
}

export function normalizeLyricLineOffset(value: number): number {
  const normalized = roundSeconds(value)
  return Math.abs(normalized) < 0.001 ? 0 : normalized
}

/** 歌曲 key：NCM 歌曲 `song:<songId>` */
export function getLyricOffsetSongKey(songId: number | null | undefined) {
  return songId != null && songId > 0 ? `song:${songId}` : ''
}

/** 行 key：原时间(ms) + 三轨文本去空格序列化；重复行加 #n 后缀 */
function getLineKey(row: LyricLine, seenKeys: Map<string, number>): string {
  const originalTime = Number(row.lyricLineOriginalTime ?? row.time ?? 0)
  const timeMs = Math.max(0, Math.round(originalTime * 1000))
  const baseKey = JSON.stringify([
    timeMs,
    normalizeText(row.text),
    normalizeText(row.translation),
    normalizeText(row.roman),
  ])
  const count = seenKeys.get(baseKey) || 0
  seenKeys.set(baseKey, count + 1)
  return count === 0 ? baseKey : `${baseKey}#${count}`
}

function getSongOffsets(offsetStore: LyricLineOffsetStore, songKey: string) {
  if (!offsetStore || !songKey) return {}
  const songOffsets = offsetStore[songKey]
  return songOffsets && typeof songOffsets === 'object' ? songOffsets : {}
}

/** 当前行已展示的偏移 = 原时间 − 当前时间 */
export function getDisplayedLyricLineOffset(row: LyricLine): number {
  const originalTime = Number(row.lyricLineOriginalTime ?? row.time)
  const currentTime = Number(row.time)
  if (!Number.isFinite(originalTime) || !Number.isFinite(currentTime)) return 0
  return normalizeLyricLineOffset(originalTime - currentTime)
}

/** 菜单当前偏移文案 */
export function formatLyricLineOffset(offsetSec: number): string {
  const offset = normalizeLyricLineOffset(offsetSec)
  if (offset === 0) return '无偏移'
  const absValue = Math.abs(offset).toFixed(1)
  return offset > 0 ? `提前 ${absValue} 秒` : `延后 ${absValue} 秒`
}

/** 偏移仓库更新：offset 归零则删除该行，songs 空则整体删除 */
export function buildNextLyricLineOffsetStore(
  offsetStore: LyricLineOffsetStore,
  songKey: string,
  lineKey: string,
  offsetSec: number
): LyricLineOffsetStore {
  if (!songKey || !lineKey) return offsetStore || {}
  const nextStore: LyricLineOffsetStore = { ...offsetStore }
  const nextSongOffsets: Record<string, number> = {
    ...(nextStore[songKey] ?? {}),
  }
  const normalizedOffset = normalizeLyricLineOffset(offsetSec)
  if (normalizedOffset === 0) {
    delete nextSongOffsets[lineKey]
  } else {
    nextSongOffsets[lineKey] = normalizedOffset
  }
  if (Object.keys(nextSongOffsets).length === 0) {
    delete nextStore[songKey]
  } else {
    nextStore[songKey] = nextSongOffsets
  }
  return nextStore
}

/**
 * 应用偏移到歌词时间轴：每行计算 lineKey 与命中的偏移，
 * 显示时间 = 原时间 − 偏移（clamp ≥0），并强制单调递增防止行序倒乱。
 */
export function applyLyricLineOffsets(
  timeline: LyricLine[],
  offsetStore: LyricLineOffsetStore,
  songKey: string
): LyricLine[] {
  if (!Array.isArray(timeline)) return timeline
  const songOffsets = getSongOffsets(offsetStore, songKey)
  const seenKeys = new Map<string, number>()
  const rows = timeline.map((row) => {
    const originalTime = roundSeconds(row.time ?? 0)
    const lyricLineKey = getLineKey(
      { ...row, lyricLineOriginalTime: originalTime },
      seenKeys
    )
    const lyricLineOffsetSec = normalizeLyricLineOffset(
      songOffsets[lyricLineKey] ?? 0
    )
    return {
      ...row,
      lyricLineOriginalTime: originalTime,
      lyricLineKey,
      lyricLineOffsetSec,
    }
  })

  const adjustedTimes = rows.map((row) =>
    Math.max(
      0,
      roundSeconds(row.lyricLineOriginalTime - row.lyricLineOffsetSec)
    )
  )
  for (let index = 1; index < adjustedTimes.length; index++) {
    if (adjustedTimes[index] < adjustedTimes[index - 1]) {
      adjustedTimes[index] = adjustedTimes[index - 1]
    }
  }

  return rows.map((row, index) => ({
    ...row,
    time: adjustedTimes[index],
  }))
}

/** 读取持久化的偏移仓库 */
export function loadLyricLineOffsetStore(): LyricLineOffsetStore {
  try {
    const raw = localStorage.getItem(OFFSET_STORE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as LyricLineOffsetStore
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {
    // 损坏数据静默清空
  }
  return {}
}

/** 写入持久化的偏移仓库 */
export function saveLyricLineOffsetStore(store: LyricLineOffsetStore) {
  try {
    localStorage.setItem(OFFSET_STORE_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 配额/隐私模式静默失败
  }
}
