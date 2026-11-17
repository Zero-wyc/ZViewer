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
 * 显示区域的裁剪比例（相对模型当前包围盒，0 在上、1 在下）。
 *
 * 和位置一起按模型记：同一个「裁到腰」的比例，对高模型是腰、对矮模型是胸，
 * 但用户换模型后重新裁一次的成本，远低于一个全局比例带来的"看起来没生效"。
 */
export interface CropPref {
  top: number
  bottom: number
}

/** 至少留这么多高度，避免拖成一条线之后再也拖不回来。 */
export const CROP_MIN_SPAN = 0.15

interface PrefEntry extends DragOffset {
  top: number
  bottom: number
}

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
      const { x, y, top, bottom } = value as {
        x?: unknown
        y?: unknown
        top?: unknown
        bottom?: unknown
      }
      if (typeof x !== 'number' || typeof y !== 'number') continue
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      // 旧版本可能写过超出范围的数，读的时候再夹一次
      const offset = clampDragOffset(x, y)
      const crop = clampCrop(top, bottom)
      out[key] = { ...offset, ...crop }
    }
    return out
  } catch {
    return {}
  }
}

/** 把裁剪比例夹到合法区间：0 ≤ top < bottom ≤ 1，且至少留 CROP_MIN_SPAN。 */
export function clampCrop(top: unknown, bottom: unknown): CropPref {
  const t = typeof top === 'number' && Number.isFinite(top) ? top : 0
  const b = typeof bottom === 'number' && Number.isFinite(bottom) ? bottom : 1
  const lo = Math.min(1 - CROP_MIN_SPAN, Math.max(0, Math.min(t, b)))
  const hi = Math.max(CROP_MIN_SPAN, Math.min(1, Math.max(t, b)))
  return { top: lo, bottom: Math.max(lo + CROP_MIN_SPAN, hi) }
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

/** 读取某模型的裁剪比例；没记过、或记的是「全显示」时返回 null。 */
export function loadCropPref(
  kind: Live2DModelKind,
  modelId: string,
  storage: DragPrefStorage | null = defaultStorage()
): CropPref | null {
  if (!storage || !modelId) return null
  const value = readAll(storage)[prefKey(kind, modelId)]
  if (!value) return null
  if (value.top < 1e-4 && value.bottom > 1 - 1e-4) return null
  return { top: value.top, bottom: value.bottom }
}

/** 记下某模型的偏移（拖拽松手时调用）。裁剪比例原样保留。 */
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
  const prev = map[key]
  // 先删再写：对象保持插入顺序，"最近用过的排最后"就够做淘汰了，
  // 不必再存一个时间戳。
  delete map[key]
  map[key] = {
    ...clampDragOffset(x, y),
    top: prev?.top ?? 0,
    bottom: prev?.bottom ?? 1,
  }
  const keys = Object.keys(map)
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[stale]
    }
  }
  writeAll(storage, map)
}

/**
 * 记下某模型的裁剪比例（拖拽模式松手时调用）。
 *
 * 与位置分开两个函数而不是揉成一个：调用点本来就不在一处（拖动是每次 move
 * 都可能落，裁剪只在松手时落），合成一个函数反而要求两边都记着对方的当前值。
 */
export function saveCropPref(
  kind: Live2DModelKind,
  modelId: string,
  crop: CropPref,
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage || !modelId) return
  const key = prefKey(kind, modelId)
  const map = readAll(storage)
  const prev = map[key]
  const clamped = clampCrop(crop.top, crop.bottom)
  delete map[key]
  map[key] = {
    x: prev?.x ?? 0,
    y: prev?.y ?? 0,
    ...clamped,
  }
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
