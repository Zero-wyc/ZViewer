import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Shield, UserPlus, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'
import { apiFetch, resetSessionExpired, saveAuthTokens } from '@/lib/api'
import { reconnectSocket } from '@/hooks/useSocket'
import { cn } from '@/lib/utils'

const Fade = ({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) => (
  <div
    className={cn('zen-stagger-fade-up', className)}
    style={{ '--stagger-delay': `${delay}ms` } as React.CSSProperties}
  >
    {children}
  </div>
)

interface AuthForm {
  username: string
  password: string
}

type AuthMode = 'login' | 'register'

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login, isAuthenticated } = useAuthStore()
  const [mode, setMode] = useState<AuthMode>('login')
  const [form, setForm] = useState<AuthForm>({ username: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [registrationMode, setRegistrationMode] = useState<
    'open' | 'approval' | 'closed'
  >('approval')

  const from = (location.state as { from?: { pathname?: string } } | null)?.from
    ?.pathname

  const isLogin = mode === 'login'

  // 首访兜底：从受保护页面（房间链接等）被 RequireAuth 重定向而来时
  // location.state.from 记录了原目标。若认证在停留在本页期间完成——
  // 典型是 AuthInitializer 的游客自动登录——则自动返回原地址，
  // 避免「房间链接要输两次地址才能进」。直接访问 /login（无 from）
  // 的用户不受影响，可安心手动登录/注册。
  useEffect(() => {
    if (from && isAuthenticated) {
      navigate(from, { replace: true })
    }
  }, [from, isAuthenticated, navigate])

  useEffect(() => {
    const fetchMode = async () => {
      try {
        const res = await apiFetch('/api/auth/registration-mode')
        const data = (await res.json()) as {
          success: boolean
          mode?: 'open' | 'approval' | 'closed'
        }
        if (data.success && data.mode) {
          setRegistrationMode(data.mode)
        }
      } catch (err) {
        console.error('[LoginPage] fetch registration mode error:', err)
      }
    }
    void fetchMode()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.username.trim() || !form.password) {
      message.warning('请输入用户名和密码')
      return
    }

    if (!isLogin && form.password.length < 4) {
      message.warning('密码至少 4 位')
      return
    }

    setLoading(true)
    try {
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register'
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = (await res.json()) as {
        success: boolean
        user?: {
          id: string
          username: string
          role: string
          status?: 'active' | 'pending'
        }
        accessToken?: string
        refreshToken?: string
        message?: string
      }

      if (data.success && data.user) {
        if (!isLogin && data.user.status === 'pending') {
          message.success(data.message || '注册成功，请等待管理员审核')
          setMode('login')
          return
        }
        // 保存返回的 token（跨站 HTTP / 直连场景 cookie 不可用时 fallback 到 Bearer 头）
        saveAuthTokens(data.accessToken, data.refreshToken)
        // 登录成功 → 重置 session 过期标志，允许后续 401 时再次尝试 refresh
        resetSessionExpired()
        login({
          id: data.user.id,
          username: data.user.username,
          role: data.user.role as import('@/store/authStore').UserRole,
          status: data.user.status,
        })
        // 登录后 Socket 需要断开重连，以新的认证凭据重新握手，
        // 否则后端 socket.data.role 仍为旧角色（如 guest），导致创建房间等操作被拒绝。
        reconnectSocket()
        message.success(isLogin ? '登录成功' : '注册成功')
        navigate(from || '/', { replace: true })
      } else {
        message.error(data.message || (isLogin ? '登录失败' : '注册失败'))
      }
    } catch (err) {
      console.error('[LoginPage] auth error:', err)
      message.error(isLogin ? '登录请求失败' : '注册请求失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card
        className="w-full max-w-sm"
        style={{
          // 登录卡片使用更强的背景模糊，突出主体层次
          backdropFilter: 'blur(var(--glass-blur-strong))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
        }}
      >
        <div className="text-center mb-6">
          <Fade delay={80} className="inline-block">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
                boxShadow:
                  '0 8px 24px -6px color-mix(in srgb, var(--md-sys-color-primary) 30%, transparent)',
              }}
            >
              <Shield className="w-6 h-6" />
            </div>
          </Fade>
          <Fade delay={120} key={`login-title-${mode}`}>
            <Title level={3} className="m-0 mt-4">
              {isLogin ? '登录 ZViewer' : '注册账号'}
            </Title>
            <Paragraph type="secondary" className="m-0 mt-2">
              {isLogin
                ? '管理员账号可创建共享房间'
                : registrationMode === 'closed'
                  ? '当前已关闭注册'
                  : registrationMode === 'open'
                    ? '注册后即可使用'
                    : '注册后需管理员审核通过，方可成为普通用户'}
            </Paragraph>
          </Fade>
        </div>

        <form onSubmit={handleSubmit}>
          <Space direction="vertical" className="w-full">
            <Fade delay={180} className="w-full">
              <Input
                label="用户名"
                type="text"
                value={form.username}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, username: e.target.value }))
                }
                placeholder="请输入用户名"
                size="lg"
              />
            </Fade>

            <Fade delay={220} className="w-full">
              <InputPassword
                label="密码"
                value={form.password}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, password: e.target.value }))
                }
                placeholder={isLogin ? '请输入密码' : '至少 4 位密码'}
                size="lg"
              />
            </Fade>

            <Fade delay={280} className="w-full">
              <Button
                variant="primary"
                type="submit"
                block
                loading={loading}
                icon={
                  isLogin ? (
                    <LogIn className="w-4 h-4" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )
                }
                className="mt-2"
              >
                {isLogin ? '登录' : '注册'}
              </Button>
            </Fade>
          </Space>
        </form>

        <Fade delay={340} key={`login-switch-${mode}`}>
          <div className="mt-6 text-center">
            {isLogin ? (
              registrationMode === 'closed' ? (
                <Paragraph type="secondary" className="text-xs m-0">
                  当前站点已关闭新用户注册
                </Paragraph>
              ) : (
                <Paragraph type="secondary" className="text-xs m-0">
                  还没有账号？{' '}
                  <button
                    type="button"
                    onClick={() => setMode('register')}
                    className="underline hover:opacity-80"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  >
                    注册账号
                  </button>
                </Paragraph>
              )
            ) : (
              <Paragraph type="secondary" className="text-xs m-0">
                已有账号？{' '}
                <button
                  type="button"
                  onClick={() => setMode('login')}
                  className="underline hover:opacity-80"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                >
                  返回登录
                </button>
              </Paragraph>
            )}
          </div>
        </Fade>
      </Card>
    </div>
  )
}
