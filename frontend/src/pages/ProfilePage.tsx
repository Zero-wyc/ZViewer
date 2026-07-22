import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  User,
  Shield,
  QrCode,
  LogOut,
  Tv,
  RefreshCw,
  KeyRound,
  AtSign,
  Pencil,
  Crown,
} from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Space } from '@/components/ui/Space'
import { Avatar } from '@/components/ui/Avatar'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { Title, Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore, type User as AuthUser } from '@/store/authStore'
import {
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliUserInfo,
  logoutBilibili,
  buildBilibiliImageProxyUrl,
  type BilibiliUserInfo,
} from '@/modules/room/watch-together/resolveSource'
import MountManager from '@/modules/mounts/MountManager'
import { apiFetch, API_URL } from '@/lib/api'

export default function ProfilePage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuthStore()

  useEffect(() => {
    if (user?.role === 'guest') {
      navigate('/', { replace: true })
    }
  }, [user, navigate])

  const [bilibiliUser, setBilibiliUser] = useState<BilibiliUserInfo | null>(
    null
  )
  const [bilibiliLoading, setBilibiliLoading] = useState(true)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrStatus, setQrStatus] = useState(0)
  const [qrMessage, setQrMessage] = useState('请使用哔哩哔哩 App 扫码登录')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPollingRef = useRef(false)
  const qrRetryCountRef = useRef(0)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)

  const [newUsername, setNewUsername] = useState('')
  const [usernameLoading, setUsernameLoading] = useState(false)
  const [editInfoModalOpen, setEditInfoModalOpen] = useState(false)

  const loadBilibiliUser = useCallback(async () => {
    const info = await getBilibiliUserInfo()
    setBilibiliUser(info)
  }, [])

  useEffect(() => {
    let mounted = true
    const load = async () => {
      const info = await getBilibiliUserInfo()
      if (!mounted) return
      setBilibiliUser(info)
      setBilibiliLoading(false)
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  const stopQrPolling = useCallback(() => {
    isPollingRef.current = false
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const startQrPolling = useCallback(
    (key: string) => {
      if (isPollingRef.current) return
      isPollingRef.current = true
      qrRetryCountRef.current = 0

      const poll = async () => {
        if (!isPollingRef.current) return
        try {
          const result = await pollBilibiliQrCode(key)
          qrRetryCountRef.current = 0
          setQrStatus(result.status)
          if (result.status === 0) {
            setQrMessage('请使用哔哩哔哩 App 扫码登录')
          } else if (result.status === 1) {
            setQrMessage('已扫码，请在 App 中确认登录')
          } else if (result.status === 2) {
            setQrMessage('登录成功')
            setQrModalOpen(false)
            await loadBilibiliUser()
            message.success('B站 登录成功')
            stopQrPolling()
            return
          } else if (result.status === 3) {
            setQrMessage('二维码已过期，请重新获取')
            stopQrPolling()
            return
          }
          pollTimerRef.current = setTimeout(poll, 2000)
        } catch (err) {
          console.error('[ProfilePage] QR poll error:', err)
          qrRetryCountRef.current += 1
          if (qrRetryCountRef.current <= 2) {
            setQrMessage('轮询状态失败，正在重试…')
            pollTimerRef.current = setTimeout(poll, 2000)
          } else {
            setQrMessage('轮询状态失败，请重新获取')
            stopQrPolling()
          }
        }
      }

      void poll()
    },
    [loadBilibiliUser, stopQrPolling]
  )

  const handleOpenQrModal = useCallback(async () => {
    stopQrPolling()
    setQrStatus(0)
    setQrMessage('请使用哔哩哔哩 App 扫码登录')
    setQrDataUrl('')
    setQrModalOpen(true)
    try {
      const data = await getBilibiliQrCode()
      setQrDataUrl(data.qrDataUrl)
      void startQrPolling(data.qrcodeKey)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取二维码失败')
      setQrModalOpen(false)
    }
  }, [stopQrPolling, startQrPolling])

  const handleCloseQrModal = useCallback(() => {
    stopQrPolling()
    setQrModalOpen(false)
  }, [stopQrPolling])

  const handleLogoutBilibili = useCallback(async () => {
    try {
      await logoutBilibili()
      setBilibiliUser(null)
      message.success('已退出 B站 登录')
    } catch {
      message.error('退出 B站 登录失败')
    }
  }, [])

  const handleChangePassword = useCallback(async () => {
    if (!oldPassword || !newPassword) {
      message.warning('请填写原密码和新密码')
      return
    }
    if (newPassword !== confirmPassword) {
      message.error('两次输入的新密码不一致')
      return
    }
    if (newPassword.length < 4) {
      message.error('新密码至少 4 位')
      return
    }
    setPasswordLoading(true)
    try {
      const res = await apiFetch(`${API_URL}/api/auth/password`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
      }
      if (data.success) {
        message.success('密码修改成功')
        setOldPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        message.error(data.message ?? '修改失败')
      }
    } catch {
      message.error('修改密码失败')
    } finally {
      setPasswordLoading(false)
    }
  }, [oldPassword, newPassword, confirmPassword])

  const openEditInfoModal = useCallback(() => {
    setOldPassword('')
    setNewPassword('')
    setConfirmPassword('')
    setNewUsername('')
    setEditInfoModalOpen(true)
  }, [])

  const handleChangeUsername = useCallback(async () => {
    const trimmed = newUsername.trim()
    if (!trimmed) {
      message.warning('请输入新用户名')
      return
    }
    setUsernameLoading(true)
    try {
      const res = await apiFetch(`${API_URL}/api/auth/username`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: trimmed }),
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
        user?: AuthUser
      }
      if (data.success && data.user) {
        message.success('用户名修改成功')
        setUser(data.user)
        setNewUsername('')
      } else {
        message.error(data.message ?? '修改失败')
      }
    } catch {
      message.error('修改用户名失败')
    } finally {
      setUsernameLoading(false)
    }
  }, [newUsername, setUser])

  useEffect(() => {
    return () => {
      stopQrPolling()
    }
  }, [stopQrPolling])

  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <Spinner tip="加载用户信息..." />
      </div>
    )
  }

  const isAdmin = user.role === 'admin' || user.role === 'root'

  return (
    <div className="flex-1 p-4 sm:p-6">
      <Card className="relative mx-auto w-full max-w-2xl">
        <PageBackButton to={-1} />

        <div className="mb-6 pt-8 text-center">
          <div
            className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            <User className="h-7 w-7" />
          </div>
          <Title level={3} className="m-0">
            个人中心
          </Title>
          <Text type="secondary">
            管理您的 ZViewer 账号、挂载配置与 B站 绑定
          </Text>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* ZViewer 账号信息 */}
          <div
            className="rounded-[var(--md-sys-shape-corner)] border p-4"
            style={{
              borderColor: 'var(--md-sys-color-outline)',
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                style={{
                  backgroundColor: 'var(--md-sys-color-primary-container)',
                  color: 'var(--md-sys-color-on-primary-container)',
                }}
              >
                <Shield className="h-4 w-4" />
              </div>
              <Text className="text-sm font-medium">ZViewer 账号</Text>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                  <Avatar size="md" alt={user.username} />
                  <div>
                    <p className="text-base font-medium text-[var(--md-sys-color-on-surface)]">
                      {user.username}
                    </p>
                    <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                      用户 ID: {user.id}
                    </p>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Pencil className="h-4 w-4" />}
                  onClick={openEditInfoModal}
                >
                  编辑信息
                </Button>
              </div>
              <div
                className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: isAdmin
                    ? 'var(--md-sys-color-primary-container)'
                    : 'var(--md-sys-color-surface-container)',
                  color: isAdmin
                    ? 'var(--md-sys-color-on-primary-container)'
                    : 'var(--md-sys-color-on-surface)',
                  border: '1px solid var(--md-sys-color-outline)',
                }}
              >
                {isAdmin ? (
                  <>
                    <Shield className="h-3 w-3" />
                    管理员
                  </>
                ) : (
                  <>
                    <User className="h-3 w-3" />
                    普通用户
                  </>
                )}
              </div>
            </div>
          </div>

          {/* B站 绑定状态 */}
          <div
            className="rounded-[var(--md-sys-shape-corner)] border p-4"
            style={{
              borderColor: 'var(--md-sys-color-outline)',
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                style={{
                  backgroundColor: 'var(--md-sys-color-tertiary-container)',
                  color: 'var(--md-sys-color-on-tertiary-container)',
                }}
              >
                <Tv className="h-4 w-4" />
              </div>
              <Text className="text-sm font-medium">B站 绑定状态</Text>
            </div>

            {bilibiliLoading ? (
              <div className="py-4">
                <Spinner tip="加载中..." size={28} />
              </div>
            ) : bilibiliUser ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <Avatar
                    size="md"
                    src={buildBilibiliImageProxyUrl(bilibiliUser.avatar)}
                    alt={bilibiliUser.name}
                  />
                  <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-base font-medium text-[var(--md-sys-color-on-surface)]">
                    {bilibiliUser.name}
                  </p>
                  {bilibiliUser.vipStatus === 1 ? (
                    <Tag color="warning" className="shrink-0 px-1.5 py-0 text-[10px]">
                      <Crown className="mr-0.5 h-3 w-3" />
                      大会员
                    </Tag>
                  ) : (
                    <Tag color="default" className="shrink-0 px-1.5 py-0 text-[10px]">
                      普通账号
                    </Tag>
                  )}
                </div>
                <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  已绑定 B站 账号
                </p>
              </div>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<LogOut className="h-4 w-4" />}
                  onClick={handleLogoutBilibili}
                >
                  退出 B站 登录
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <Paragraph type="secondary" className="m-0 text-sm">
                  未绑定 B站 账号
                </Paragraph>
                <Button
                  variant="primary"
                  size="sm"
                  icon={<QrCode className="h-4 w-4" />}
                  onClick={handleOpenQrModal}
                >
                  扫码登录 B站
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6">
          <MountManager />
        </div>

        {!bilibiliLoading && bilibiliUser && (
          <div className="mt-4 flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() => void loadBilibiliUser()}
            >
              刷新绑定状态
            </Button>
          </div>
        )}
      </Card>

      <Modal
        open={qrModalOpen}
        onClose={handleCloseQrModal}
        title="扫码登录哔哩哔哩"
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseQrModal}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="哔哩哔哩登录二维码"
              className="rounded-lg border"
              style={{
                width: 200,
                height: 200,
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            />
          ) : (
            <div
              className="rounded-lg flex items-center justify-center"
              style={{
                width: 200,
                height: 200,
                backgroundColor: 'var(--md-sys-color-surface-container)',
              }}
            >
              <Spinner tip="正在生成二维码…" size={28} />
            </div>
          )}
          <Paragraph
            className={`m-0 text-sm ${
              qrStatus === 2
                ? 'text-[var(--md-sys-color-secondary)]'
                : qrStatus === 3
                  ? 'text-[var(--md-sys-color-error)]'
                  : ''
            }`}
          >
            {qrMessage}
          </Paragraph>
          {qrStatus === 3 && (
            <Button variant="primary" size="sm" onClick={handleOpenQrModal}>
              重新获取二维码
            </Button>
          )}
        </div>
      </Modal>

      <Modal
        open={editInfoModalOpen}
        onClose={() => setEditInfoModalOpen(false)}
        title="编辑账号信息"
        footer={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditInfoModalOpen(false)}
          >
            关闭
          </Button>
        }
      >
        <div className="flex w-[320px] flex-col gap-5 sm:w-[360px]">
          <div>
            <div className="mb-3 flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
              <Text className="text-sm font-medium">修改密码</Text>
            </div>
            <Space direction="vertical" className="w-full" size="sm">
              <Input
                type="password"
                size="sm"
                placeholder="原密码"
                value={oldPassword}
                onChange={(e) => setOldPassword(e.target.value)}
              />
              <Input
                type="password"
                size="sm"
                placeholder="新密码"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <Input
                type="password"
                size="sm"
                placeholder="确认新密码"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    void handleChangePassword()
                  }
                }}
              />
              <Button
                variant="primary"
                size="sm"
                loading={passwordLoading}
                icon={<KeyRound className="h-4 w-4" />}
                onClick={() => void handleChangePassword()}
              >
                修改密码
              </Button>
            </Space>
          </div>

          {user.role === 'root' && (
            <div className="border-t border-[var(--md-sys-color-outline-variant)] pt-4">
              <div className="mb-3 flex items-center gap-2">
                <AtSign className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
                <Text className="text-sm font-medium">修改用户名</Text>
              </div>
              <Space direction="vertical" className="w-full" size="sm">
                <Input
                  size="sm"
                  placeholder="新用户名"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleChangeUsername()
                    }
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={usernameLoading}
                  icon={<AtSign className="h-4 w-4" />}
                  onClick={() => void handleChangeUsername()}
                >
                  修改用户名
                </Button>
              </Space>
            </div>
          )}
        </div>
      </Modal>
    </div>
  )
}
