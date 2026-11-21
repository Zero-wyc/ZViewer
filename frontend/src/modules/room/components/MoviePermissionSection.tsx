/**
 * 一起看「点片权限」房主控制区（嵌在影片列表卡片顶部）。
 *
 * - 总开关：允许成员点片
 * - 逐人开关：白名单（总开关关闭时单独放开）/ 黑名单（总开关开启时单独禁止）
 * - 权限来源：GET/PUT /api/rooms/{roomId}/movie-permission，
 *   实时同步走 socket 事件 movie:permission-changed（见 useRoomMoviePermission）
 */
import { useMemo, useState } from 'react'
import { Users } from 'lucide-react'
import { Switch } from '@/components/ui/Switch'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'
import { useRoomStore } from '@/store/roomStore'
import {
  memberCanRequestMovie,
  updateMoviePermission,
} from '@/store/moviePermission'
import { t } from '@/i18n'

export function MoviePermissionSection() {
  const roomId = useRoomStore((state) => state.roomId)
  const viewers = useRoomStore((state) => state.viewers)
  const permission = useRoomStore((state) => state.moviePermission)
  const setMoviePermission = useRoomStore((state) => state.setMoviePermission)
  const myUserId = useAuthStore((state) => state.user?.id)
  const [busy, setBusy] = useState(false)

  const members = useMemo(() => {
    const selfId = myUserId == null ? 0 : Number(myUserId)
    const seen = new Set<number>()
    return viewers
      .filter((viewer) => {
        const id = viewer.userId == null ? 0 : Number(viewer.userId)
        if (id <= 0 || id === selfId || seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map((viewer) => ({
        userId: Number(viewer.userId),
        name:
          viewer.username || t('用户 {{id}}', { id: String(viewer.userId) }),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [myUserId, viewers])

  const apply = async (patch: {
    allowMembers?: boolean
    userId?: number
    allowed?: boolean
  }) => {
    if (!roomId || busy) return
    setBusy(true)
    try {
      const next = await updateMoviePermission(roomId, patch)
      setMoviePermission(next)
    } catch (err) {
      console.error('[MoviePermissionSection] 更新点片权限失败:', err)
      message.error(err instanceof Error ? err.message : t('更新点片权限失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="mx-2 flex flex-col gap-2 rounded-xl border px-2.5 py-2"
      style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
    >
      <div className="flex items-center gap-1.5">
        <Users
          className="h-3.5 w-3.5"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        />
        <Text className="text-xs font-medium">{t('点片权限')}</Text>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Text type="secondary" className="text-[11px]">
          {t('允许成员点片')}
        </Text>
        <Switch
          checked={permission.allowMembers}
          disabled={busy}
          onChange={(e) => void apply({ allowMembers: e.target.checked })}
          aria-label={t('允许成员点片')}
        />
      </div>
      {members.length > 0 ? (
        <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
          {members.map((member) => {
            const allowed = memberCanRequestMovie(permission, member.userId)
            return (
              <div
                key={member.userId}
                className="flex items-center justify-between gap-2 rounded-lg px-1 py-0.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  {member.name}
                </span>
                <Switch
                  checked={allowed}
                  disabled={busy}
                  onChange={(e) =>
                    void apply({
                      userId: member.userId,
                      allowed: e.target.checked,
                    })
                  }
                  aria-label={`${t('点片权限')} - ${member.name}`}
                />
              </div>
            )
          })}
        </div>
      ) : (
        <Text type="secondary" className="text-[11px] opacity-70">
          {t('房间内暂无其他成员')}
        </Text>
      )}
      <Text type="secondary" className="text-[10px] opacity-60">
        {t('游客仅受上方总开关控制')}
      </Text>
    </div>
  )
}
