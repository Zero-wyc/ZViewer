import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  LayoutDashboard,
  LayoutGrid,
  List,
  Lock,
  Unlock,
  RefreshCw,
  PlayCircle,
  Shield,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'

interface RoomItem {
  id: number
  roomId: string
  name: string | null
  status: 'active' | 'closed'
  requireApproval: boolean
  maxViewers: number
  hasPassword: boolean
  viewerCount: number
  sharerOnline: boolean
  mode: 'screen-share' | 'watch-together' | 'bili-compat'
  lastAccessedAt: string
  createdAt: string
}

const rawApiUrl = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '')
const API_URL = rawApiUrl || window.location.origin

export default function RoomsListPage() {
  const navigate = useNavigate()
  const { accessToken, user } = useAuthStore()
  const [rooms, setRooms] = useState<RoomItem[]>([])
  const [loading, setLoading] = useState(false)
  const [viewMode, setViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('rooms-list-view-mode')
    return saved === 'tile' ? 'tile' : 'list'
  })
  const isAdmin = user?.role === 'admin'

  const authHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  }

  const fetchRooms = async () => {
    const res = await fetch(`${API_URL}/api/rooms`, {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      rooms?: RoomItem[]
      message?: string
    }
    if (data.success && data.rooms) {
      setRooms(data.rooms)
    } else {
      message.error(data.message ?? '获取房间列表失败')
    }
  }

  const loadData = async () => {
    setLoading(true)
    try {
      await fetchRooms()
    } catch (err) {
      console.error('[RoomsListPage] load data error:', err)
      message.error('加载数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!accessToken) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        await fetchRooms()
      } catch (err) {
        if (!cancelled) {
          console.error('[RoomsListPage] load data error:', err)
          message.error('加载数据失败')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }
    void load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken])

  const formatDate = (iso: string) => new Date(iso).toLocaleString('zh-CN')

  const getModeLabel = (mode: RoomItem['mode']) => {
    if (mode === 'watch-together') return '一起看'
    if (mode === 'bili-compat') return 'B站兼容'
    return '屏幕共享'
  }

  return (
    <div className="flex-1 p-4 sm:p-6">
      <Card className="mx-auto w-full max-w-5xl">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate('/')}
          className="absolute left-4 top-4"
        >
          返回
        </Button>

        <div className="mb-6 text-center">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            <LayoutDashboard className="h-6 w-6" />
          </div>
          <Title level={3} className="m-0">
            房间列表
          </Title>
          <Text type="secondary">浏览并加入当前可用的房间</Text>
        </div>

        <Space justify="between" align="center" className="mb-4">
          <Text type="secondary">共 {rooms.length} 个房间</Text>
          <Space>
            <div className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5" style={{ borderColor: 'var(--md-sys-color-outline)' }}>
              <button
                type="button"
                onClick={() => {
                  setViewMode('list')
                  localStorage.setItem('rooms-list-view-mode', 'list')
                }}
                className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
                style={{
                  backgroundColor: viewMode === 'list' ? 'var(--md-sys-color-primary-container)' : 'transparent',
                  color: viewMode === 'list' ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-on-surface)',
                }}
                aria-label="列表视图"
                title="列表视图"
              >
                <List className="h-4 w-4" />
                <span className="hidden sm:inline">列表</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setViewMode('tile')
                  localStorage.setItem('rooms-list-view-mode', 'tile')
                }}
                className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
                style={{
                  backgroundColor: viewMode === 'tile' ? 'var(--md-sys-color-primary-container)' : 'transparent',
                  color: viewMode === 'tile' ? 'var(--md-sys-color-on-primary-container)' : 'var(--md-sys-color-on-surface)',
                }}
                aria-label="平铺视图"
                title="平铺视图"
              >
                <LayoutGrid className="h-4 w-4" />
                <span className="hidden sm:inline">平铺</span>
              </button>
            </div>
            {isAdmin && (
              <Button
                variant="primary"
                size="sm"
                icon={<Shield className="h-4 w-4" />}
                onClick={() => navigate('/admin')}
              >
                管理后台
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" />}
              onClick={loadData}
              disabled={loading}
            >
              刷新
            </Button>
          </Space>
        </Space>

        {loading ? (
          <div className="py-12">
            <Spinner tip="加载中..." size={32} />
          </div>
        ) : (
          <div
            className={
              viewMode === 'tile'
                ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'
                : 'grid gap-3'
            }
          >
            {rooms.length === 0 ? (
              <div className="col-span-full py-12 text-center">
                <Text type="secondary">暂无可用房间</Text>
              </div>
            ) : (
              rooms.map((room) => (
                <div
                  key={room.id}
                  className={
                    viewMode === 'tile'
                      ? 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors'
                      : 'flex flex-col gap-3 rounded-[var(--md-sys-shape-corner)] border p-4 transition-colors sm:flex-row sm:items-center sm:justify-between'
                  }
                  style={{
                    borderColor: 'var(--md-sys-color-outline)',
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-[var(--md-sys-color-on-surface)]">
                        {room.name || room.roomId}
                      </span>
                      <Tag color="success">进行中</Tag>
                      {room.requireApproval ? (
                        <Tag color="warning">需确认</Tag>
                      ) : (
                        <Tag color="cyan">直接加入</Tag>
                      )}
                      {room.hasPassword ? (
                        <Tag color="purple">
                          <Lock className="mr-1 inline h-3 w-3" />
                          有密码
                        </Tag>
                      ) : (
                        <Tag color="default">
                          <Unlock className="mr-1 inline h-3 w-3" />
                          无密码
                        </Tag>
                      )}
                      <Tag color="default">{getModeLabel(room.mode)}</Tag>
                    </div>
                    <Text
                      type="secondary"
                      className={
                        viewMode === 'tile'
                          ? 'mt-2 text-xs leading-relaxed'
                          : 'text-xs'
                      }
                    >
                      房间 ID: {room.roomId}
                      {viewMode === 'tile' ? <br /> : ' · '}观众{' '}
                      {room.viewerCount} / {room.maxViewers}
                      {viewMode === 'tile' ? <br /> : ' · '}分享端
                      {room.sharerOnline ? '在线' : '离线'}
                      {viewMode === 'tile' ? <br /> : ' · '}创建于{' '}
                      {formatDate(room.createdAt)}
                      {viewMode === 'tile' ? <br /> : ' · '}最后访问{' '}
                      {formatDate(room.lastAccessedAt)}
                    </Text>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    className={viewMode === 'tile' ? 'mt-auto w-full' : ''}
                    icon={<PlayCircle className="h-4 w-4" />}
                    onClick={() => navigate(`/room/${room.roomId}`)}
                    disabled={room.status !== 'active'}
                  >
                    加入房间
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </Card>
    </div>
  )
}
