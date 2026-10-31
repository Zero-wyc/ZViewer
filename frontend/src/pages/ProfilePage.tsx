import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  User,
  Shield,
  QrCode,
  LogOut,
  RefreshCw,
  KeyRound,
  UserPen,
  Pencil,
  Crown,
  ImagePlus,
  Trash2,
  Download,
  Cookie,
  Link2,
  Languages,
} from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Avatar } from '@/components/ui/Avatar'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Title, Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore, type User as AuthUser } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useLanguageStore } from '@/store/languageStore'
import { LANGUAGES } from '@/i18n'
import {
  getBilibiliUserInfo,
  loginBilibiliWithCookie,
  getBilibiliCookie,
  buildBilibiliImageProxyUrl,
  type BilibiliUserInfo,
} from '@/modules/movie-source/resolveSource'
import { useBilibiliQrLogin } from '@/modules/bilibili/useBilibiliQrLogin'
import MountManager from '@/modules/mounts/MountManager'
import ServerFileManager from '@/modules/server-files/ServerFileManager'
import { BilibiliDownloadModal } from '@/modules/server-files/BilibiliDownloadModal'
import { useNcmLogin, ncmVipLabel, type NcmQrStatus } from '@/modules/music'
import { apiFetch } from '@/lib/api'
import { CookieLoginModal } from './profile/CookieLoginModal'
import { useCookieBinding } from './profile/useCookieBinding'
import { t } from '@/i18n'

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
  const language = useLanguageStore((s) => s.language)
  const setLanguage = useLanguageStore((s) => s.setLanguage)

  useEffect(() => {
    if (user?.role === 'guest') {
      navigate('/', { replace: true })
    }
  }, [user, navigate])

  const [bilibiliUser, setBilibiliUser] = useState<BilibiliUserInfo | null>(
    null
  )
  const [bilibiliLoading, setBilibiliLoading] = useState(true)

  // B站视频下载 Popup（root 限定，位于「刷新绑定状态」旁）
  const [biliDownloadOpen, setBiliDownloadOpen] = useState(false)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // ===== 账号绑定（网易云 / B站 平台切换） =====
  const [bindPlatform, setBindPlatform] = useState<'ncm' | 'bilibili'>(
    'bilibili'
  )
  /** 网易云登录状态查询进行中（避免「未绑定」闪现） */
  const [ncmChecking, setNcmChecking] = useState(true)
  const [ncmQrModalOpen, setNcmQrModalOpen] = useState(false)
  // 网易云扫码登录（与一起听模块共享 useMusicStore 登录态，后端凭据同一份）
  const {
    qrImg: ncmQrImg,
    status: ncmQrStatus,
    startLogin: ncmStartLogin,
    stopPolling: ncmStopPolling,
    loginStatus: ncmLoginInfo,
    fetchLoginStatus: ncmFetchLoginStatus,
    logout: ncmLogout,
  } = useNcmLogin()

  /** 网易云会员类型文案（普通/VIP/SVIP；未登录或未知为空串） */
  const ncmVipText = ncmVipLabel(ncmLoginInfo.vipType, ncmLoginInfo.vipStatus)

  /** 网易云扫码状态文案 */
  const NCM_QR_STATUS_TEXT: Record<NcmQrStatus, string> = {
    idle: t('准备中…'),
    generating: t('正在生成二维码…'),
    waiting: t('请使用网易云音乐 App 扫码登录'),
    scanned: t('已扫码，请在手机上确认'),
    success: t('登录成功'),
    error: t('生成二维码失败，请重试'),
  }

  // 进入页面时主动查询网易云登录状态（useMusicStore 是内存态，刷新即丢）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      await ncmFetchLoginStatus()
      if (!cancelled) setNcmChecking(false)
    })()
    return () => {
      cancelled = true
    }
  }, [ncmFetchLoginStatus])

  // 扫码成功：提示并延迟关闭登录弹窗（留出成功反馈的阅读时间）
  useEffect(() => {
    if (ncmQrStatus !== 'success') return
    message.success(t('网易云音乐登录成功'))
    const timer = setTimeout(() => {
      setNcmQrModalOpen(false)
      ncmStopPolling()
    }, 600)
    return () => clearTimeout(timer)
  }, [ncmQrStatus, ncmStopPolling])

  const handleOpenNcmQr = useCallback(() => {
    setNcmQrModalOpen(true)
    void ncmStartLogin()
  }, [ncmStartLogin])

  const handleCloseNcmQr = useCallback(() => {
    setNcmQrModalOpen(false)
    ncmStopPolling()
  }, [ncmStopPolling])

  const handleNcmLogout = useCallback(async () => {
    await ncmLogout()
    message.success(t('已退出网易云音乐登录'))
  }, [ncmLogout])

  // 网易云 Cookie 复制/登录（平台差异经回调注入，交互骨架见 useCookieBinding）
  const ncmCookieBinding = useCookieBinding({
    fetchCookie: async () => {
      const res = await apiFetch('/api/music/ncm-cookie')
      const data = (await res.json()) as { success: boolean; cookie?: string }
      return data.success ? (data.cookie ?? null) : null
    },
    cookieUnavailableMessage: t('未获取到 Cookie，请重新登录网易云音乐'),
    loginWithCookie: async (cookie) => {
      const res = await apiFetch('/api/music/ncm-cookie-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie }),
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
      }
      if (!data.success) {
        throw new Error(data.message ?? t('Cookie 登录失败'))
      }
    },
    loginSuccessMessage: t('网易云音乐 Cookie 登录成功'),
    loginFailedMessage: t('Cookie 登录失败'),
    refreshStatus: ncmFetchLoginStatus,
  })

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

  const {
    qrModalOpen,
    qrDataUrl,
    qrStatus,
    qrMessage,
    handleOpenQrModal,
    handleCloseQrModal,
    handleLogoutBilibili,
  } = useBilibiliQrLogin({
    onLoginSuccess: loadBilibiliUser,
    onLogoutSuccess: () => setBilibiliUser(null),
    logoutErrorMessage: t('退出 B站 登录失败'),
    logTag: 'ProfilePage',
  })

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

  // B站 Cookie 复制/登录（与网易云共用 useCookieBinding 交互骨架）
  const biliCookieBinding = useCookieBinding({
    fetchCookie: () => getBilibiliCookie(),
    cookieUnavailableMessage: t('未获取到 Cookie，请重新登录 B站'),
    loginWithCookie: async (cookie) => {
      await loginBilibiliWithCookie(cookie)
    },
    loginSuccessMessage: t('B站 Cookie 登录成功'),
    loginFailedMessage: t('Cookie 登录失败'),
    refreshStatus: async () => {
      await loadBilibiliUser()
    },
  })

  const handleChangePassword = useCallback(async () => {
    if (!oldPassword || !newPassword) {
      message.warning(t('请填写原密码和新密码'))
      return
    }
    if (newPassword !== confirmPassword) {
      message.error(t('两次输入的新密码不一致'))
      return
    }
    if (newPassword.length < 4) {
      message.error(t('新密码至少 4 位'))
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
        message.success(t('密码修改成功'))
        setOldPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        message.error(data.message ?? t('修改失败'))
      }
    } catch {
      message.error(t('修改密码失败'))
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
      message.warning(t('请输入新用户名'))
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
        message.success(t('用户名修改成功'))
        setUser(data.user)
        setNewUsername('')
      } else {
        message.error(data.message ?? t('修改失败'))
      }
    } catch {
      message.error(t('修改用户名失败'))
    } finally {
      setUsernameLoading(false)
    }
  }, [newUsername, setUser])

  // 头像上传
  const handleAvatarUpload = useCallback(
    async (file: File) => {
      if (user?.role === 'guest') {
        message.warning(t('游客无法设置头像'))
        return
      }
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
      ]
      if (!allowedTypes.includes(file.type)) {
        message.error(t('仅支持 JPG / PNG / GIF / WEBP 格式'))
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        message.error(t('头像文件不能超过 5MB'))
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
          message.success(t('头像更新成功'))
          setUser(data.user)
        } else {
          message.error(data.message ?? t('头像上传失败'))
        }
      } catch {
        message.error(t('头像上传失败'))
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
        message.success(t('头像已删除'))
        setUser(data.user)
      } else {
        message.error(data.message ?? t('删除头像失败'))
      }
    } catch {
      message.error(t('删除头像失败'))
    } finally {
      setAvatarLoading(false)
    }
  }, [setUser])

  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <Spinner tip={t('加载用户信息...')} />
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
            {t('个人中心')}
          </Title>
          <Text type="secondary">
            {t('管理您的 ZViewer 账号、挂载配置与网易云 / B站 账号绑定')}
          </Text>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* ZViewer 账号信息 */}
          <div className="glass-card p-4">
            <SectionHeader
              icon={<Shield className="h-4 w-4" />}
              title={t('ZViewer 账号')}
              className="mb-3"
            />
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
                  {t('编辑信息')}
                </Button>
              </div>
              <Tag
                className="mt-2 py-1"
                color={isAdmin ? 'primary' : 'default'}
                icon={
                  isAdmin ? (
                    <Shield className="h-3 w-3" />
                  ) : (
                    <User className="h-3 w-3" />
                  )
                }
              >
                {isAdmin ? t('管理员') : t('普通用户')}
              </Tag>
            </div>
          </div>

          {/* 界面语言（只存本机，不影响其他用户） */}
          <div className="glass-card p-4">
            <SectionHeader
              icon={<Languages className="h-4 w-4" />}
              title={t('界面语言')}
              tone="tertiary"
              className="mb-3"
            />
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((item) => (
                <Button
                  key={item.value}
                  size="sm"
                  variant={language === item.value ? 'primary' : 'secondary'}
                  onClick={() => setLanguage(item.value)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>

          {/* 账号绑定（网易云 / B站，平台切换展示） */}
          <div className="glass-card p-4">
            <div className="mb-3 flex items-center gap-4">
              <SectionHeader
                icon={<Link2 className="h-4 w-4" />}
                title={t('账号绑定')}
                tone="tertiary"
              />

              {/* 平台切换按钮（M3 segmented 胶囊）：紧贴标题右侧，展示已绑定的 B站 / 网易云账号 */}
              <div
                className="flex items-center rounded-full p-0.5"
                style={{
                  backgroundColor: 'var(--md-sys-color-surface-container)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setBindPlatform('bilibili')}
                  className="flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition-all"
                  style={
                    bindPlatform === 'bilibili'
                      ? {
                          backgroundColor:
                            'var(--md-sys-color-tertiary-container)',
                          color: 'var(--md-sys-color-on-tertiary-container)',
                        }
                      : {
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }
                  }
                >
                  {t('哔哩哔哩')}
                </button>
                <button
                  type="button"
                  onClick={() => setBindPlatform('ncm')}
                  className="flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium transition-all"
                  style={
                    bindPlatform === 'ncm'
                      ? {
                          backgroundColor:
                            'var(--md-sys-color-tertiary-container)',
                          color: 'var(--md-sys-color-on-tertiary-container)',
                        }
                      : {
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }
                  }
                >
                  {t('网易云')}
                </button>
              </div>
            </div>

            {bindPlatform === 'ncm' ? (
              /* ===== 网易云面板 ===== */
              ncmChecking ? (
                <div className="py-4">
                  <Spinner tip={t('加载中...')} size={28} />
                </div>
              ) : ncmLoginInfo.loggedIn ? (
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar
                      size="md"
                      src={ncmLoginInfo.avatarUrl?.replace(
                        'http://',
                        'https://'
                      )}
                      alt={ncmLoginInfo.nickname ?? t('网易云音乐')}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="min-w-0 truncate text-base font-medium text-[var(--md-sys-color-on-surface)]">
                          {ncmLoginInfo.nickname ?? t('网易云音乐用户')}
                        </p>
                        {/* 会员类型标签（两档：VIP / 普通账号） */}
                        {ncmVipText === 'VIP' ? (
                          <Tag
                            color="warning"
                            className="shrink-0 px-1.5 py-0 text-[10px]"
                          >
                            <Crown className="mr-0.5 h-3 w-3" />
                            VIP
                          </Tag>
                        ) : ncmVipText ? (
                          <Tag
                            color="default"
                            className="shrink-0 px-1.5 py-0 text-[10px]"
                          >
                            {t('普通账号')}
                          </Tag>
                        ) : null}
                      </div>
                      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        {t('已绑定网易云音乐账号')}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-8 justify-center px-0"
                      icon={<Cookie className="h-4 w-4" />}
                      onClick={ncmCookieBinding.copyCookie}
                      loading={ncmCookieBinding.copyLoading}
                      title={t(
                        '复制当前绑定的网易云 Cookie（可用于其他设备登录或备份）'
                      )}
                      aria-label={t('复制 Cookie')}
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      className="w-8 justify-center px-0"
                      icon={<LogOut className="h-4 w-4" />}
                      onClick={() => void handleNcmLogout()}
                      title={t('退出网易云音乐登录')}
                      aria-label={t('退登')}
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <Paragraph type="secondary" className="m-0 text-sm">
                    {t('未绑定网易云音乐账号')}
                  </Paragraph>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<QrCode className="h-4 w-4" />}
                      onClick={handleOpenNcmQr}
                    >
                      {t('扫码登录网易云')}
                    </Button>
                    <Button
                      size="sm"
                      icon={<Cookie className="h-4 w-4" />}
                      onClick={ncmCookieBinding.openModal}
                    >
                      {t('Cookie 登录')}
                    </Button>
                  </div>
                </div>
              )
            ) : bilibiliLoading ? (
              <div className="py-4">
                <Spinner tip={t('加载中...')} size={28} />
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
                            {t('普通账号')}
                          </Tag>
                        )}
                      </div>
                      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        {t('已绑定 B站 账号')}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {/* 图标按钮：窄卡片下避免与用户名区争抢宽度导致文字竖排 */}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-8 justify-center px-0"
                      icon={<Cookie className="h-4 w-4" />}
                      onClick={biliCookieBinding.copyCookie}
                      loading={biliCookieBinding.copyLoading}
                      title={t(
                        '复制当前绑定的 B站 Cookie（可用于其他设备登录或备份）'
                      )}
                      aria-label={t('复制 Cookie')}
                    />
                    <Button
                      variant="danger"
                      size="sm"
                      className="w-8 justify-center px-0"
                      icon={<LogOut className="h-4 w-4" />}
                      onClick={handleLogoutBilibili}
                      title={t('退出 B站 登录')}
                      aria-label={t('退登')}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Paragraph type="secondary" className="m-0 text-sm">
                  {t('未绑定 B站 账号')}
                </Paragraph>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<QrCode className="h-4 w-4" />}
                    onClick={handleOpenQrModal}
                  >
                    {t('扫码登录 B站')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Cookie className="h-4 w-4" />}
                    onClick={biliCookieBinding.openModal}
                  >
                    {t('Cookie 登录')}
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

        {(bindPlatform === 'ncm'
          ? !ncmChecking && ncmLoginInfo.loggedIn
          : !bilibiliLoading && bilibiliUser) && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end sm:gap-2">
            {bindPlatform === 'bilibili' && betaFeaturesEnabled && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Download className="h-4 w-4" />}
                onClick={() => setBiliDownloadOpen(true)}
              >
                {t('下载 B站视频')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={() =>
                void (bindPlatform === 'ncm'
                  ? ncmFetchLoginStatus()
                  : loadBilibiliUser())
              }
            >
              {t('刷新绑定状态')}
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
        title={t('扫码登录哔哩哔哩')}
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseQrModal}>
            {t('关闭')}
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('哔哩哔哩登录二维码')}
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
              <Spinner tip={t('正在生成二维码…')} size={28} />
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
              {t('重新获取二维码')}
            </Button>
          )}
        </div>
      </Modal>

      {/* Cookie 登录 Modal */}
      <CookieLoginModal
        open={biliCookieBinding.modalOpen}
        onClose={biliCookieBinding.closeModal}
        title={t('Cookie 登录哔哩哔哩')}
        instructions={[
          t('1. 在浏览器中登录 bilibili.com'),
          t('2. 按 F12 打开开发者工具 → Application → Cookies'),
          t('3. 复制全部 Cookie（至少需包含 SESSDATA）'),
        ]}
        placeholder={t(
          '粘贴 B站 Cookie，如：SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx'
        )}
        input={biliCookieBinding.cookieInput}
        onInputChange={biliCookieBinding.setCookieInput}
        loading={biliCookieBinding.loginLoading}
        onSubmit={biliCookieBinding.loginWithCookieInput}
      />

      {/* 网易云扫码登录 Modal（与一起听模块共用 useNcmLogin 与后端凭据） */}
      <Modal
        open={ncmQrModalOpen}
        onClose={handleCloseNcmQr}
        title={t('扫码登录网易云音乐')}
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseNcmQr}>
            {t('关闭')}
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {ncmQrImg ? (
            <img
              src={ncmQrImg}
              alt={t('网易云音乐登录二维码')}
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
              <Spinner tip={t('正在生成二维码…')} size={28} />
            </div>
          )}
          <Paragraph
            className={`m-0 text-sm ${
              ncmQrStatus === 'success'
                ? 'text-[var(--md-sys-color-secondary)]'
                : ncmQrStatus === 'error'
                  ? 'text-[var(--md-sys-color-error)]'
                  : ''
            }`}
          >
            {NCM_QR_STATUS_TEXT[ncmQrStatus]}
          </Paragraph>
          {ncmQrStatus === 'error' && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void ncmStartLogin()}
            >
              {t('重新获取二维码')}
            </Button>
          )}
        </div>
      </Modal>

      {/* 网易云 Cookie 登录 Modal */}
      <CookieLoginModal
        open={ncmCookieBinding.modalOpen}
        onClose={ncmCookieBinding.closeModal}
        title={t('Cookie 登录网易云音乐')}
        instructions={[
          t('1. 在浏览器中登录 music.163.com'),
          t('2. 按 F12 打开开发者工具 → Application → Cookies'),
          t('3. 复制 Cookie（至少需包含 MUSIC_U），登录态有效性会在提交时校验'),
        ]}
        placeholder={t('粘贴网易云 Cookie，如：MUSIC_U=xxx; __csrf=xxx')}
        input={ncmCookieBinding.cookieInput}
        onInputChange={ncmCookieBinding.setCookieInput}
        loading={ncmCookieBinding.loginLoading}
        onSubmit={ncmCookieBinding.loginWithCookieInput}
      />

      <Modal
        open={editInfoModalOpen}
        onClose={() => setEditInfoModalOpen(false)}
        title={t('编辑账号信息')}
        className="max-w-2xl"
        footer={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setEditInfoModalOpen(false)}
          >
            {t('关闭')}
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
                  <ImagePlus
                    className="h-4 w-4"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                </span>
                <div className="flex min-w-0 flex-col">
                  <Text className="text-sm font-semibold leading-tight">
                    {t('修改头像')}
                  </Text>
                  <Text
                    type="secondary"
                    className="text-[10px] uppercase tracking-wide"
                  >
                    {t('上传自定义头像图片')}
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
                      icon={<ImagePlus className="h-3.5 w-3.5" />}
                      loading={avatarLoading}
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      {user.avatar ? t('更换头像') : t('上传头像')}
                    </Button>
                    {user.avatar && (
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        disabled={avatarLoading}
                        onClick={() => setAvatarDeleteTarget(true)}
                      >
                        {t('删除头像')}
                      </Button>
                    )}
                  </div>
                </div>
                <Text type="secondary" className="text-[10px] leading-relaxed">
                  {t('支持 JPG / PNG / GIF / WEBP，最大 5MB')}
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
                    <UserPen
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-semibold leading-tight">
                      {t('修改用户名')}
                    </Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      {t('更改登录账户名称')}
                    </Text>
                  </div>
                </div>
                <div className="flex flex-col gap-2.5 px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                      {t('新用户名')}
                    </label>
                    <Input
                      size="sm"
                      placeholder={t('请输入新用户名')}
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
                    icon={<UserPen className="h-4 w-4" />}
                    onClick={() => void handleChangeUsername()}
                    className="mt-1"
                  >
                    {t('确认修改')}
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
                  {t('修改密码')}
                </Text>
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  {t('更新账户登录密码')}
                </Text>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('原密码')}
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder={t('请输入原密码')}
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('新密码')}
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder={t('至少 4 位')}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('确认新密码')}
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder={t('再次输入新密码')}
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
                {t('确认修改')}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={avatarDeleteTarget}
        onClose={() => setAvatarDeleteTarget(false)}
        title={t('删除头像')}
        okText={t('删除')}
        onOk={() => void handleAvatarDelete()}
        onCancel={() => setAvatarDeleteTarget(false)}
      >
        <Text className="text-sm">
          {t('确定要删除当前头像并恢复默认头像吗？')}
        </Text>
      </ConfirmModal>
    </div>
  )
}
