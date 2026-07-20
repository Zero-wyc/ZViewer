import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import {
  Maximize,
  PictureInPicture,
  PictureInPicture2,
  Pencil,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'

interface WatchControlsBarProps {
  /** 是否静音 */
  isMuted: boolean
  /** 是否有远端音频 */
  hasRemoteAudio: boolean
  /** 是否有远端视频流 */
  hasRemoteStream: boolean
  /** 是否处于画中画 */
  isPictureInPicture: boolean
  /** 浏览器是否支持画中画 */
  isPiPSupported: boolean
  /** 是否显示批注工具栏 */
  showAnnotationToolbar: boolean
  /** socket 是否已连接 */
  connected: boolean
  /** WebRTC 连接状态 */
  connectionState:
    'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
  /** 视频分辨率（可选） */
  videoResolution: { width: number; height: number } | null
  /** 切换静音 */
  onToggleMute: () => void
  /** 全屏 */
  onFullscreen: () => void
  /** 切换画中画 */
  onTogglePiP: () => void
  /** 切换批注工具栏 */
  onToggleAnnotation: () => void
}

function getConnectionStateText(
  state: WatchControlsBarProps['connectionState']
): string {
  switch (state) {
    case 'connecting':
      return '连接中'
    case 'connected':
      return '已连接'
    case 'disconnected':
      return '已断开'
    case 'failed':
      return '连接失败'
    case 'closed':
      return '连接已关闭'
    default:
      return '等待连接'
  }
}

function getConnectionStateColor(
  state: WatchControlsBarProps['connectionState']
): 'default' | 'primary' | 'success' | 'danger' {
  switch (state) {
    case 'connected':
      return 'success'
    case 'connecting':
      return 'primary'
    case 'disconnected':
    case 'failed':
    case 'closed':
      return 'danger'
    default:
      return 'default'
  }
}

export function WatchControlsBar({
  isMuted,
  hasRemoteAudio,
  hasRemoteStream,
  isPictureInPicture,
  isPiPSupported,
  showAnnotationToolbar,
  connected,
  connectionState,
  videoResolution,
  onToggleMute,
  onFullscreen,
  onTogglePiP,
  onToggleAnnotation,
}: WatchControlsBarProps): JSX.Element {
  return (
    <div
      className="absolute bottom-0 left-0 right-0 z-20 p-3"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
    >
      <Space className="w-full" wrap>
        {hasRemoteAudio && (
          <Button
            icon={
              isMuted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )
            }
            onClick={onToggleMute}
          >
            {isMuted ? '取消静音' : '静音'}
          </Button>
        )}
        <Button icon={<Maximize className="h-4 w-4" />} onClick={onFullscreen}>
          全屏
        </Button>
        {isPiPSupported && (
          <Button
            icon={
              isPictureInPicture ? (
                <PictureInPicture2 className="h-4 w-4" />
              ) : (
                <PictureInPicture className="h-4 w-4" />
              )
            }
            onClick={onTogglePiP}
          >
            {isPictureInPicture ? '退出画中画' : '画中画'}
          </Button>
        )}
        <Button
          variant={showAnnotationToolbar ? 'primary' : 'secondary'}
          icon={
            showAnnotationToolbar ? (
              <X className="h-4 w-4" />
            ) : (
              <Pencil className="h-4 w-4" />
            )
          }
          onClick={onToggleAnnotation}
        >
          {showAnnotationToolbar ? '关闭批注' : '批注'}
        </Button>
      </Space>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Tag color={connected ? 'success' : 'default'}>
          {connected ? '已连接' : '未连接'}
        </Tag>
        <Tag color="primary">已加入</Tag>
        <Tag color={getConnectionStateColor(connectionState)}>
          {getConnectionStateText(connectionState)}
        </Tag>
        {hasRemoteStream && hasRemoteAudio && (
          <Tag color="cyan">{isMuted ? '静音中' : '音频开启'}</Tag>
        )}
      </div>
      {videoResolution && (
        <Paragraph className="m-0 mt-2">
          <Text type="secondary">
            分辨率：{videoResolution.width} x {videoResolution.height}
          </Text>
        </Paragraph>
      )}
    </div>
  )
}
