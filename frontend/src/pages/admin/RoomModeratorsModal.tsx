import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, ShieldCheck, UserMinus, UserPlus } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { Text, Title } from '@/components/ui/Typography'
import { EmptyState } from '@/components/ui/EmptyState'
import { message } from '@/components/ui/message'
import { apiFetch } from '@/lib/api'
import { USER_ROLE_TAG_COLORS, userRoleLabel } from '@/lib/roles'
import { t } from '@/i18n'
import type { AdminRoom, AdminUser } from './shared'

/** 房管名单里的一条：房间表只存 userId，用户名由后端补查 */
interface ModeratorEntry {
  userId: number
  username: string
}

interface ModeratorsResponse {
  success: boolean
  message?: string
  roomId?: string
  name?: string | null
  ownerUserId?: number | null
  maxModerators?: number
  moderators?: ModeratorEntry[]
}

interface UsersResponse {
  success: boolean
  users?: AdminUser[]
}

interface RoomModeratorsModalProps {
  /** null 表示关闭；父级用 key=roomId 保证换房间时状态重置 */
  room: AdminRoom | null
  onClose: () => void
  /** 名单变化后回传人数，父级就地更新房间卡片上的「房管 (n)」 */
  onChanged: (moderatorCount: number) => void
}

/**
 * 房间房管管理弹窗（管理端）。
 *
 * 为什么不做成「先输房间号再选账号」：入口就在房间卡片上，房间号天然已知，
 * 再让管理员手打一遍只会打错。反向的需求（给人任命 → 选房间）用「用户管理」
 * 反而绕，因为同一个账号可能同时是多个房间的房管，房间维度的列表更直观。
 */
export function RoomModeratorsModal({
  room,
  onClose,
  onChanged,
}: RoomModeratorsModalProps) {
  const [loading, setLoading] = useState(true)
  const [moderators, setModerators] = useState<ModeratorEntry[]>([])
  const [users, setUsers] = useState<AdminUser[]>([])
  const [maxModerators, setMaxModerators] = useState(10)
  const [ownerUserId, setOwnerUserId] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  /** 正在提交的目标：`grant:<id>` / `revoke:<id>`，用于只禁用那一行 */
  const [busy, setBusy] = useState<string | null>(null)

  const roomId = room?.roomId ?? ''
  const basePath = `/api/admin/rooms/${encodeURIComponent(roomId)}/moderators`

  const load = useCallback(async () => {
    if (!roomId) return
    try {
      // 两个请求并行：房管名单 + 全量账号（用于「添加」的候选列表）。
      const [modRes, userRes] = await Promise.all([
        apiFetch(basePath),
        apiFetch('/api/admin/users'),
      ])
      const modData = (await modRes.json()) as ModeratorsResponse
      if (!modData.success) {
        message.error(modData.message ?? t('获取房管列表失败'))
        return
      }
      setModerators(modData.moderators ?? [])
      setMaxModerators(modData.maxModerators ?? 10)
      setOwnerUserId(modData.ownerUserId ?? null)
      const userData = (await userRes.json()) as UsersResponse
      // 账号列表拿不到不算致命：房管名单已经能看、能撤销，只是不能新增。
      setUsers(userData.success ? (userData.users ?? []) : [])
    } catch (err) {
      console.error('[RoomModeratorsModal] load error:', err)
      message.error(t('获取房管列表失败'))
    } finally {
      setLoading(false)
    }
  }, [basePath, roomId])

  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- 打开弹窗即拉一次名单，与 AdminPage 各 Tab 的加载口径一致 */
    void load()
  }, [load])

  const moderatorIds = useMemo(
    () => new Set(moderators.map((m) => m.userId)),
    [moderators]
  )

  const keyword = search.trim().toLowerCase()
  const candidates = useMemo(
    () =>
      users.filter((u) => {
        if (u.status !== 'active') return false
        if (moderatorIds.has(u.id)) return false
        if (ownerUserId !== null && u.id === ownerUserId) return false
        if (!keyword) return true
        return u.username.toLowerCase().includes(keyword)
      }),
    [users, moderatorIds, ownerUserId, keyword]
  )

  const grant = async (target: AdminUser) => {
    setBusy(`grant:${target.id}`)
    try {
      const res = await apiFetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: target.id }),
      })
      const data = (await res.json()) as ModeratorsResponse
      if (!data.success) {
        message.error(data.message ?? t('任命房管失败'))
        return
      }
      const next = data.moderators ?? []
      setModerators(next)
      onChanged(next.length)
      message.success(t('已任命 {{value}} 为房管', { value: target.username }))
    } catch (err) {
      console.error('[RoomModeratorsModal] grant error:', err)
      message.error(t('任命房管失败'))
    } finally {
      setBusy(null)
    }
  }

  const revoke = async (target: ModeratorEntry) => {
    setBusy(`revoke:${target.userId}`)
    try {
      const res = await apiFetch(`${basePath}/${target.userId}`, {
        method: 'DELETE',
      })
      const data = (await res.json()) as ModeratorsResponse
      if (!data.success) {
        message.error(data.message ?? t('撤销房管失败'))
        return
      }
      const next = data.moderators ?? []
      setModerators(next)
      onChanged(next.length)
      message.success(
        t('已撤销 {{value}} 的房管权限', { value: target.username })
      )
    } catch (err) {
      console.error('[RoomModeratorsModal] revoke error:', err)
      message.error(t('撤销房管失败'))
    } finally {
      setBusy(null)
    }
  }

  const full = moderators.length >= maxModerators

  return (
    <Modal
      open={room !== null}
      onClose={onClose}
      title={t('房管管理')}
      className="max-w-xl"
      footer={
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('关闭')}
          </Button>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Title level={5} className="m-0 truncate">
              {room?.name || roomId}
            </Title>
            {room?.status === 'active' ? (
              <Tag color="success">{t('进行中')}</Tag>
            ) : (
              <Tag color="default">{t('已关闭')}</Tag>
            )}
          </div>
          <Text type="secondary" className="block truncate text-xs">
            {t('房间号')} {roomId}
          </Text>
        </div>

        {loading ? (
          <div className="py-10">
            <Spinner tip={t('加载中...')} size={28} />
          </div>
        ) : (
          <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto pr-0.5">
            {/* ── 当前房管 ───────────────────────────────────────── */}
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
                <Text className="text-sm font-medium">{t('当前房管')}</Text>
              </div>
              <Tag color={full ? 'warning' : 'default'}>
                {moderators.length} / {maxModerators}
              </Tag>
            </div>

            <div className="flex flex-col gap-2">
              {moderators.length === 0 ? (
                <EmptyState text={t('该房间还没有房管')} className="py-6" />
              ) : (
                moderators.map((moderator) => (
                  <div
                    key={moderator.userId}
                    className="glass-card flex items-center justify-between gap-3 p-3"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium"
                        style={{
                          backgroundColor:
                            'var(--md-sys-color-primary-container)',
                          color: 'var(--md-sys-color-on-primary-container)',
                        }}
                      >
                        {moderator.username.slice(0, 1).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-[var(--md-sys-color-on-surface)]">
                          {moderator.username}
                        </div>
                        <Text type="secondary" className="text-xs">
                          ID {moderator.userId}
                        </Text>
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="shrink-0"
                      icon={
                        busy === `revoke:${moderator.userId}` ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <UserMinus className="h-4 w-4" />
                        )
                      }
                      disabled={busy !== null}
                      onClick={() => void revoke(moderator)}
                    >
                      {t('撤销')}
                    </Button>
                  </div>
                ))
              )}
            </div>

            {/* ── 添加房管 ───────────────────────────────────────── */}
            <div
              className="my-3 h-px"
              style={{
                backgroundColor: 'var(--md-sys-color-outline-variant)',
              }}
            />
            <div className="mb-1 flex items-center gap-1.5">
              <UserPlus className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
              <Text className="text-sm font-medium">{t('添加房管')}</Text>
            </div>
            <Text type="secondary" className="mb-2 block text-xs">
              {t('任命后立即生效，无需对方在线；房管可管理影片、踢人与禁言。')}
            </Text>

            {full ? (
              <Text type="secondary" className="block text-xs">
                {t('房管人数已达上限（{{max}}），请先撤销后再添加。', {
                  max: maxModerators,
                })}
              </Text>
            ) : (
              <>
                <Input
                  size="sm"
                  value={search}
                  placeholder={t('按用户名搜索账号')}
                  aria-label={t('按用户名搜索账号')}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <div className="mt-2 flex max-h-56 flex-col gap-2 overflow-y-auto">
                  {candidates.length === 0 ? (
                    <Text type="secondary" className="py-4 text-center text-xs">
                      {keyword ? t('没有匹配的账号') : t('没有可任命的账号')}
                    </Text>
                  ) : (
                    candidates.map((candidate) => (
                      <div
                        key={candidate.id}
                        className="flex items-center justify-between gap-3 rounded-[var(--md-sys-shape-corner)] border px-3 py-2"
                        style={{
                          borderColor: 'var(--md-sys-color-outline-variant)',
                        }}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-sm text-[var(--md-sys-color-on-surface)]">
                            {candidate.username}
                          </span>
                          <Tag color={USER_ROLE_TAG_COLORS[candidate.role]}>
                            {userRoleLabel(candidate.role)}
                          </Tag>
                          <Text
                            type="secondary"
                            className="hidden text-xs sm:inline"
                          >
                            ID {candidate.id}
                          </Text>
                        </div>
                        <Button
                          variant="primary"
                          size="sm"
                          className="shrink-0"
                          icon={
                            busy === `grant:${candidate.id}` ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <UserPlus className="h-4 w-4" />
                            )
                          }
                          disabled={busy !== null}
                          onClick={() => void grant(candidate)}
                        >
                          {t('任命')}
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
