import type { Live2DModelKind } from '../types.ts'
import { clampDragOffset, type DragOffset } from './drag.ts'

// 「我把某个角色拖到哪儿了」是本机习惯，不是房间状态。
//
// 位置**完全本地**：不同步给任何人，也不从名册读。所以这份记录就是唯一的
// 记忆——每次进房都回到默认槽位、人人重拖一遍的体验全靠它避免。
//
// **按「人」记账，不按模型**（2026-11-22 改）：
//   - 以前是 `kind:modelId`，只有本人会拖，所以一个模型一条够了；
//   - 现在别人的角色也能拖（位置只影响我的画面），按模型记会让「我拖了 A 的
//     Haru」把「我自己的 Haru」一起搬走——模型是共用的，人不是。
// 键的取法与 core/peer-scale 一致：显示名优先，没有名字退回 sid（那份只在本
// 连接内有效）。同名会共用一份——房间里的显示名本来就是给人区分的。
//
// 允许记「完全看不见」的位置（用户可能故意把角色让开画面）：读取时只做防手滑
// 的上限夹取，不做可见性修正。回位靠拖拽模式里的「回到默认」/右键菜单的
// 「回到原位」/角色设置里的「重置模型位置」。

const STORAGE_KEY = 'zviewer.live2d.drag-prefs'

/** 最多记这么多人：够几屋子，也不至于让 localStorage 无限增长。 */
const MAX_ENTRIES = 64

/** 新键前缀。带前缀是为了和老版本 `kind:modelId` 的键共存（迁移用）。 */
const PERSON_PREFIX = 'p:'

/**
 * 每个人的一条记录：横向/纵向偏移。
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

/**
 * 记账用的键。
 *
 * 显示名优先：sid 是连接级的，重连就换一个，记不住任何人；而「把 TA 的角色
 * 挪到旁边」是跨会话的观感偏好。没有名字（极端情况）退回 sid。
 */
export function dragPrefKey(name: string, sid: string): string {
  const trimmed = name.trim()
  return trimmed ? `${PERSON_PREFIX}${trimmed}` : `${PERSON_PREFIX}sid:${sid}`
}

/**
 * 老版本的键：`kind:modelId`。
 *
 * 升级后第一次读到本人记录时，把老键里的偏移迁到按人记账的键上并删掉老键，
 * 免得用户「升级一次角色就跳回槽位」。只在本人身上发生——老版本别人根本
 * 没有可记的位置。
 */
export function legacyDragKey(kind: Live2DModelKind, modelId: string): string {
  return modelId ? `${kind}:${modelId}` : ''
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

/**
 * 读取某人的偏移；没记过（或记的是原点）时返回 null。
 *
 * `legacyKey` 只在本人身上传：老版本按模型记账，首次读到就迁移过来并删掉
 * 老键（不删的话「重置位置」清掉新键后会被老键再次复活）。
 */
export function loadDragPref(
  name: string,
  sid: string,
  legacyKey = '',
  storage: DragPrefStorage | null = defaultStorage()
): DragOffset | null {
  if (!storage || (!sid && !name.trim())) return null
  const map = readAll(storage)
  const key = dragPrefKey(name, sid)
  let value = map[key]
  if (!value && legacyKey && map[legacyKey]) {
    value = map[legacyKey]
    // 迁移：写新键 + 删老键，一次写完
    delete map[legacyKey]
    map[key] = value
    writeAll(storage, map)
  }
  if (!value) return null
  if (Math.abs(value.x) < 1e-4 && Math.abs(value.y) < 1e-4) return null
  return { x: value.x, y: value.y }
}

/** 记下某人的偏移（拖拽松手时调用）。`legacyKey` 有值时顺手清掉老记录。 */
export function saveDragPref(
  name: string,
  sid: string,
  x: number,
  y: number,
  legacyKey = '',
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage || (!sid && !name.trim())) return
  const key = dragPrefKey(name, sid)
  const map = readAll(storage)
  // 先删再写：对象保持插入顺序，"最近用过的排最后"就够做淘汰了，
  // 不必再存一个时间戳。
  delete map[key]
  if (legacyKey) delete map[legacyKey]
  map[key] = clampDragOffset(x, y)
  const keys = Object.keys(map)
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[stale]
    }
  }
  writeAll(storage, map)
}

/** 忘掉某人的偏移（「回到原位」时调用）。 */
export function clearDragPref(
  name: string,
  sid: string,
  legacyKey = '',
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage || (!sid && !name.trim())) return
  const map = readAll(storage)
  const key = dragPrefKey(name, sid)
  let changed = false
  if (key in map) {
    delete map[key]
    changed = true
  }
  if (legacyKey && legacyKey in map) {
    delete map[legacyKey]
    changed = true
  }
  if (changed) writeAll(storage, map)
}

/**
 * 忘掉**所有**人的偏移（拖拽模式的「回到默认」用）。
 *
 * 语义是「把画面上的角色都放回默认站位」：既然现在别人的角色也能拖，
 * 只清自己那一份会让用户以为按钮没生效。
 */
export function clearAllDragPrefs(
  storage: DragPrefStorage | null = defaultStorage()
): void {
  if (!storage) return
  writeAll(storage, {})
}
