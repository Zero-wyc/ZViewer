// 「别人的角色多大」是本机偏好，不进房间状态。
//
// 以前缩放跟着名册走：一个人拖滑杆会改掉所有人屏幕上他的大小。可每人窗口尺寸、
// 观看距离都不同，想要的大小本来就不一样；而且那套同步的代价很高——滑杆每个
// 中间值都要上行一次 `live2d-config`，服务端把该成员标成「新成员」、全房间广播
// 一整行 add、再给本人回一份全量快照。
//
// 现在缩放完全是本地的：自己的存在 store（`myScale`），别人的存在这里。
//
// **按显示名记账**：sid 是连接级的，重连就换一个，记不住任何人；而「给这个人
// 的角色调大一点」恰恰是跨会话的观感偏好。同名会共用一份——房间里的显示名本来
// 就是要给人区分的，重名时表现一致也好过完全记不住。没有名字（极端情况）退回
// sid，只在本通连接内有效。

/**
 * 缩放范围，与滑杆一致。
 *
 * 上限从 2 提到 3：2 倍时模型高度是视口高的 84%，但很多皮（官方 Haru 那种
 * 全身模型）在这个尺寸下依然只是"一个小人"。用户要的「半身像」得放到超出
 * 画面底部，让下半身自然被裁掉——那需要 3 倍的余量。
 *
 * 下限保持 0.5：人多时一排站六个人，还得能缩下去。
 */
export const PEER_SCALE_MIN = 0.5
export const PEER_SCALE_MAX = 3

const STORAGE_KEY = 'zviewer.live2d.peer-scales'

/** 最多记这么多人：够一屋子，也不至于让 localStorage 无限增长。 */
const MAX_ENTRIES = 64

/**
 * 存储的最小接口。
 *
 * 不直接摸 `localStorage`：单测跑在 node 里没有这个全局；隐私模式下访问它会
 * 抛异常，而「记不住别人多大」绝不该影响渲染。
 */
export interface PeerScaleStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

type ScaleMap = Record<string, number>

function defaultStorage(): PeerScaleStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/**
 * 解析结果的缓存。
 *
 * 渲染器每帧、每个成员都要问一次「他该多大」，每次都 JSON.parse 一遍
 * localStorage 是不可接受的（6 个模型 × 60fps）。缓存按**存储对象身份**建：
 * 换一个 storage（单测里的假对象、隐私模式下的 localStorage）就重新读。
 */
let memo: { storage: PeerScaleStorage; map: ScaleMap } | null = null

function readMap(storage: PeerScaleStorage | null): ScaleMap {
  if (!storage) return {}
  if (memo && memo.storage === storage) return memo.map
  let map: ScaleMap = {}
  try {
    const raw = storage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(
        parsed as Record<string, unknown>
      )) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        map[key] = clampScale(value)
      }
    }
  } catch {
    map = {}
  }
  memo = { storage, map }
  return map
}

function writeMap(storage: PeerScaleStorage, map: ScaleMap): void {
  // 先写缓存：写盘失败（配额满 / 隐私模式）时，本次会话里的观感仍然生效
  memo = { storage, map }
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // 记不住就算了
  }
}

function clampScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.min(PEER_SCALE_MAX, Math.max(PEER_SCALE_MIN, value))
}

/** 记账用的键：显示名优先，没有名字退回 sid（那份只在本连接内有效）。 */
export function peerScaleKey(name: string, sid: string): string {
  const trimmed = name.trim()
  return trimmed || `sid:${sid}`
}

/** 读取某人的缩放；没调过返回 null（调用方按 1 处理）。 */
export function peerScaleOf(
  name: string,
  sid: string,
  storage: PeerScaleStorage | null = defaultStorage()
): number | null {
  if (!sid && !name) return null
  const found = readMap(storage)[peerScaleKey(name, sid)]
  return found === undefined ? null : found
}

/** 记下某人的缩放（滑杆每动一档都会调）。 */
export function setPeerScale(
  name: string,
  sid: string,
  scale: number,
  storage: PeerScaleStorage | null = defaultStorage()
): void {
  if (!storage || (!sid && !name)) return
  const key = peerScaleKey(name, sid)
  const map = { ...readMap(storage) }
  // 先删再写：对象保持插入顺序，「最近调过的排最后」就够做淘汰了
  delete map[key]
  map[key] = clampScale(scale)
  const keys = Object.keys(map)
  if (keys.length > MAX_ENTRIES) {
    for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[stale]
    }
  }
  writeMap(storage, map)
}

/** 忘掉所有人的缩放（「重置」用）。 */
export function clearPeerScales(
  storage: PeerScaleStorage | null = defaultStorage()
): void {
  if (!storage) return
  // 先走一次 readMap：没读过的时候 memo 是空的，直接判空会把盘上的数据留下
  if (Object.keys(readMap(storage)).length === 0) return
  writeMap(storage, {})
}
