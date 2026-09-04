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
  Camera,
  Trash2,
  Download,
  Cookie,
} from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Avatar } from '@/components/ui/Avatar'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { Title, Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore, type User as AuthUser } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import {
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliUserInfo,
  logoutBilibili,
  loginBilibiliWithCookie,
  getBilibiliCookie,
  buildBilibiliImageProxyUrl,
  type BilibiliUserInfo,
} from '@/modules/room/watch-together/resolveSource'
import MountManager from '@/modules/mounts/MountManager'
import ServerFileManager from '@/modules/server-files/ServerFileManager'
import { BilibiliDownloadModal } from '@/modules/server-files/BilibiliDownloadModal'
import { apiFetch } from '@/lib/api'

/** 构建头像完整 URL（后端返回相对路径，前端拼接 API_URL） */
function buildAvatarUrl(
  avatar: string | null | undefined,
  role?: string
): string | undefined {
  if (!avatar) {
    // root 默认头像是前端静态资源，使用相对路径由前端服务器提供
    if (role === 'root') {
      return '/root-avatar.jpg'
    }
    return undefined
  }
  if (avatar.startsWith('http://') || avatar.startsWith('https://'))
    return avatar
  // 上传的头像存储在后端，通过 /uploads 路径访问
  // 使用相对路径，由前端服务器（Vite/Nginx/frontend-server）代理到后端
  return avatar
}

export default function ProfilePage() {
  const navigate = useNavigate()
  const { user, setUser } = useAuthStore()
  const { betaFeaturesEnabled } = useSystemSettingsStore()

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

  // Cookie 登录
  const [cookieModalOpen, setCookieModalOpen] = useState(false)
  const [cookieInput, setCookieInput] = useState('')
  const [cookieLoading, setCookieLoading] = useState(false)
  const [cookieCopyLoading, setCookieCopyLoading] = useState(false)

  // B站视频下载 Popup（root 限定，位于「刷新绑定状态」旁）
  const [biliDownloadOpen, setBiliDownloadOpen] = useState(false)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)

  const [newUsername, setNewUsername] = useState('')
  const [usernameLoading, setUsernameLoading] = useState(false)
  const [editInfoModalOpen, setEditInfoModalOpen] = useState(false)

  // 头像上传
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarDeleteTarget, setAvatarDeleteTarget] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

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

  const handleCopyCookie = useCallback(async () => {
    setCookieCopyLoading(true)
    try {
      const cookie = await getBilibiliCookie()
      if (!cookie) {
        message.warning('未获取到 Cookie，请重新登录 B站')
        return
      }
      // HTTPS 下用 Clipboard API；HTTP 局域网环境会缺失 navigator.clipboard，
      // 回退到临时 textarea + execCommand 方案
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(cookie)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = cookie
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      message.success('Cookie 已复制到剪贴板')
    } catch {
      message.error('复制 Cookie 失败')
    } finally {
      setCookieCopyLoading(false)
    }
  }, [])

  const handleCookieLogin = useCallback(async () => {
    const trimmed = cookieInput.trim()
    if (!trimmed) {
      message.warning('请输入 Cookie')
      return
    }
    setCookieLoading(true)
    try {
      await loginBilibiliWithCookie(trimmed)
      message.success('B站 Cookie 登录成功')
      setCookieModalOpen(false)
      setCookieInput('')
      await loadBilibiliUser()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Cookie 登录失败')
    } finally {
      setCookieLoading(false)
    }
  }, [cookieInput, loadBilibiliUser])

  const handleCloseCookieModal = useCallback(() => {
    setCookieModalOpen(false)
    setCookieInput('')
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
      const res = await apiFetch('/api/auth/password', {
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
      const res = await apiFetch('/api/auth/username', {
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

  // 头像上传
  const handleAvatarUpload = useCallback(
    async (file: File) => {
      if (user?.role === 'guest') {
        message.warning('游客无法设置头像')
        return
      }
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
      ]
      if (!allowedTypes.includes(file.type)) {
        message.error('仅支持 JPG / PNG / GIF / WEBP 格式')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        message.error('头像文件不能超过 5MB')
        return
      }
      setAvatarLoading(true)
      try {
        const formData = new FormData()
        formData.append('avatar', file)
        const res = await apiFetch('/api/auth/avatar', {
          method: 'POST',
          body: formData,
        })
        const data = (await res.json()) as {
          success: boolean
          message?: string
          user?: AuthUser
        }
        if (data.success && data.user) {
          message.success('头像更新成功')
          setUser(data.user)
        } else {
          message.error(data.message ?? '头像上传失败')
        }
      } catch {
        message.error('头像上传失败')
      } finally {
        setAvatarLoading(false)
      }
    },
    [user, setUser]
  )

  // 头像删除
  const handleAvatarDelete = useCallback(async () => {
    setAvatarDeleteTarget(false)
    setAvatarLoading(true)
    try {
      const res = await apiFetch('/api/auth/avatar', {
        method: 'DELETE',
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
        user?: AuthUser
      }
      if (data.success && data.user) {
        message.success('头像已删除')
        setUser(data.user)
      } else {
        message.error(data.message ?? '删除头像失败')
      }
    } catch {
      message.error('删除头像失败')
    } finally {
      setAvatarLoading(false)
    }
  }, [setUser])

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
    <div className="hide-scrollbar h-[calc(100vh-64px)] overflow-y-auto p-4 sm:p-6">
      <Card className="relative mx-auto w-full max-w-2xl">
        <PageBackButton to={-1} />

        <div className="mb-6 pt-8 text-center">
          <Avatar
            size="lg"
            alt={user.username}
            src={buildAvatarUrl(user.avatar, user.role)}
            className="mx-auto mb-3 h-14 w-14"
          />
          <Title level={3} className="m-0">
            个人中心
          </Title>
          <Text type="secondary">
            管理您的 ZViewer 账号、挂载配置与 B站 绑定
          </Text>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* ZViewer 账号信息 */}
          <div className="glass-card p-4">
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
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  <Avatar
                    size="md"
                    alt={user.username}
                    src={buildAvatarUrl(user.avatar, user.role)}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-base font-medium text-[var(--md-sys-color-on-surface)]">
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
                  className="shrink-0"
                >
                  编辑信息
                </Button>
              </div>
              <div
                className="mt-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                style={{
                  backgroundColor: isAdmin
                    ? 'var(--md-sys-color-primary-container)'
                    : 'var(--glass-bg)',
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
          <div className="glass-card p-4">
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
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar
                      size="md"
                      src={buildBilibiliImageProxyUrl(bilibiliUser.avatar)}
                      alt={bilibiliUser.name}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="min-w-0 truncate text-base font-medium text-[var(--md-sys-color-on-surface)]">
                          {bilibiliUser.name}
                        </p>
                        {bilibiliUser.vipStatus === 1 ? (
                          <Tag
                            color="warning"
                            className="shrink-0 px-1.5 py-0 text-[10px]"
                          >
                            <Crown className="mr-0.5 h-3 w-3" />
                            大会员
                          </Tag>
                        ) : (
                          <Tag
                            color="default"
                            className="shrink-0 px-1.5 py-0 text-[10px]"
                          >
                            普通账号
                          </Tag>
                        )}
                      </div>
                      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        已绑定 B站 账号
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Cookie className="h-4 w-4" />}
                      onClick={handleCopyCookie}
                      loading={cookieCopyLoading}
                      title="复制当前绑定的 B站 Cookie（可用于其他设备登录或备份）"
                    >
                      复制 Cookie
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<LogOut className="h-4 w-4" />}
                      onClick={handleLogoutBilibili}
                    >
                      退登
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Paragraph type="secondary" className="m-0 text-sm">
                  未绑定 B站 账号
                </Paragraph>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<QrCode className="h-4 w-4" />}
                    onClick={handleOpenQrModal}
                  >
                    扫码登录 B站
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Cookie className="h-4 w-4" />}
                    onClick={() => setCookieModalOpen(true)}
                  >
                    Cookie 登录
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-6">
          <MountManager />
        </div>

        {user.role === 'root' && (
          <div className="mt-6">
            <ServerFileManager />
          </div>
        )}

        {!bilibiliLoading && bilibiliUser && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            {betaFeaturesEnabled && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Download className="h-4 w-4" />}
                onClick={() => setBiliDownloadOpen(true)}
              >
                下载 B站视频
              </Button>
            )}
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

      {/* B站视频下载 Popup（root 限定，Beta 功能） */}
      {user?.role === 'root' && betaFeaturesEnabled && (
        <BilibiliDownloadModal
          open={biliDownloadOpen}
          onClose={() => setBiliDownloadOpen(false)}
        />
      )}

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
              className="glass rounded-lg flex items-center justify-center"
              style={{
                width: 200,
                height: 200,
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

      {/* Cookie 登录 Modal */}
      <Modal
        open={cookieModalOpen}
        onClose={handleCloseCookieModal}
        title="Cookie 登录哔哩哔哩"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCloseCookieModal}
              disabled={cookieLoading}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCookieLogin}
              disabled={cookieLoading || !cookieInput.trim()}
            >
              {cookieLoading ? '验证中...' : '登录'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Paragraph type="secondary" className="m-0 text-xs leading-relaxed">
            1. 在浏览器中登录 bilibili.com
            <br />
            2. 按 F12 打开开发者工具 → Application → Cookies
            <br />
            3. 复制全部 Cookie（至少需包含 SESSDATA）
          </Paragraph>
          <textarea
            value={cookieInput}
            onChange={(e) => setCookieInput(e.target.value)}
            placeholder="粘贴 B站 Cookie，如：SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx"
            rows={5}
            className="w-full resize-none rounded-[var(--md-sys-shape-corner)] border bg-[var(--md-sys-color-surface-container)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
            style={{
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
            disabled={cookieLoading}
          />
        </div>
      </Modal>

      <Modal
        open={editInfoModalOpen}
        onClose={() => setEditInfoModalOpen(false)}
        title="编辑账号信息"
        className="max-w-2xl"
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* 左侧列：头像 + 用户名 */}
          <div className="flex flex-col gap-3">
            {/* 修改头像区块 */}
            <div className="glass-card overflow-hidden rounded-[var(--md-sys-shape-corner)]">
              <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    background:
                      'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-secondary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent))',
                  }}
                >
                  <Camera
                    className="h-4 w-4"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                </span>
                <div className="flex min-w-0 flex-col">
                  <Text className="text-sm font-semibold leading-tight">
                    修改头像
                  </Text>
                  <Text
                    type="secondary"
                    className="text-[10px] uppercase tracking-wide"
                  >
                    上传自定义头像图片
                  </Text>
                </div>
              </div>
              <div className="flex flex-col gap-2.5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar
                      size="lg"
                      alt={user.username}
                      src={buildAvatarUrl(user.avatar, user.role)}
                    />
                    {avatarLoading && (
                      <div
                        className="absolute inset-0 flex items-center justify-center rounded-full"
                        style={{
                          backgroundColor:
                            'color-mix(in srgb, var(--md-sys-color-surface) 70%, transparent)',
                        }}
                      >
                        <Spinner size={16} />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          void handleAvatarUpload(file)
                        }
                        // 重置 input value 以便重复选择同一文件
                        e.target.value = ''
                      }}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Camera className="h-3.5 w-3.5" />}
                      loading={avatarLoading}
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      {user.avatar ? '更换头像' : '上传头像'}
                    </Button>
                    {user.avatar && (
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        disabled={avatarLoading}
                        onClick={() => setAvatarDeleteTarget(true)}
                      >
                        删除头像
                      </Button>
                    )}
                  </div>
                </div>
                <Text type="secondary" className="text-[10px] leading-relaxed">
                  支持 JPG / PNG / GIF / WEBP，最大 5MB
                </Text>
              </div>
            </div>

            {/* 修改用户名区块 */}
            {user.role === 'root' && (
              <div className="glass-card overflow-hidden rounded-[var(--md-sys-shape-corner)]">
                <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-secondary) 18%, transparent))',
                    }}
                  >
                    <AtSign
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-semibold leading-tight">
                      修改用户名
                    </Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      更改登录账户名称
                    </Text>
                  </div>
                </div>
                <div className="flex flex-col gap-2.5 px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                      新用户名
                    </label>
                    <Input
                      size="sm"
                      placeholder="请输入新用户名"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleChangeUsername()
                        }
                      }}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={usernameLoading}
                    icon={<AtSign className="h-4 w-4" />}
                    onClick={() => void handleChangeUsername()}
                    className="mt-1"
                  >
                    确认修改
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 右侧列：修改密码 */}
          <div className="glass-card overflow-hidden rounded-[var(--md-sys-shape-corner)]">
            <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                style={{
                  background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent))',
                }}
              >
                <KeyRound
                  className="h-4 w-4"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                />
              </span>
              <div className="flex min-w-0 flex-col">
                <Text className="text-sm font-semibold leading-tight">
                  修改密码
                </Text>
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  更新账户登录密码
                </Text>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  原密码
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder="请输入原密码"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  新密码
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder="至少 4 位"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  确认新密码
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder="再次输入新密码"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleChangePassword()
                    }
                  }}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                loading={passwordLoading}
                icon={<KeyRound className="h-4 w-4" />}
                onClick={() => void handleChangePassword()}
                className="mt-1"
              >
                确认修改
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={avatarDeleteTarget}
        onClose={() => setAvatarDeleteTarget(false)}
        title="删除头像"
        okText="删除"
        onOk={() => void handleAvatarDelete()}
        onCancel={() => setAvatarDeleteTarget(false)}
      >
        <Text className="text-sm">确定要删除当前头像并恢复默认头像吗？</Text>
      </ConfirmModal>
    </div>
  )
}
