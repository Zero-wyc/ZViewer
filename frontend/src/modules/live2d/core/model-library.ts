import { apiFetch } from '@/lib/api'
import { t } from '@/i18n'

// 服务端公共模型库的读写（后端 internal/api/live2d_models.go）。
//
// 「公共」是字面意思：模型不属于任何房间，任何登录用户传上去的模型，全服务端
// 所有房间都能选。所以这里的接口**没有 roomId**，地址规则也与房间无关
// （见 core/model-url.ts#resolveModelUrl 的 'room' 分支）。
//
// 写权限：上传=任何登录用户，删除=本人或管理员；列表对含游客在内的所有
// 登录者开放（观众也要加载别人选的模型）。服务端把「这一条我能不能删」
// 算好放在 deletable 里，前端不重复实现归属规则。

export interface Live2DLibraryEntry {
  id: string
  label: string
  bytes: number
  createdAt: string
  /** 服务端判定的「我能删这一条」 */
  deletable: boolean
  /**
   * 服务端有没有这个模型的缩略图（取第一张贴图缩到 160px）。
   *
   * 由服务端判而不是「总是请求图片再靠 onError 兜底」：没有缩略图是常态
   * （加密贴图、纯 MOC3 模型），每次打开面板都打一圈 404 只是噪音。
   */
  hasThumb: boolean
}

/** 模型缩略图地址。只在 hasThumb 为真时用。 */
export function libraryModelThumbUrl(id: string): string {
  return `/uploads/live2d/${encodeURIComponent(id)}/__thumb.png`
}

export interface Live2DLibraryList {
  models: Live2DLibraryEntry[]
  /** 我能不能往库里上传 */
  canManage: boolean
  /**
   * 加载失败的原因；空串 = 成功（**清单为空也算成功**）。
   *
   * 必须把这两种情况分开：以前失败一律返回空清单，界面看起来就是"一个模型
   * 都没有"，用户只能怀疑自己的模型被删了、然后重新上传一遍（反馈原话：
   * "刷新后模型就不见了，点什么都没有，必须重新上传"）。空清单与加载失败
   * 要用两张完全不同的脸对着用户。
   */
  error: string
}

/**
 * 上传配额，与服务端 internal/api/live2d_models.go 的
 * live2dMaxModelsPerOwner / live2dMaxModelsTotal 是同一组值。
 *
 * 这里只是**提示**用的：真正的拒绝发生在服务端（超了会返回具体原因）。
 * 改一处必须同步另一处，否则界面会承诺一个实际做不到的数量。
 */
export const LIVE2D_LIBRARY_MAX_PER_OWNER = 8
export const LIVE2D_LIBRARY_MAX_TOTAL = 64

function normalizeEntry(raw: unknown): Live2DLibraryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : ''
  if (!id) return null
  return {
    id,
    label: typeof item.label === 'string' && item.label ? item.label : id,
    bytes: typeof item.bytes === 'number' ? item.bytes : 0,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
    deletable: item.deletable === true,
    hasThumb: item.hasThumb === true,
  }
}

/** 读取模型库清单。失败时带上原因，由界面区分「空库」与「没拉到」。 */
export async function loadLibraryModels(): Promise<Live2DLibraryList> {
  try {
    const res = await apiFetch('/api/live2d/models')
    if (!res.ok) {
      // 后端拒绝时会说明原因（未登录、权限），比前端猜的准
      const data = (await res.json().catch(() => null)) as {
        message?: unknown
      } | null
      const reason = typeof data?.message === 'string' ? data.message : ''
      return {
        models: [],
        canManage: false,
        error: reason || t('模型库加载失败'),
      }
    }
    const data = (await res.json()) as {
      models?: unknown
      canManage?: unknown
    }
    const models: Live2DLibraryEntry[] = []
    if (Array.isArray(data.models)) {
      for (const raw of data.models) {
        const entry = normalizeEntry(raw)
        if (entry) models.push(entry)
      }
    }
    return { models, canManage: data.canManage === true, error: '' }
  } catch {
    return { models: [], canManage: false, error: t('模型库加载失败') }
  }
}

export interface LibraryModelResult {
  ok: boolean
  message: string
  model?: Live2DLibraryEntry
}

/** 上传模型压缩包。错误文案直接用后端返回的那句（它比前端猜的更准确）。 */
export async function uploadLibraryModel(
  file: File
): Promise<LibraryModelResult> {
  const body = new FormData()
  body.append('file', file)
  try {
    const res = await apiFetch('/api/live2d/models', {
      method: 'POST',
      body,
    })
    const data = (await res.json().catch(() => null)) as {
      message?: unknown
      model?: unknown
    } | null
    const message = typeof data?.message === 'string' ? data.message : ''
    if (!res.ok) return { ok: false, message: message || t('上传失败') }
    return {
      ok: true,
      message: message || t('模型已上传'),
      model: normalizeEntry(data?.model) ?? undefined,
    }
  } catch {
    return { ok: false, message: t('上传失败') }
  }
}

/**
 * 从链接导入模型包。
 *
 * 前端只做「非空」这一层：能不能下、是不是 zip、包里的引用全不全，全在服务端
 * 判（那边还有 SSRF 闸门）。把判断拆成两处只会出现「前端说可以、后端说不行」。
 */
export async function importLibraryModel(
  url: string
): Promise<LibraryModelResult> {
  try {
    const res = await apiFetch('/api/live2d/models/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url.trim() }),
    })
    const data = (await res.json().catch(() => null)) as {
      message?: unknown
      model?: unknown
    } | null
    const message = typeof data?.message === 'string' ? data.message : ''
    if (!res.ok) return { ok: false, message: message || t('导入失败') }
    return {
      ok: true,
      message: message || t('模型已导入'),
      model: normalizeEntry(data?.model) ?? undefined,
    }
  } catch {
    return { ok: false, message: t('导入失败') }
  }
}

export async function deleteLibraryModel(
  modelId: string
): Promise<LibraryModelResult> {
  try {
    const res = await apiFetch(
      `/api/live2d/models/${encodeURIComponent(modelId)}`,
      { method: 'DELETE' }
    )
    const data = (await res.json().catch(() => null)) as {
      message?: unknown
    } | null
    const message = typeof data?.message === 'string' ? data.message : ''
    if (!res.ok) return { ok: false, message: message || t('删除失败') }
    return { ok: true, message: message || t('模型已删除') }
  } catch {
    return { ok: false, message: t('删除失败') }
  }
}

/** 压缩包上限，与后端 live2dUploadMaxBytes 一致。 */
// 48MB 曾是「4K 贴图也够」的估计，但实测一个 4096 导出的成品皮压完 47MB，
// 几乎是踩着线过；96MB 才留出余量。
export const LIVE2D_UPLOAD_MAX_BYTES = 96 << 20
