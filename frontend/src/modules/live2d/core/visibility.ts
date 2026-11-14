import type { Live2DModelKind } from '../types'

// 「我要不要显示角色」的口径。
//
// 这块以前靠一个持久化的布尔 `hidden` 撑着，于是出现了三类互相打架的情况：
//   1. 隐藏时顺手把 `myModelId` 清空了，「显示」就再也变不回原来那个模型；
//   2. 布尔不分房间，在 A 房隐藏之后进 B 房也没有角色，而且关掉浏览器还在；
//   3. 房主一开「统一角色」，模型又冒出来了，但 `hidden` 仍为 true，
//      房主一关统一，角色立刻又没了。
//
// 现在把"隐藏"当成一条**带房间号的记录**：隐藏不改我的选择，只让"生效模型"
// 暂时为空。于是恢复就是丢掉这条记录，选择原样还在。

/** 一次「我在这个房间隐藏了自己的角色」的记录。 */
export interface Live2DHidden {
  /** 在哪个房间隐藏的：换房间不继承（否则进新房间会毫无理由地没有角色）。 */
  roomId: string
  /**
   * 隐藏那一刻用的是哪个模型。
   *
   * 恢复**不依赖**它（真正生效的是 `myModelId`，用户隐藏期间改了选择也该按
   * 新的算）。存下来有两个用处：面板上能说出"你隐藏的是什么"，以及模型被
   * 删除时能认出隐藏记录指向的正是那个已经没了的模型。
   */
  kind: Live2DModelKind
  modelId: string
}

/** 当前实际应该画、应该声明的模型。 */
export interface EffectiveLive2DModel {
  kind: Live2DModelKind
  /** 空串表示此刻不显示角色（隐藏中，或者还没选过模型）。 */
  modelId: string
  /** 房主已统一角色（此时模型由房间决定，本机选择不生效）。 */
  unified: boolean
  /** 本房间隐藏中。统一角色生效时恒为 false（见下）。 */
  hidden: boolean
}

export interface EffectiveLive2DInput {
  roomId: string
  unified: boolean
  unifiedKind?: Live2DModelKind
  unifiedId?: string
  myKind: Live2DModelKind
  myModelId: string
  hidden: Live2DHidden | null
}

/**
 * 解算「我现在用的是哪个模型」。
 *
 * 优先级是**统一角色 > 个人隐藏 > 个人选择**：统一角色是房主给整个房间定的
 * 规矩，个人隐藏是个人偏好，房主强行统一时个人偏好让位——否则房主自己都
 * 看不到统一的效果。
 *
 * 让位的只是"当下生效"这一层：返回值里 `hidden` 是 false，调用方据此把那条
 * 隐藏记录清掉。这正是修复「关掉统一角色后我的角色又消失了」的地方。
 */
export function resolveEffectiveModel(
  input: EffectiveLive2DInput
): EffectiveLive2DModel {
  const isHiddenHere =
    input.hidden !== null && input.hidden.roomId === input.roomId

  if (input.unified && input.unifiedId) {
    return {
      kind: input.unifiedKind ?? 'builtin',
      modelId: input.unifiedId,
      unified: true,
      // 统一角色之下没有"隐藏"这回事：全房间都长一样，只剩自己不在画面里，
      // 看起来像 bug 而不是设置。
      hidden: false,
    }
  }

  return {
    kind: input.myKind,
    modelId: isHiddenHere ? '' : input.myModelId,
    unified: false,
    hidden: isHiddenHere,
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
 */
export function pickVisiblePeers<T>(
  peers: readonly T[],
  localSid: string,
  max: number,
  sidOf: (item: T) => string
): T[] {
  if (max <= 0) return []
  if (peers.length <= max) return peers.slice()
  const list = peers.slice(0, max)
  if (!localSid) return list
  const myIndex = peers.findIndex((p) => sidOf(p) === localSid)
  // 已经在裁剪范围内，或者根本不在名册里（没选模型/隐藏中）：不用动
  if (myIndex < 0 || myIndex < max) return list
  list[max - 1] = peers[myIndex]
  return list
}
