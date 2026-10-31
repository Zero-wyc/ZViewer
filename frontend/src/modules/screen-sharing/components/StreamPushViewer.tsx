/**
 * OBS 推流模式观众端查看器。
 *
 * 从 WatchPage.tsx 中拆分，仅处理 stream-push 子模式的观众端：
 * - FLV 拉流播放
 * - 推流状态显示（等待推流 / 主播未推流）
 *
 * 将 flvStats 状态隔离在组件内部，避免 flv.js 每秒统计回调
 * 触发父组件重渲染（导致掉帧和网页卡顿）。
 */
import { useEffect, useMemo, useState } from 'react'
import { type StreamStatus } from '@/store/roomStore'
import { CommentPanel } from '@/components/CommentPanel'
import { CinemaLayout } from '@/modules/room/components/CinemaLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { useSocket } from '@/hooks/useSocket'
import { useWatchPlayback } from '../streamPushApi'
import { FlvPlayer } from './FlvPlayer'
import { t } from '@/i18n'

interface StreamPushViewerProps {
  roomId: string
  streamKey: string
  streamStatus: StreamStatus
}

function StreamPushViewer({ roomId, streamStatus }: StreamPushViewerProps) {
  const { socket } = useSocket()
  const [isWebFullscreen, setIsWebFullscreen] = useState(false)
  const { url: flvUrl, error: watchError } = useWatchPlayback(roomId)

  // 网页全屏模式下按 ESC 退出
  useEffect(() => {
    if (!isWebFullscreen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsWebFullscreen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isWebFullscreen])

  const chatPanel = useMemo(
    () => <CommentPanel socket={socket} roomId={roomId} commentsOnly />,
    [socket, roomId]
  )
  const roomInfoPanel = useMemo(
    () => <RoomInfoPanel roomId={roomId} isHost={false} />,
    [roomId]
  )

  const playerContent = (
    <div className="relative h-full w-full">
      {!flvUrl ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
          <div className="text-base font-medium text-[var(--md-sys-color-error)]">
            {watchError || t('正在获取观看权限')}
          </div>
          <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
            {t('请等待房主切换为 OBS 推流模式后重试')}
          </div>
        </div>
      ) : streamStatus === 'offline' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/90 p-6 text-center">
          <div className="text-base font-medium text-[var(--md-sys-color-on-surface-variant)]">
            {t('主播未推流')}
          </div>
          <div className="text-sm text-[var(--md-sys-color-on-surface-variant)]">
            {t('请等待房主开始 OBS 推流')}
          </div>
        </div>
      ) : (
        <FlvPlayer
          src={flvUrl}
          muted
          autoPlay
          isWebFullscreen={isWebFullscreen}
          onToggleWebFullscreen={() => setIsWebFullscreen((prev) => !prev)}
        />
      )}
    </div>
  )

  return (
    <CinemaLayout
      children={playerContent}
      roomInfoPanel={roomInfoPanel}
      chatPanel={chatPanel}
      webFullscreen={isWebFullscreen}
    />
  )
}

export default StreamPushViewer
