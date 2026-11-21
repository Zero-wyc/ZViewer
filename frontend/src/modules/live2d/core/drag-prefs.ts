import type { Live2DModelKind } from '../types.ts'
import { clampDragOffset, type DragOffset } from './drag.ts'

// 「我把角色拖到哪儿了」是本机习惯，不是房间状态。
//
// 位置现在**完全本地**：不同步给任何人，也不从名册读。所以这份记录就是唯一
// 的记忆——每次进房都回到默认槽位、人人重拖一遍的体验全靠它避免。
//
// **键必须是 modelId 而不是全局一个值**：不同模型的包围盒差很多，同一个偏移
// 对高模型是"往下挪一点"，对矮模型就是"整只出画"。大小（scale）也不必进键——
// 偏移被 clamp 在比例区间里，换大小后顶多需要再微调，比"换大小就丢位置"好。
//
// 允许记「完全看不见」的位置（用户可能故意把角色让开画面）：读取时只做防手滑
// 的上限夹取，不做可见性修正。

const STORAGE_KEY = 'zviewer.live2d.drag-prefs'

/** 最多记这么多个模型：够用，也不至于让 localStorage 无限增长。 */
const MAX_ENTRIES = 24

/**
 * 每个模型两条数值：横向/纵向偏移。
 *
 * 曾经还存过「显示区域裁剪」（top/bottom），2026-11-21 随裁剪功能一起删掉：
 * 那条路径会在 WebGL 上打 scissor 补丁，实测会让 Live2D 卡死。旧记录里多出来
 * 的 top/bottom 字段读的时候直接忽略，下次保存自然就没了。
 */
type PrefEntry = DragOffset

type PrefMap = Record<string, PrefEntry>

/**
 * 存储的最小接口。
 *
 * 不直接摸 `localStorage` 有两个原因：单测跑在 node 里没有这个全局；
 * 隐私模式下访问它会抛异常，而"记不住位置"绝不该影响拖拽本身。
 */
export interface DragPrefStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): DragPrefStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** kind 一起进键：两条来源里同名的模型是不同的东西。 */
function prefKey(kind: Live2DModelKind, modelId: string): string {
  return `${kind}:${modelId}`
}

function readAll(storage: DragPrefStorage): PrefMap {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: PrefMap = {}
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (!value || typeof value !== 'object') continue
      const { x, y } = value as { x?: unknown; y?: unknown }
      if (typeof x !== 'number' || typeof y !== 'number') continue
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      // 旧版本可能写过超出范围的数，读的时候再夹一次
      out[key] = clampDragOffset(x, y)
    }
    return out
  } catch {
    return {}
  }
}

function writeAll(storage: DragPrefStorage, map: PrefMap): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 配额满 / 隐私模式：记不住就算了
  }
}

/** 读取某模型的偏移；没记过（或记的是原点）时返回 null。 */
export function loadDragPref(
  kind: Live2DModelKind,
  modelId: string,
  storage: DragPrefStorage | null = defaultStorage()
): DragOffset | null {
  if (!storage || !modelId) return null
  const value = readAll(storage)[prefKey(kind, modelId)]
  if (!value) return null
  if (Math.abs(value.x) < 1e-4 && Math.abs(value.y) < 1e-4) return null
  return { x: value.x, y: value.y }
}

/** 记下某模型的偏移（拖拽松手时调用）。 */
export function saveDragPref(
  kind: Live2DModelKind,
  modelId: string,
  x: number,
  y: number,
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage || !modelId) return
  const key = prefKey(kind, modelId)
  const map = readAll(storage)
  // 先删再写：对象保持插入顺序，"最近用过的排最后"就够做淘汰了，
  // 不必再存一个时间戳。
  delete map[key]
  map[key] = clampDragOffset(x, y)
  const keys = Object.keys(map)
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[stale]
    }
  }
  writeAll(storage, map)
}

/** 忘掉某模型的偏移（「回到原位」时调用）。 */
export function clearDragPref(
  kind: Live2DModelKind,
  modelId: string,
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage || !modelId) return
  const map = readAll(storage)
  const key = prefKey(kind, modelId)
  if (!(key in map)) return
  delete map[key]
  writeAll(storage, map)
}

/**
 * 忘掉**所有**模型的偏移（「重置模型位置」时调用）。
 *
 * 为什么必须一次清全部：位置是按模型记的，只清当前这个，用户切一次模型就会
 * 撞回上一个模型的旧站位——而那个位置可能就在画面外。按钮的语义是「把我的
 * 角色放回默认站位」，不是「把当前这一个放回去」。
 */
export function clearAllDragPrefs(
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage) return
  writeAll(storage, {})
}
