import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Tag } from '@/components/ui/Tag'
import { Copy, PauseCircle, PlayCircle, Power, RefreshCw } from 'lucide-react'
import { t } from '@/i18n'

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
  /** 刷新共享（重启采集并重建连接） */
  onRefresh: () => void
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
  onRefresh,
}: ShareControlsBarProps): JSX.Element {
  return (
    <div className="vc-container absolute bottom-0 left-0 right-0 z-20 p-2">
      <div className="glass-strong rounded-xl px-2.5 py-2 shadow-lg">
        <Space className="w-full" wrap>
          {isPaused ? (
            <Button
              variant="primary"
              icon={<PlayCircle className="h-5 w-5" />}
              onClick={onTogglePause}
            >
              {t('恢复共享')}
            </Button>
          ) : (
            <Button
              icon={<PauseCircle className="h-5 w-5" />}
              onClick={onTogglePause}
            >
              {t('暂停共享')}
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Copy className="h-5 w-5" />}
            onClick={onCopyLink}
          >
            {t('复制观看链接')}
          </Button>
          <Button variant="ghost" onClick={onClearAnnotations}>
            {t('清空批注')}
          </Button>
          <Button
            variant="secondary"
            icon={<RefreshCw className="h-5 w-5" />}
            onClick={onRefresh}
          >
            {t('刷新')}
          </Button>
          <Button
            variant="danger"
            icon={<Power className="h-5 w-5" />}
            loading={closing}
            onClick={onClose}
          >
            {t('结束共享')}
          </Button>
        </Space>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Tag color={connected ? 'success' : 'default'}>
            {connected ? t('已连接') : t('未连接')}
          </Tag>
          <Tag color="primary">{t('共享中')}</Tag>
          {isPaused && <Tag color="warning">{t('已暂停')}</Tag>}
          {!isPaused && <Tag color="cyan">{t('传输中')}</Tag>}
          <Tag color="purple">
            {t('在线观众：{{viewerCount}} / {{connectionCount}} 连接', {
              viewerCount,
              connectionCount,
            })}
          </Tag>
        </div>
      </div>
    </div>
  )
}
