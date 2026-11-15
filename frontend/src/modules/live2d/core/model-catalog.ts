// 内置模型清单。
//
// 清单是运行期从 /live2d/models/index.json 读的，不是写死的数组：模型素材
// 体积大、授权各不相同，放在 public 里由部署方决定带哪几个，代码不用跟着改。
// 文件形状：
//   { "models": [{ "id": "hiyori", "label": "日和", "thumb": "preview.png" }] }
// 目录约定：/live2d/models/<id>/<id>.model3.json
// `thumb` 可选，是模型目录里的预览图（相对文件名）。内置模型是前端静态
// 资源，服务端不接管它们，也就没法像模型库那样自动从贴图生成缩略图——
// 部署方想在选择器里看到画面，就自己放一张并在清单里登记。

export interface Live2DModelEntry {
  id: string
  label: string
  /** 预览图地址（由清单里的 thumb 拼出）；没有则选择器画首字方块 */
  thumb?: string
}

/**
 * 把清单里的 thumb 拼成可用的地址。
 *
 * 只接受模型目录内的相对文件名：清单文件是部署方手写的，一个 `../` 就能
 * 让它指向别的目录。拒绝时返回空串，界面上退回首字方块。
 */
function builtinThumbUrl(id: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (!name || name.length > 128) return undefined
  // 只认模型目录里的文件名：清单是部署方手写的，`../` 或绝对路径能把请求
  // 指到别处。反斜杠不必单独拦——拼出来的是 URL，不会被当成本地路径。
  if (name.startsWith('/') || name.includes('/') || name.includes('..')) {
    return undefined
  }
  return `/live2d/models/${encodeURIComponent(id)}/${encodeURIComponent(name)}`
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
          const thumb = builtinThumbUrl(
            id,
            (item as { thumb?: unknown })?.thumb
          )
          out.push({
            id,
            label: typeof label === 'string' && label ? label : id,
            thumb,
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
