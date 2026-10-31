import { Shield, Trash2, UserCheck } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { Space } from '@/components/ui/Space'
import { Title, Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/lib/utils'
import { USER_ROLE_TAG_COLORS, userRoleLabel } from '@/lib/roles'
import type { AdminSettings, AdminUser, RegistrationMode } from './shared'
import { formatDate } from './shared'
import { t } from '@/i18n'

interface UsersTabProps {
  users: AdminUser[]
  /** 注册方式当前值（顶层 settings） */
  registrationMode: AdminSettings['registrationMode']
  onRegistrationModeChange: (mode: RegistrationMode) => void
  onSaveSettings: () => void
  savingSettings: boolean
  /** 音乐音量行内编辑进行中时禁用「保存」按钮（保持原有联动） */
  editingMusicVolume: boolean
  isSelf: (targetUser: AdminUser) => boolean
  onChangeRole: (targetUser: AdminUser, nextRole: AdminUser['role']) => void
  /** 请求审核通过该用户（打开确认弹窗） */
  onRequestApprove: (user: AdminUser) => void
  /** 请求删除该用户（打开确认弹窗） */
  onRequestDelete: (user: AdminUser) => void
}

/** 用户管理 Tab（纯搬迁自 AdminPage，无行为变更） */
export function UsersTab({
  users,
  registrationMode,
  onRegistrationModeChange,
  onSaveSettings,
  savingSettings,
  editingMusicVolume,
  isSelf,
  onChangeRole,
  onRequestApprove,
  onRequestDelete,
}: UsersTabProps) {
  return (
    <div className="grid gap-3">
      <div className="glass-card p-4">
        <Title level={5} className="mb-3">
          {t('用户注册设置')}
        </Title>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="max-w-xs flex-1">
            <Select
              label={t('注册方式')}
              value={registrationMode}
              options={[
                { label: t('直接注册'), value: 'open' },
                { label: t('审批注册'), value: 'approval' },
                { label: t('禁止注册'), value: 'closed' },
              ]}
              onChange={(value) =>
                onRegistrationModeChange(value as RegistrationMode)
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {t(
                '直接注册：新用户注册后立即可用；审批注册：新用户需 root 审核通过后方可登录；禁止注册：关闭注册入口。'
              )}
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={onSaveSettings}
            loading={savingSettings}
            disabled={savingSettings || editingMusicVolume}
          >
            {t('保存')}
          </Button>
        </div>
      </div>
      {users.length === 0 ? (
        <EmptyState text={t('暂无用户')} className="py-12" />
      ) : (
        users.map((u) => {
          const isRootUser = u.role === 'root' || u.username === 'root'
          return (
            <div
              key={u.id}
              className={cn(
                'glass-card flex flex-col gap-3 p-4 transition-colors sm:flex-row sm:items-center sm:justify-between'
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate font-medium text-[var(--md-sys-color-on-surface)]">
                    {u.username}
                  </span>
                  <Tag color={USER_ROLE_TAG_COLORS[u.role]}>
                    {u.role === 'root' || u.role === 'admin' ? (
                      <Shield className="mr-1 inline h-3 w-3" />
                    ) : null}
                    {userRoleLabel(u.role)}
                  </Tag>
                  {u.status === 'pending' ? (
                    <Tag color="warning">{t('待审核')}</Tag>
                  ) : (
                    <Tag color="success">{t('正常')}</Tag>
                  )}
                </div>
                <Text type="secondary" className="text-xs">
                  {t('创建于 {{value}}', { value: formatDate(u.createdAt) })}
                </Text>
              </div>
              <Space className="shrink-0">
                {u.status === 'pending' && (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<UserCheck className="h-4 w-4" />}
                    onClick={() => onRequestApprove(u)}
                    disabled={isRootUser}
                  >
                    {t('审核')}
                  </Button>
                )}
                {isRootUser ? (
                  <div
                    className="flex w-32 items-center justify-center rounded-[var(--md-sys-shape-corner)] border px-3 py-2 text-sm"
                    style={{
                      borderColor: 'var(--md-sys-color-outline)',
                      backgroundColor: 'var(--glass-bg)',
                      color: 'var(--md-sys-color-on-surface-variant)',
                    }}
                  >
                    {t('超级管理员')}
                  </div>
                ) : (
                  <Select
                    className="w-32"
                    value={u.role}
                    disabled={isSelf(u)}
                    options={[
                      { label: t('管理员'), value: 'admin' },
                      { label: t('普通用户'), value: 'user' },
                    ]}
                    onChange={(value) =>
                      onChangeRole(u, value as AdminUser['role'])
                    }
                  />
                )}
                <Button
                  variant="danger"
                  size="sm"
                  icon={<Trash2 className="h-4 w-4" />}
                  onClick={() => onRequestDelete(u)}
                  disabled={isRootUser || isSelf(u)}
                >
                  {t('删除')}
                </Button>
              </Space>
            </div>
          )
        })
      )}
    </div>
  )
}
