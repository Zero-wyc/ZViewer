import { apiFetch } from '@/lib/api'
import { t } from '@/i18n'

// 房间级模型库的读写（后端 internal/api/live2d_models.go）。
//
// 上传与删除只开给房主；列表对所有成员开放——观众也要加载房主传的模型。
// 落盘后入口固定叫 model.model3.json，所以这里的地址规则与
// core/model-url.ts#resolveModelUrl 的 'room' 分支必须保持一致。

export interface RoomModelEntry {
  id: string
  label: string
  bytes: number
  createdAt: string
}

export interface RoomModelList {
  models: RoomModelEntry[]
  canManage: boolean
}

const EMPTY: RoomModelList = { models: [], canManage: false }

function normalizeEntry(raw: unknown): RoomModelEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id : ''
  if (!id) return null
  return {
    id,
    label: typeof item.label === 'string' && item.label ? item.label : id,
    bytes: typeof item.bytes === 'number' ? item.bytes : 0,
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
  }
}

/** 读取房间模型清单。失败一律返回空清单：面板照常可用，不阻塞房间。 */
export async function loadRoomModels(roomId: string): Promise<RoomModelList> {
  if (!roomId) return EMPTY
  try {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/live2d/models`
    )
    if (!res.ok) return EMPTY
    const data = (await res.json()) as {
      models?: unknown
      canManage?: unknown
    }
    const models: RoomModelEntry[] = []
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

export interface RoomModelResult {
  ok: boolean
  message: string
  model?: RoomModelEntry
}

/** 上传模型压缩包。错误文案直接用后端返回的那句（它比前端猜的更准确）。 */
export async function uploadRoomModel(
  roomId: string,
  file: File
): Promise<RoomModelResult> {
  const body = new FormData()
  body.append('file', file)
  try {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/live2d/models`,
      { method: 'POST', body }
    )
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

export async function deleteRoomModel(
  roomId: string,
  modelId: string
): Promise<RoomModelResult> {
  try {
    const res = await apiFetch(
      `/api/rooms/${encodeURIComponent(roomId)}/live2d/models/${encodeURIComponent(modelId)}`,
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
// 与后端 live2dUploadMaxBytes 保持一致。48MB 曾是「4K 贴图也够」的估计，
// 但实测一个 4096 导出的成品皮压完 47MB，几乎是踩着线过；96MB 才留出余量。
export const LIVE2D_UPLOAD_MAX_BYTES = 96 << 20
