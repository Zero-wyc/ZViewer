import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Share2,
  PlayCircle,
  Shield,
  LayoutDashboard,
  Wifi,
  WifiOff,
  Loader2,
  Settings,
  User,
  PanelRightOpen,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useSocket } from '@/hooks/useSocket'
import { useHideBodyScrollbar } from '@/hooks/useHideBodyScrollbar'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'

/** 主页快捷房间面板的房间条目（/api/rooms 返回结构子集） */
interface QuickRoomItem {
  roomId: string
  name: string | null
  status: 'active' | 'closed'
  maxViewers: number
  hasPassword: boolean
  viewerCount: number
  sharerOnline: boolean
  mode: 'screen-share' | 'watch-together'
}

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

function HomePage() {
  // 隐藏浏览器最右侧滚动条（复用房间列表/管理后台的视觉隐藏方案）
  useHideBodyScrollbar()
  const navigate = useNavigate()
  const { user, autoLoginStatus } = useAuthStore()
  const { connected } = useSocket()
  const { roomCreationMode } = useSystemSettingsStore()

  const isRoot = user?.role === 'root'
  const isAdmin = user?.role === 'admin' || isRoot
  const isGuest = user?.role === 'guest'
  // 创建房间权限由系统设置 roomCreationMode 决定，禁止在此处硬编码角色判断。
  // - guest 始终禁止
  // - admin-only：仅 root / admin
  // - all-users：root / admin / user
  const canCreateRoom =
    !isGuest && (isAdmin || roomCreationMode === 'all-users')

  // 连接状态区分三种情况：
  // 1. autoLogin 未完成 / socket 刚创建还未建立连接 → "连接中…"
  //    （避免在认证完成瞬间、socket.connect() 发起到 connect 事件触发之间
  //     误显示"连接断开"）
  // 2. socket 已连接 → "已连接"
  // 3. autoLogin 完成 + socket 已存在 + 连接建立后断开 → "连接断开"
  //
  // 实现方式：autoLogin done 后延迟 1.5s 才允许显示"断开"，
  // 给 socket.io 足够的握手时间（含 websocket 升级 + 后端认证中间件）。
  const [allowDisconnected, setAllowDisconnected] = useState(false)
  // React Compiler 严格规则误报：根据 autoLogin 状态同步显示标记。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (autoLoginStatus !== 'done') {
      setAllowDisconnected(false)
      return
    }
    // autoLogin 完成后延迟 1.5s 启用"断开"显示
    const timer = setTimeout(() => setAllowDisconnected(true), 1500)
    return () => clearTimeout(timer)
  }, [autoLoginStatus])
  /* eslint-enable react-hooks/set-state-in-effect */

  const isConnecting =
    autoLoginStatus !== 'done' || (!connected && !allowDisconnected)

  // ===== 快捷房间面板：主卡右侧延伸面板，展示当前存在的房间 =====
  const [roomsPanelOpen, setRoomsPanelOpen] = useState(false)
  const [quickRooms, setQuickRooms] = useState<QuickRoomItem[]>([])
  const [roomsLoading, setRoomsLoading] = useState(false)

  const fetchQuickRooms = async () => {
    setRoomsLoading(true)
    try {
      const res = await apiFetch('/api/rooms')
      const data = (await res.json()) as {
        success: boolean
        rooms?: QuickRoomItem[]
      }
      if (data.success && data.rooms) {
        // 只展示进行中的房间
        setQuickRooms(data.rooms.filter((r) => r.status === 'active'))
      }
    } catch (err) {
      console.error('[HomePage] fetch quick rooms error:', err)
    } finally {
      setRoomsLoading(false)
    }
  }

  const toggleRoomsPanel = () => {
    // 移动端（<md）无右侧延伸空间：直接跳转房间列表页
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      navigate('/rooms')
      return
    }
    const next = !roomsPanelOpen
    setRoomsPanelOpen(next)
    if (next) void fetchQuickRooms()
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      {/* 单一 Card 容器：主内容与右侧房间面板同处一张卡，
          面板在卡内以宽度 0↔300px 展开，天然无缝、圆角一致 */}
      <Card className="relative flex items-stretch overflow-hidden !p-0">
        {/* 主内容区：固定 28rem 宽，不随面板收展变化 */}
        <div className="relative w-[28rem] max-w-[calc(100vw-3rem)] p-4 text-center md:p-6">
          {/* 快捷房间面板触发按钮：卡片右上角，桌面端向右延伸面板，
            移动端无延伸空间直接跳转房间列表页 */}
          <button
            type="button"
            onClick={toggleRoomsPanel}
            className={cn(
              'absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)] border transition-all duration-200 hover:scale-105 active:scale-95',
              roomsPanelOpen
                ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
            )}
            style={{
              borderColor: 'var(--md-sys-color-outline-variant)',
              backgroundColor: roomsPanelOpen ? undefined : 'var(--glass-bg)',
            }}
            title="当前房间"
            aria-label="查看当前房间列表"
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
          <div className="mb-6">
            <Fade delay={80} className="inline-block">
              <img
                src="/favicon.jpg"
                alt="ZViewer"
                className="w-16 h-16 rounded-2xl mx-auto object-cover"
                style={{
                  boxShadow:
                    '0 12px 32px -8px color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent)',
                }}
              />
            </Fade>
            <Fade delay={120}>
              <Title level={2} className="m-0">
                ZViewer
              </Title>
              <Paragraph type="secondary" className="m-0 mt-2">
                多人同步追番、观影与远程共享平台
              </Paragraph>
            </Fade>
          </div>

          <Space direction="vertical" className="w-full px-1">
            {isGuest ? (
              <>
                <Fade delay={180}>
                  <Paragraph className="m-0 text-sm">
                    当前以游客身份访问，可加入房间观看、发送评论与弹幕
                  </Paragraph>
                </Fade>
                <Fade delay={220} className="w-full">
                  <Button
                    size="lg"
                    icon={<LayoutDashboard className="h-5 w-5" />}
                    block
                    onClick={() => navigate('/rooms')}
                  >
                    房间列表
                  </Button>
                </Fade>
                <Fade delay={260} className="w-full">
                  <Button
                    variant="primary"
                    size="lg"
                    icon={<PlayCircle className="h-5 w-5" />}
                    block
                    onClick={() => navigate('/join')}
                  >
                    加入房间
                  </Button>
                </Fade>
                <Fade delay={300}>
                  <Paragraph type="secondary" className="text-xs m-0">
                    登录后可保留历史与身份，注册后需管理员审核
                  </Paragraph>
                </Fade>
              </>
            ) : (
              <>
                <Fade delay={180} className="w-full">
                  <Button
                    variant="primary"
                    size="lg"
                    icon={<Share2 className="h-5 w-5" />}
                    block
                    disabled={!canCreateRoom}
                    onClick={() => canCreateRoom && navigate('/room')}
                  >
                    开始共享
                  </Button>
                </Fade>
                {!canCreateRoom && (
                  <Fade delay={220}>
                    <Paragraph type="secondary" className="text-xs m-0">
                      {isGuest
                        ? '登录后可创建房间'
                        : '当前仅管理员可创建房间，请联系管理员开启权限'}
                    </Paragraph>
                  </Fade>
                )}
                <Fade delay={260} className="w-full">
                  <Button
                    size="lg"
                    icon={<LayoutDashboard className="h-5 w-5" />}
                    block
                    onClick={() => navigate('/rooms')}
                  >
                    房间列表
                  </Button>
                </Fade>
                <Fade delay={300} className="w-full">
                  <Button
                    size="lg"
                    icon={<PlayCircle className="h-5 w-5" />}
                    block
                    onClick={() => navigate('/join')}
                  >
                    加入房间
                  </Button>
                </Fade>

                {isAdmin && (
                  <Fade delay={360} className="w-full">
                    <Button
                      variant="secondary"
                      size="lg"
                      icon={<Shield className="h-5 w-5" />}
                      block
                      onClick={() => navigate('/admin')}
                    >
                      权限管理
                    </Button>
                  </Fade>
                )}
              </>
            )}
          </Space>

          <Fade delay={400}>
            <div className="mt-6 flex flex-col items-center gap-2">
              {user ? (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--glass-bg)',
                    color: 'var(--md-sys-color-on-surface)',
                    border: '1px solid var(--md-sys-color-outline)',
                  }}
                >
                  {isRoot ? (
                    <>
                      <Shield
                        className="w-3.5 h-3.5"
                        style={{ color: 'var(--md-sys-color-primary)' }}
                      />
                      超级管理员：{user.username}
                    </>
                  ) : isAdmin ? (
                    <>
                      <Shield
                        className="w-3.5 h-3.5"
                        style={{ color: 'var(--md-sys-color-primary)' }}
                      />
                      管理员：{user.username}
                    </>
                  ) : (
                    <>
                      <User className="w-3.5 h-3.5" />
                      当前用户：{user.username}
                    </>
                  )}
                </div>
              ) : (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                  style={{
                    backgroundColor: 'var(--glass-bg)',
                    color: 'var(--md-sys-color-on-surface-variant)',
                    border: '1px solid var(--md-sys-color-outline)',
                  }}
                >
                  <WifiOff className="w-3.5 h-3.5" />
                  正在校验登录状态…
                </div>
              )}
              {connected ? (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
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
              ) : isConnecting ? (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                    color: 'var(--md-sys-color-primary)',
                    border:
                      '1px solid color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                  }}
                >
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  连接中…
                </div>
              ) : (
                <div
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium"
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
          </Fade>

          <Fade delay={460}>
            <div className="mt-5 flex items-center justify-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              <Settings className="h-3 w-3" />
              <span>主题设置可在右上角菜单中调整</span>
            </div>
          </Fade>
        </div>

        {/* 卡内右侧房间面板：与主内容同一 Card，仅以左分隔线区隔 */}
        <div
          className="relative hidden shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:block"
          style={{
            width: roomsPanelOpen ? 300 : 0,
            willChange: 'width',
          }}
        >
          <div
            className={cn(
              'absolute inset-y-0 left-0 flex w-[300px] flex-col border-l border-[var(--md-sys-color-outline-variant)] transition-opacity duration-300',
              roomsPanelOpen ? 'opacity-100' : 'opacity-0'
            )}
            aria-hidden={!roomsPanelOpen}
          >
            <div className="flex flex-none items-center gap-2 border-b border-[var(--md-sys-color-outline-variant)] px-4 py-3">
              <LayoutDashboard className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
              <span className="flex-1 text-sm font-semibold text-[var(--md-sys-color-on-surface)]">
                当前房间
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums"
                style={{
                  backgroundColor:
                    'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                  color: 'var(--md-sys-color-primary)',
                }}
              >
                {roomsLoading ? '…' : `${quickRooms.length} 个进行中`}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {roomsLoading ? (
                <div className="flex h-20 items-center justify-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  加载中…
                </div>
              ) : quickRooms.length === 0 ? (
                <div className="flex h-20 items-center justify-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  暂无进行中的房间
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {quickRooms.map((room) => (
                    <button
                      key={room.roomId}
                      type="button"
                      className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline-variant)] bg-[color-mix(in_srgb,var(--md-sys-color-surface-container)_45%,transparent)] p-3 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--md-sys-color-outline)] hover:shadow-md"
                      onClick={() =>
                        navigate(
                          `/join?roomId=${encodeURIComponent(room.roomId)}`
                        )
                      }
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            room.sharerOnline
                              ? 'bg-[var(--md-sys-color-primary)]'
                              : 'bg-[var(--md-sys-color-outline-variant)]'
                          )}
                          style={
                            room.sharerOnline
                              ? {
                                  boxShadow:
                                    '0 0 6px color-mix(in srgb, var(--md-sys-color-primary) 70%, transparent)',
                                }
                              : undefined
                          }
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--md-sys-color-on-surface)]">
                          {room.name || room.roomId}
                        </span>
                        {room.hasPassword && (
                          <Shield className="h-3.5 w-3.5 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
                        )}
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                          style={{
                            backgroundColor:
                              'color-mix(in srgb, var(--md-sys-color-secondary) 12%, transparent)',
                            color: 'var(--md-sys-color-secondary)',
                          }}
                        >
                          {room.mode === 'screen-share' ? '投屏' : '一起看'}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 pl-4 text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
                        <span className="tabular-nums">{room.roomId}</span>
                        <span className="flex items-center gap-0.5">
                          <Users className="h-3 w-3" />
                          {room.viewerCount}/{room.maxViewers}
                        </span>
                        <span
                          className={cn(
                            'ml-auto',
                            room.sharerOnline &&
                              'text-[var(--md-sys-color-primary)]'
                          )}
                        >
                          {room.sharerOnline ? '分享中' : '已离线'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="flex-none border-t border-[var(--md-sys-color-outline-variant)] p-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<LayoutDashboard className="h-3.5 w-3.5" />}
                block
                onClick={() => navigate('/rooms')}
              >
                查看全部房间
              </Button>
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}

export default HomePage
