import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Monitor, Users, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Switch } from '@/components/ui/Switch'
import { Input } from '@/components/ui/Input'
import { useRoomStore, type RoomMode } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'

interface RoomPanelProps {
  onModeSelected?: (mode: RoomMode) => void
}

export function RoomPanel({ onModeSelected }: RoomPanelProps) {
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const { setMode, setRoomId } = useRoomStore()
  const [selectedMode, setSelectedMode] = useState<RoomMode>('screen-share')
  const [creating, setCreating] = useState(false)
  const [requireApproval, setRequireApproval] = useState(true)
  const [password, setPassword] = useState('')

  const handleCreateRoom = () => {
    if (!socket || !connected) {
      message.warning('Socket 尚未连接')
      return
    }
    setCreating(true)
    socket.emit(
      'create-room',
      {
        password: password || undefined,
        requireApproval,
        mode: selectedMode,
      },
      (response: {
        success: boolean
        roomId?: string
        mode?: RoomMode
        message?: string
      }) => {
        setCreating(false)
        if (response.success && response.roomId) {
          setRoomId(response.roomId)
          setMode(response.mode || selectedMode)
          message.success('房间创建成功')
          const mode = response.mode || selectedMode
          const params = new URLSearchParams(window.location.search)
          params.set('role', 'host')
          params.set('mode', mode)
          navigate(`/room/${response.roomId}?${params.toString()}`, { replace: true })
          onModeSelected?.(mode)
        } else {
          message.error(response.message || '创建房间失败')
        }
      }
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="w-full max-w-2xl">
        <div className="text-center mb-6">
          <Title level={3} className="m-0">
            创建房间
          </Title>
          <Paragraph type="secondary" className="m-0 mt-2">
            选择一种共享方案，邀请其他人加入
          </Paragraph>
        </div>

        <Space direction="vertical" className="w-full">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => setSelectedMode('screen-share')}
              className="relative text-left p-5 rounded-2xl border-2 transition-all"
              style={{
                borderColor:
                  selectedMode === 'screen-share'
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline-variant)',
                backgroundColor:
                  selectedMode === 'screen-share'
                    ? 'var(--md-sys-color-primary-container)'
                    : 'var(--md-sys-color-surface-container)',
              }}
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-primary)',
                  color: 'var(--md-sys-color-on-primary)',
                }}
              >
                <Monitor className="h-6 w-6" />
              </div>
              <Title level={5} className="m-0">
                远程共享
              </Title>
              <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                共享你的屏幕、摄像头或系统音频，观众实时观看
              </Paragraph>
            </button>

            <button
              onClick={() => setSelectedMode('watch-together')}
              className="relative text-left p-5 rounded-2xl border-2 transition-all"
              style={{
                borderColor:
                  selectedMode === 'watch-together'
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline-variant)',
                backgroundColor:
                  selectedMode === 'watch-together'
                    ? 'var(--md-sys-color-primary-container)'
                    : 'var(--md-sys-color-surface-container)',
              }}
            >
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
                style={{
                  backgroundColor: 'var(--md-sys-color-secondary)',
                  color: 'var(--md-sys-color-on-secondary)',
                }}
              >
                <Users className="h-6 w-6" />
              </div>
              <Title level={5} className="m-0">
                一起看
              </Title>
              <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                同步播放视频，支持直链、WebDAV、SMB 与 B站
              </Paragraph>
            </button>
          </div>

          <div
            className="my-2"
            style={{
              height: '1px',
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
            }}
          />

          <Space direction="vertical" className="w-full">
            <Switch
              label="需要确认加入"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
            />
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="房间密码（可选）"
            />
          </Space>

          <Button
            variant="primary"
            size="lg"
            icon={<ArrowRight className="h-5 w-5" />}
            block
            loading={creating}
            onClick={handleCreateRoom}
          >
            创建房间
          </Button>
        </Space>
      </Card>
    </div>
  )
}
