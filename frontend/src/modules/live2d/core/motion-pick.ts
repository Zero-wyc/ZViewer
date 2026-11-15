// 「戳一下」要播哪个动作组。
//
// 由来：戳一戳以前写死播 `tap_body`，而这个名字只有一部分模型导出过——
// 没导出的模型被戳时只剩本地抖动，看着像"戳了没反应"。这里按可用组挑一个：
//
// 顺序是 tap 语义 → flick（很多模型的"被点"就叫这个）→ 任意非待机组。
// 待机组必须排除：Idle 是呼吸循环，被人戳一下却开始待机等于什么都没发生。

/**
 * 判定「这是待机组」。
 *
 * 各家的导出命名不统一（Idle / idle / Idle_01 / idle2），前缀匹配就够；
 * 反而不能用词边界——"Idle_01" 里 e 和 _ 都算词字符，`\b` 不成立。
 */
function isIdleGroup(group: string): boolean {
  return /^idle/i.test(group)
}

function hasMotions(list: unknown): boolean {
  return Array.isArray(list) && list.length > 0
}

/**
 * 从引擎的 motionManager.definitions 里挑一个用于「戳」的组。
 *
 * 入参允许 undefined（模型还没加载完 / 引擎没暴露 definitions），此时返回
 * 空串——调用方只做抖动，不做无意义的重试。
 */
export function pickPokeGroup(
  definitions: Record<string, unknown> | undefined
): string {
  if (!definitions) return ''
  const groups = Object.keys(definitions).filter(
    (group) => hasMotions(definitions[group]) && !isIdleGroup(group)
  )
  if (groups.length === 0) return ''
  const tap = groups.find((group) => /tap/i.test(group))
  if (tap) return tap
  const flick = groups.find((group) => /flick/i.test(group))
  if (flick) return flick
  return groups[0]
}

/**
 * 从 model3.json 的动作清单里挑出「值得做成按钮」的组。
 *
 * 与 pickPokeGroup 的取舍不同：这里是给用户看的列表，排除待机即可，
 * 不做语义猜测——名字原样显示，猜错名字比显示英文更糟。
 */
export interface ModelMotionGroup {
  group: string
  /** 这个组里有几条动作（界面只播第 1 条，数量用于提示） */
  count: number
}

export function parseMotionGroups(json: unknown): ModelMotionGroup[] {
  const refs = (json as { FileReferences?: { Motions?: unknown } } | null)
    ?.FileReferences
  const motions = refs?.Motions
  if (!motions || typeof motions !== 'object' || Array.isArray(motions)) {
    return []
  }
  const out: ModelMotionGroup[] = []
  for (const [group, value] of Object.entries(
    motions as Record<string, unknown>
  )) {
    if (!group || isIdleGroup(group)) continue
    if (!hasMotions(value)) continue
    out.push({ group, count: (value as unknown[]).length })
  }
  return out
}
