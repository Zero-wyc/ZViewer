import type { MusicPermission } from '../types'

/** 点歌权限默认值（旧后端 / 空对象 / 解析失败一律视为「允许成员点歌」） */
export const DEFAULT_MUSIC_PERMISSION: MusicPermission = {
  allowMembers: true,
  allowedUserIds: [],
  deniedUserIds: [],
}

function toIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const ids = value
    .map((v) => Number(v))
    .filter((v) => Number.isSafeInteger(v) && v > 0)
  return Array.from(new Set(ids))
}

/**
 * 归一化后端下发的点歌权限。
 *
 * 后端把未设置（'{}'）、字段缺失或历史脏数据都视作默认放开；
 * 前端保持同一语义，避免「权限对象存在但字段缺失」时误判成禁止点歌。
 */
export function normalizeMusicPermission(
  permission?: Partial<MusicPermission> | null
): MusicPermission {
  if (!permission || typeof permission !== 'object') {
    return { ...DEFAULT_MUSIC_PERMISSION }
  }
  return {
    allowMembers:
      typeof permission.allowMembers === 'boolean'
        ? permission.allowMembers
        : true,
    allowedUserIds: toIdList(permission.allowedUserIds),
    deniedUserIds: toIdList(permission.deniedUserIds),
  }
}

interface CanRequestMusicOptions {
  /** 房主：始终可以点歌 */
  isHost: boolean
  /** 房管：始终可以点歌 */
  isModerator: boolean
  /** 全局权限矩阵（系统设置 roomPermissionMatrix）是否允许该角色管理队列 */
  canManageQueue: boolean
  /** 当前登录用户 ID（游客为 null/undefined） */
  userId?: number | null
}

/**
 * 当前用户能否直接点歌，判定顺序与后端 CanRequestMusic 保持一致：
 * 房主/房管/全局矩阵放行 → 允许；黑名单命中 → 拒绝；白名单命中 →
 * 允许；否则看 allowMembers。游客无 user id，只受总开关约束。
 */
export function canRequestMusic(
  permission: MusicPermission | null | undefined,
  options: CanRequestMusicOptions
): boolean {
  const perm = normalizeMusicPermission(permission)
  if (options.isHost || options.isModerator || options.canManageQueue) {
    return true
  }
  const uid = options.userId
  if (uid == null || uid <= 0) return perm.allowMembers
  if (perm.deniedUserIds.includes(uid)) return false
  if (perm.allowedUserIds.includes(uid)) return true
  return perm.allowMembers
}

/** 该用户在权限面板里当前是否允许点歌（用于逐人开关的初始值） */
export function memberCanRequestMusic(
  permission: MusicPermission,
  userId: number
): boolean {
  const perm = normalizeMusicPermission(permission)
  if (perm.deniedUserIds.includes(userId)) return false
  if (perm.allowedUserIds.includes(userId)) return true
  return perm.allowMembers
}
