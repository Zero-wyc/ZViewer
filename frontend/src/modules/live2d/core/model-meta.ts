// 从 model3.json 里读表情清单。
//
// 为什么要单独读一次 JSON，而不是问渲染引擎：引擎要等 Cubism Core 加载完、
// 模型实例建好才有 internalModel，而面板需要在「模型还在加载」时就能显示
// 可点的表情按钮。model3.json 本身很小（几 KB），带 60s 缓存，代价可以忽略。
//
// 表情按**下标**寻址：同一份 model3.json 在各端解析出的顺序一致，而
// 表情名在导出时经常是空串或重名（官方素材也这样）。

export interface ModelExpressionEntry {
  index: number
  /** 模型声明的名字，可能是空串（官方素材常见）；显示时由调用方兜底 */
  name: string
}

const cache = new Map<string, ModelExpressionEntry[]>()
const pending = new Map<string, Promise<ModelExpressionEntry[]>>()

/** 读不到就返回空数组（不抛）：没有表情的模型是常态，不该阻塞面板。 */
export function loadModelExpressions(
  url: string
): Promise<ModelExpressionEntry[]> {
  if (!url) return Promise.resolve([])
  const cached = cache.get(url)
  if (cached) return Promise.resolve(cached)
  const inFlight = pending.get(url)
  if (inFlight) return inFlight

  const task = fetch(url)
    .then((res) => (res.ok ? res.json() : null))
    .then((json: unknown) => {
      const list = parseExpressions(json)
      cache.set(url, list)
      return list
    })
    .catch(() => {
      // 失败也缓存：地址坏掉时反复重试只会刷控制台
      cache.set(url, [])
      return [] as ModelExpressionEntry[]
    })
    .finally(() => {
      pending.delete(url)
    })
  pending.set(url, task)
  return task
}

/**
 * 解析表情清单。导出出来是为了单测：这一段是纯函数，不碰网络也不碰 i18n
 * （「表情 N」的兜底文案放在渲染期，见 Live2DControlPanel）。
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
