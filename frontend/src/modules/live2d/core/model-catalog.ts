// 内置模型清单。
//
// 清单是运行期从 /live2d/models/index.json 读的，不是写死的数组：模型素材
// 体积大、授权各不相同，放在 public 里由部署方决定带哪几个，代码不用跟着改。
// 文件形状：
//   { "models": [{ "id": "hiyori", "label": "日和" }] }
// 目录约定：/live2d/models/<id>/<id>.model3.json

export interface Live2DModelEntry {
  id: string
  label: string
}

const MANIFEST_URL = '/live2d/models/index.json'

let cache: Live2DModelEntry[] | null = null
let pending: Promise<Live2DModelEntry[]> | null = null

export function isBuiltinModelId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id)
}

/** 读取内置模型清单；读不到就返回空数组（不抛，房间照常可用）。 */
export function loadBuiltinModels(): Promise<Live2DModelEntry[]> {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  pending = fetch(MANIFEST_URL, { cache: 'force-cache' })
    .then((res) => (res.ok ? res.json() : null))
    .then((data: unknown) => {
      const list = (data as { models?: unknown })?.models
      const out: Live2DModelEntry[] = []
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = (item as { id?: unknown })?.id
          if (typeof id !== 'string' || !isBuiltinModelId(id)) continue
          const label = (item as { label?: unknown })?.label
          out.push({
            id,
            label: typeof label === 'string' && label ? label : id,
          })
        }
      }
      cache = out
      return out
    })
    .catch(() => {
      cache = []
      return cache as Live2DModelEntry[]
    })
    .finally(() => {
      pending = null
    })
  return pending
}

/** 测试/热更新用：清掉缓存。 */
export function resetBuiltinModelsCache(): void {
  cache = null
  pending = null
}
