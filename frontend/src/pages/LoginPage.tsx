import { useState } from 'react'
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
import { apiFetch, API_URL } from '@/lib/api'
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

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
void rawApiUrl

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuthStore()
  const [mode, setMode] = useState<AuthMode>('login')
  const [form, setForm] = useState<AuthForm>({ username: '', password: '' })
  const [loading, setLoading] = useState(false)

  const from = (location.state as { from?: { pathname?: string } } | null)?.from
    ?.pathname

  const isLogin = mode === 'login'

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
      const res = await apiFetch(`${API_URL}${endpoint}`, {
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
        message?: string
      }

      if (data.success && data.user) {
        login({
          id: data.user.id,
          username: data.user.username,
          role: data.user.role as import('@/store/authStore').UserRole,
          status: data.user.status,
        })
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
      <Card className="w-full max-w-sm">
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
                : '注册后需 root 审核通过，方可成为普通用户'}
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
