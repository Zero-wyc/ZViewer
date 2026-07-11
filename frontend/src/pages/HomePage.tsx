import { useNavigate } from 'react-router-dom'
import {
  Share2,
  PlayCircle,
  Shield,
  LayoutDashboard,
  Wifi,
  WifiOff,
  Settings,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { useAuthStore } from '@/store/authStore'
import { useSocket } from '@/hooks/useSocket'

function HomePage() {
  const navigate = useNavigate()
  const { isAuthenticated, user } = useAuthStore()
  const { connected } = useSocket()

  const isAdmin = user?.role === 'admin'

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <div className="mb-6">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
              boxShadow:
                '0 12px 32px -8px color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent)',
            }}
          >
            <span className="text-3xl font-bold">Z</span>
          </div>
          <Title level={2} className="m-0">
            ZViewer
          </Title>
          <Paragraph type="secondary" className="m-0 mt-2">
            远程屏幕共享与控制平台
          </Paragraph>
        </div>

        <Space direction="vertical" className="w-full px-1">
          {!isAuthenticated ? (
            <>
              <Paragraph className="m-0 text-sm">
                未登录，部分功能不可用
              </Paragraph>
              <Button
                variant="primary"
                size="lg"
                icon={<PlayCircle className="h-5 w-5" />}
                block
                onClick={() => navigate('/login')}
              >
                登录 / 注册
              </Button>
              <Paragraph type="secondary" className="text-xs m-0">
                默认管理员账号：root / root
              </Paragraph>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                size="lg"
                icon={<Share2 className="h-5 w-5" />}
                block
                disabled={!isAdmin}
                onClick={() => isAdmin && navigate('/room?role=host')}
              >
                开始共享
              </Button>
              {!isAdmin && (
                <Paragraph type="secondary" className="text-xs m-0">
                  仅管理员可创建房间
                </Paragraph>
              )}
              <Button
                size="lg"
                icon={<PlayCircle className="h-5 w-5" />}
                block
                onClick={() => navigate('/room')}
              >
                加入房间
              </Button>
              <Button
                size="lg"
                icon={<LayoutDashboard className="h-5 w-5" />}
                block
                onClick={() => navigate('/rooms')}
              >
                房间列表
              </Button>

              {isAdmin && (
                <>
                  <div
                    className="w-full my-1"
                    style={{
                      height: '1px',
                      backgroundColor:
                        'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                    }}
                  />
                  <Button
                    variant="secondary"
                    size="lg"
                    icon={<Shield className="h-5 w-5" />}
                    block
                    onClick={() => navigate('/admin')}
                  >
                    权限管理
                  </Button>
                </>
              )}
            </>
          )}
        </Space>

        {isAuthenticated && (
          <div className="mt-6 flex flex-col items-center gap-2">
            <div
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
              style={{
                backgroundColor: 'var(--md-sys-color-surface-container-high)',
                color: 'var(--md-sys-color-on-surface)',
                border: '1px solid var(--md-sys-color-outline)',
              }}
            >
              {isAdmin ? (
                <>
                  <Shield
                    className="w-3.5 h-3.5"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                  管理员：{user.username}
                </>
              ) : (
                <>当前用户：{user.username}</>
              )}
            </div>
            {connected ? (
              <div
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-secondary) 12%, transparent)',
                  color: 'var(--md-sys-color-secondary)',
                  border:
                    '1px solid color-mix(in srgb, var(--md-sys-color-secondary) 25%, transparent)',
                }}
              >
                <Wifi className="w-3.5 h-3.5" />
                已连接
              </div>
            ) : (
              <div
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-error) 12%, transparent)',
                  color: 'var(--md-sys-color-error)',
                  border:
                    '1px solid color-mix(in srgb, var(--md-sys-color-error) 25%, transparent)',
                }}
              >
                <WifiOff className="w-3.5 h-3.5" />
                连接断开
              </div>
            )}
          </div>
        )}

        <div className="mt-5 flex items-center justify-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
          <Settings className="h-3 w-3" />
          <span>主题设置可在右上角菜单中调整</span>
        </div>
      </Card>
    </div>
  )
}

export default HomePage
