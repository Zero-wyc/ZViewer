// 从 model3.json 里读表情与动作清单。
//
// 为什么要单独读一次 JSON，而不是问渲染引擎：引擎要等 Cubism Core 加载完、
// 模型实例建好才有 internalModel，而面板需要在「模型还在加载」时就能显示
// 可点的表情/动作按钮。model3.json 本身很小（几 KB），带缓存，代价可以忽略。
//
// 表情按**下标**寻址：同一份 model3.json 在各端解析出的顺序一致，而
// 表情名在导出时经常是空串或重名（官方素材也这样）。动作按**组名+下标**
// 寻址，组名由 Cubism 引擎使用，必须原样传回去。

import { parseMotionGroups, type ModelMotionGroup } from './motion-pick.ts'

export type { ModelMotionGroup }

export interface ModelExpressionEntry {
  index: number
  /** 模型声明的名字，可能是空串（官方素材常见）；显示时由调用方兜底 */
  name: string
}

export interface ModelMeta {
  expressions: ModelExpressionEntry[]
  /** 可展示的动作组（已排除待机）；空数组是常态 */
  motions: ModelMotionGroup[]
}

const EMPTY: ModelMeta = { expressions: [], motions: [] }

const cache = new Map<string, ModelMeta>()
const pending = new Map<string, Promise<ModelMeta>>()

/**
 * 读一次模型清单（表情 + 动作，共用同一次请求）。
 *
 * 读不到就返回空清单（不抛）：没有表情/动作的模型是常态，不该阻塞面板。
 */
export function loadModelMeta(url: string): Promise<ModelMeta> {
  if (!url) return Promise.resolve(EMPTY)
  const cached = cache.get(url)
  if (cached) return Promise.resolve(cached)
  const inFlight = pending.get(url)
  if (inFlight) return inFlight

  const task = fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown) => {
      const meta: ModelMeta = {
        expressions: parseExpressions(json),
        motions: parseMotionGroups(json),
      }
      cache.set(url, meta)
      return meta
    })
    .catch(() => {
      // 失败也缓存：地址坏掉时反复重试只会刷控制台
      cache.set(url, EMPTY)
      return EMPTY
    })
    .finally(() => {
      pending.delete(url)
    })
  pending.set(url, task)
  return task
}

/** 只要表情时的薄封装（历史调用点用）。 */
export function loadModelExpressions(
  url: string
): Promise<ModelExpressionEntry[]> {
  return loadModelMeta(url).then((meta) => meta.expressions)
}

/**
 * 解析表情清单。导出出来是为了单测：这一段是纯函数，不碰网络也不碰 i18n
 * （「表情 N」的兜底文案放在渲染期，见 Live2DContextMenu）。
 */
export function parseExpressions(json: unknown): ModelExpressionEntry[] {
  const refs = (json as { FileReferences?: { Expressions?: unknown } } | null)
    ?.FileReferences
  const list = refs?.Expressions
  if (!Array.isArray(list)) return []
  const out: ModelExpressionEntry[] = []
  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i] as { Name?: unknown } | null
    const name = typeof raw?.Name === 'string' ? raw.Name.trim() : ''
    out.push({ index: i, name })
  }
  return out
}

/** 测试/热更新用：清掉缓存。 */
export function resetModelExpressionsCache(): void {
  cache.clear()
  pending.clear()
}
