import type { Live2DModelKind } from '../types'

// 「我要不要显示角色」的口径。
//
// 这块的演化史值得留一笔，因为每次都是同一类错误：
//   1. 最早是一个持久化布尔 `hidden`，隐藏时顺手清空 `myModelId`，
//      于是「显示」再也变不回原来那个模型；
//   2. 改成带 roomId 的记录之后，又出现「藏了又冒出来、显示了回不去、
//      换房还在藏」——因为"临时隐藏"和"删掉角色"两种意图被塞进了同一个
//      字段，恢复路径要同时满足一堆互相矛盾的条件。
//
// 现在只保留**一种**意图：**删除角色**。语义接近「把这个角色撤掉」而不是
// 「暂时藏起来」——删除后不显示，也没有"显示回来"这种动作，想再要有角色
// 就从模型列表里重新选一个（选中即恢复）。
//
// 好处是状态可穷举：有角色 / 没有角色。不再有"记录说藏了、统一角色又说
// 显示"这种三方角力的中间态。

/** 当前实际应该画、应该声明的模型。 */
export interface EffectiveLive2DModel {
  kind: Live2DModelKind
  /** 空串表示此刻不显示角色（已删除，或者还没选过模型）。 */
  modelId: string
  /** 房主已统一角色（此时模型由房间决定，本机选择不生效）。 */
  unified: boolean
  /**
   * 我已删除自己的角色。
   *
   * 统一角色期间恒为 false：房间统一时模型由房主决定，个人的删除偏好让位
   * （否则房主自己也看不到统一效果）。让位的只是"当下生效"这一层——
   * 删除标记本身不动，房主关掉统一之后我仍然是"没有角色"，这才是用户的
   * 意思。
   */
  removed: boolean
}

export interface EffectiveLive2DInput {
  unified: boolean
  unifiedKind?: Live2DModelKind
  unifiedId?: string
  myKind: Live2DModelKind
  myModelId: string
  /** 我已删除自己的角色（本机偏好，不分房间、重启仍在） */
  removed: boolean
}

/**
 * 解算「我现在用的是哪个模型」。
 *
 * 优先级是**统一角色 > 个人删除 > 个人选择**：统一角色是房主给整个房间定的
 * 规矩，个人删除是个人偏好，房主强行统一时个人偏好让位。
 */
export function resolveEffectiveModel(
  input: EffectiveLive2DInput
): EffectiveLive2DModel {
  if (input.unified && input.unifiedId) {
    return {
      kind: input.unifiedKind ?? 'builtin',
      modelId: input.unifiedId,
      unified: true,
      removed: false,
    }
  }

  return {
    kind: input.myKind,
    modelId: input.removed ? '' : input.myModelId,
    unified: false,
    removed: input.removed,
  }
}

/**
 * 挑出这一端真正要画的成员。
 *
 * 名册可以到 12 人，但同屏只画 6 个——再多 GPU 和下行都顶不住。裁剪规则本身
 * 很简单（按 ord 取前 N），要命的是**自己可能落在第 N 名之后**：这时画面上
 * 完全没有我的角色，没有任何提示，也不影响别人，用户只会觉得"我的角色时有时
 * 无"。所以自己必须占一个名额。
 *
 * 用"替换最后一个"而不是"追加"：总数保持不变，槽位仍然铺满整条底边。
 * 代价是各端渲染的集合可能不同（我看到的第 6 个是别人，别人看到的第 6 个是
 * 我），站位会略有差异——但这比"看不见自己"轻得多，而且每个观众本来就只
 * 看自己这一屏。
 *
 * 另外这里**按 sid 去重**：一个用户在一屏上只能有一个角色。服务端名册按
 * socket 唯一，正常不会有重复；但重连窗口里（旧连接还没被清理、新连接已经
 * 声明）同一人会有两条记录——渲染出来就是"同一个人站在两个位置"，而
 * `visible` 同时还是 DOM 标签的渲染源，重复会让标签也画两份。去重放在这个
 * 唯一入口，标签与画面就不会各说各话。
 */
export function pickVisiblePeers<T>(
  peers: readonly T[],
  localSid: string,
  max: number,
  sidOf: (item: T) => string
): T[] {
  if (max <= 0) return []
  const unique = dedupeBySid(peers, sidOf)
  if (unique.length <= max) return unique
  const list = unique.slice(0, max)
  if (!localSid) return list
  const myIndex = unique.findIndex((p) => sidOf(p) === localSid)
  // 已经在裁剪范围内，或者根本不在名册里（角色已删除）：不用动
  if (myIndex < 0 || myIndex < max) return list
  list[max - 1] = unique[myIndex]
  return list
}

/** 同一 sid 只保留第一条（名册已按 ord 排序，第一条就是最早占位的那个）。 */
function dedupeBySid<T>(peers: readonly T[], sidOf: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const peer of peers) {
    const sid = sidOf(peer)
    if (!sid || seen.has(sid)) continue
    seen.add(sid)
    out.push(peer)
  }
  return out
}
