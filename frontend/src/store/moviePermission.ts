/**
 * 一起看「允许成员点片」房间级权限（前端共享模型 + REST 封装）。
 *
 * 形状与音乐的 musicPermission 完全一致：
 *   { allowMembers: boolean, allowedUserIds: number[], deniedUserIds: number[] }
 * 区别：影片属于敏感操作，缺省（{} / 解析失败）按 allowMembers=false 处理，
 * 必须由房主显式打开。
 */
import { apiFetch, safeJson } from '@/lib/api'
import { t } from '@/i18n'

export interface MoviePermission {
  allowMembers: boolean
  allowedUserIds: number[]
  deniedUserIds: number[]
}

export const DEFAULT_MOVIE_PERMISSION: MoviePermission = {
  allowMembers: false,
  allowedUserIds: [],
  deniedUserIds: [],
}

function toIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const id = typeof item === 'number' ? item : Number(item)
    if (Number.isFinite(id) && id > 0 && !out.includes(id)) out.push(id)
  }
  return out
}

/** 归一化任意服务端/本地结构；缺省值按「不允许成员点片」处理 */
export function normalizeMoviePermission(raw: unknown): MoviePermission {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_MOVIE_PERMISSION }
  const record = raw as Record<string, unknown>
  return {
    allowMembers: record.allowMembers === true,
    allowedUserIds: toIdList(record.allowedUserIds),
    deniedUserIds: toIdList(record.deniedUserIds),
  }
}

/**
 * 当前用户能否点片。顺序与后端 CanRequestMovie 对齐：
 * 房主 / root / 房管（或全局矩阵 addMovie）→ 允许；
 * 黑名单优先，其次白名单，最后看总开关。
 */
export function canRequestMovie(
  permission: MoviePermission,
  opts: {
    isHost: boolean
    isModerator: boolean
    canManageMovie: boolean
    userId?: number | null
  }
): boolean {
  if (opts.isHost || opts.isModerator || opts.canManageMovie) return true
  const userId = opts.userId == null ? 0 : Number(opts.userId)
  if (userId > 0) {
    if (permission.deniedUserIds.includes(userId)) return false
    if (permission.allowedUserIds.includes(userId)) return true
  }
  return permission.allowMembers
}

/** 房主面板：某成员当前是否被允许（白名单/黑名单/总开关） */
export function memberCanRequestMovie(
  permission: MoviePermission,
  userId: number
): boolean {
  if (userId <= 0) return permission.allowMembers
  if (permission.deniedUserIds.includes(userId)) return false
  if (permission.allowedUserIds.includes(userId)) return true
  return permission.allowMembers
}

interface MoviePermissionResponse {
  success?: boolean
  message?: string
  permission?: unknown
}

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

/** 读取房间点片权限（房间可读即可，观众也调用） */
export async function fetchMoviePermission(
  roomId: string
): Promise<MoviePermission> {
  const res = await apiFetch(
    `/api/rooms/${encodeURIComponent(roomId)}/movie-permission`,
    { headers: authHeaders() }
  )
  const data = await safeJson<MoviePermissionResponse>(res, {})
  if (!res.ok || data.success === false) {
    throw new Error(data.message || t('获取点片权限失败'))
  }
  return normalizeMoviePermission(data.permission)
}

export interface MoviePermissionPatch {
  allowMembers?: boolean
  userId?: number
  allowed?: boolean
}

/** 更新点片权限（仅房主/root，后端二次校验） */
export async function updateMoviePermission(
  roomId: string,
  patch: MoviePermissionPatch
): Promise<MoviePermission> {
  const res = await apiFetch(
    `/api/rooms/${encodeURIComponent(roomId)}/movie-permission`,
    {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(patch),
    }
  )
  const data = await safeJson<MoviePermissionResponse>(res, {})
  if (!res.ok || data.success === false) {
    throw new Error(data.message || t('更新点片权限失败'))
  }
  return normalizeMoviePermission(data.permission)
}
