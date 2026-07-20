import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Tag } from '@/components/ui/Tag'
import { Copy, PauseCircle, PlayCircle, Power } from 'lucide-react'

interface ShareControlsBarProps {
  /** 是否暂停中（决定显示暂停/恢复按钮） */
  isPaused: boolean
  /** socket 是否已连接 */
  connected: boolean
  /** 在线观众数量 */
  viewerCount: number
  /** PeerConnection 数量 */
  connectionCount: number
  /** 是否正在关闭房间（loading 状态） */
  closing: boolean
  /** 暂停/恢复共享 */
  onTogglePause: () => void
  /** 复制观看链接 */
  onCopyLink: () => void
  /** 清空批注 */
  onClearAnnotations: () => void
  /** 结束共享 */
  onClose: () => void
}

export function ShareControlsBar({
  isPaused,
  connected,
  viewerCount,
  connectionCount,
  closing,
  onTogglePause,
  onCopyLink,
  onClearAnnotations,
  onClose,
}: ShareControlsBarProps): JSX.Element {
  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-20 p-3"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
    >
      <Space className="w-full" wrap>
        {isPaused ? (
          <Button
            variant="primary"
            icon={<PlayCircle className="h-5 w-5" />}
            onClick={onTogglePause}
          >
            恢复共享
          </Button>
        ) : (
          <Button
            icon={<PauseCircle className="h-5 w-5" />}
            onClick={onTogglePause}
          >
            暂停共享
          </Button>
        )}
        <Button
          variant="secondary"
          icon={<Copy className="h-5 w-5" />}
          onClick={onCopyLink}
        >
          复制观看链接
        </Button>
        <Button variant="ghost" onClick={onClearAnnotations}>
          清空批注
        </Button>
        <Button
          variant="danger"
          icon={<Power className="h-5 w-5" />}
          loading={closing}
          onClick={onClose}
        >
          结束共享
        </Button>
      </Space>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Tag color={connected ? 'success' : 'default'}>
          {connected ? '已连接' : '未连接'}
        </Tag>
        <Tag color="primary">共享中</Tag>
        {isPaused && <Tag color="warning">已暂停</Tag>}
        {!isPaused && <Tag color="cyan">传输中</Tag>}
        <Tag color="purple">
          在线观众：{viewerCount} / {connectionCount} 连接
        </Tag>
      </div>
    </div>
  )
}
