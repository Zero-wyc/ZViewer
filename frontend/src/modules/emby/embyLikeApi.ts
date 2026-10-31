/**
 * Emby/Jellyfin 前端 API 工厂（与后端 routes/emby-like-factory.ts 对称）。
 *
 * 两者接口逐行同构（挂载 CRUD/test/browse/search/resolve/proxy），仅
 * 路由前缀与错误文案不同，条目/挂载类型仅 type 字面量差异——抽成泛型
 * 工厂后，embyApi / jellyfinApi 只保留各自类型与少量 Emby 专属函数。
 */
import { apiFetch } from '@/lib/api'
import { buildProxyUrl } from '@/modules/direct-link/directLinkApi'
import { t } from '@/i18n'

export interface EmbyLikeApi<
  TMount extends { id: number },
  TForm,
  TTest,
  TEntry,
  TResolved,
> {
  getMounts(): Promise<TMount[]>
  createMount(payload: TForm): Promise<TMount & { warning?: string }>
  updateMount(
    id: number,
    payload: TForm
  ): Promise<TMount & { warning?: string }>
  deleteMount(id: number): Promise<void>
  testMount(payload: TForm): Promise<TTest>
  browseMount(id: number, path?: string): Promise<TEntry[]>
  searchMount(id: number, term: string): Promise<TEntry[]>
  resolve(mountId: number, path: string): Promise<TResolved>
  buildProxyUrl(mountId: number, path: string): string
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export function createEmbyLikeApi<
  TMount extends { id: number },
  TForm,
  TTest extends {
    success: boolean
    userId?: string
    userName?: string
    serverId?: string
  },
  TEntry,
  TResolved,
>(
  prefix: 'emby' | 'jellyfin',
  label: 'Emby' | 'Jellyfin'
): EmbyLikeApi<TMount, TForm, TTest, TEntry, TResolved> {
  return {
    async getMounts(): Promise<TMount[]> {
      const res = await apiFetch(`/api/${prefix}/mounts`)
      const data = (await res.json()) as {
        success: boolean
        mounts?: TMount[]
        message?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(
          data.message || t('获取 {{label}} 挂载列表失败', { label })
        )
      }
      return data.mounts || []
    },

    async createMount(payload: TForm): Promise<TMount & { warning?: string }> {
      const res = await apiFetch(`/api/${prefix}/mounts`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        mount?: TMount
        message?: string
        warning?: string
      }
      if (!res.ok || !data.success || !data.mount) {
        throw new Error(data.message || t('创建 {{label}} 挂载失败', { label }))
      }
      return { ...data.mount, warning: data.warning }
    },

    async updateMount(
      id: number,
      payload: TForm
    ): Promise<TMount & { warning?: string }> {
      const res = await apiFetch(`/api/${prefix}/mounts/${id}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        mount?: TMount
        message?: string
        warning?: string
      }
      if (!res.ok || !data.success || !data.mount) {
        throw new Error(data.message || t('更新 {{label}} 挂载失败', { label }))
      }
      return { ...data.mount, warning: data.warning }
    },

    async deleteMount(id: number): Promise<void> {
      const res = await apiFetch(`/api/${prefix}/mounts/${id}`, {
        method: 'DELETE',
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (!res.ok || !data.success) {
        throw new Error(data.message || t('删除 {{label}} 挂载失败', { label }))
      }
    },

    async testMount(payload: TForm): Promise<TTest> {
      const res = await apiFetch(`/api/${prefix}/mounts/test`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        userId?: string
        userName?: string
        serverId?: string
        message?: string
        code?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(data.message || t('测试 {{label}} 连接失败', { label }))
      }
      return {
        success: true,
        userId: data.userId,
        userName: data.userName,
        serverId: data.serverId,
      } as TTest
    },

    async browseMount(id: number, path?: string): Promise<TEntry[]> {
      const query = path ? `?path=${encodeURIComponent(path)}` : ''
      const res = await apiFetch(`/api/${prefix}/mounts/${id}/browse${query}`)
      const data = (await res.json()) as {
        success: boolean
        entries?: TEntry[]
        message?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(data.message || t('浏览 {{label}} 挂载失败', { label }))
      }
      return data.entries || []
    },

    /** 全库搜索（官方 API SearchTerm 递归检索，返回条目结构与 browse 一致） */
    async searchMount(id: number, term: string): Promise<TEntry[]> {
      const res = await apiFetch(
        `/api/${prefix}/mounts/${id}/search?term=${encodeURIComponent(term)}`
      )
      const data = (await res.json()) as {
        success: boolean
        entries?: TEntry[]
        message?: string
      }
      if (!res.ok || !data.success) {
        throw new Error(data.message || t('搜索 {{label}} 失败', { label }))
      }
      return data.entries || []
    },

    async resolve(mountId: number, path: string): Promise<TResolved> {
      const query = new URLSearchParams({
        mountId: String(mountId),
        path,
      }).toString()
      const res = await apiFetch(`/api/${prefix}/resolve?${query}`)
      const data = (await res.json()) as {
        success: boolean
        message?: string
        title?: string
        videoUrl?: string
        directUrl?: string
        format?: string
        duration?: number
        audioCodec?: string | null
        needsAudioTranscode?: boolean
        audioTranscodeDisabled?: boolean
        multiVersion?: boolean
      }
      if (!res.ok || !data.success || !data.videoUrl) {
        throw new Error(data.message || t('解析 {{label}} 条目失败', { label }))
      }
      return {
        title: data.title || '',
        videoUrl: data.videoUrl,
        directUrl: data.directUrl,
        format: data.format || 'mp4',
        duration: data.duration ?? 0,
        audioCodec: data.audioCodec ?? null,
        needsAudioTranscode: data.needsAudioTranscode === true,
        audioTranscodeDisabled: data.audioTranscodeDisabled === true,
        multiVersion: data.multiVersion === true,
      } as TResolved
    },

    buildProxyUrl(mountId: number, path: string): string {
      return buildProxyUrl(prefix, { mountId, path })
    },
  }
}
