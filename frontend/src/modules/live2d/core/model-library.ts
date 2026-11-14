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
}

export interface Live2DLibraryList {
  models: Live2DLibraryEntry[]
  /** 我能不能往库里上传 */
  canManage: boolean
}

const EMPTY: Live2DLibraryList = { models: [], canManage: false }

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
  }
}

/** 读取模型库清单。失败一律返回空清单：面板照常可用，不阻塞房间。 */
export async function loadLibraryModels(): Promise<Live2DLibraryList> {
  try {
    const res = await apiFetch('/api/live2d/models')
    if (!res.ok) return EMPTY
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
    return { models, canManage: data.canManage === true }
  } catch {
    return EMPTY
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
