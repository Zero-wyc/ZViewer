import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, Copy, Radio, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Card } from '@/components/ui/Card'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import {
  buildFlvUrl,
  downloadObsConfig,
  getRtmpPushUrl,
} from '../streamPushApi'
import { FlvPlayer } from './FlvPlayer'

interface StreamPushPageProps {
  roomId: string
  className?: string
  style?: React.CSSProperties
}

/**
 * 房主端 OBS 推流子模式页面。
 * - 显示推流地址与流密钥
 * - 提供一键下载 OBS 配置文件
 * - 拉流预览（房主自检推流是否成功）
 * - 显示推流状态（从 roomStore 读取，单一数据源）
 */
export function StreamPushPage({
  roomId,
  className,
  style,
}: StreamPushPageProps) {
  const streamStatus = useRoomStore((state) => state.streamStatus)
  const streamKey = useRoomStore((state) => state.streamKey)
  const setStreamStatus = useRoomStore((state) => state.setStreamStatus)
  const navigate = useNavigate()
  const [downloading, setDownloading] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)

  const rtmpUrl = getRtmpPushUrl()
  const effectiveStreamKey = streamKey ?? roomId
  const flvUrl = buildFlvUrl(effectiveStreamKey)

  const handleDownloadConfig = useCallback(async () => {
    setDownloading(true)
    try {
      await downloadObsConfig(roomId)
      message.success('OBS 配置文件已下载')
    } catch (err) {
      console.error(err)
      const msg = err instanceof Error ? err.message : '下载失败'
      message.error(msg)
    } finally {
      setDownloading(false)
    }
  }, [roomId])

  const handleCopyRtmp = useCallback(() => {
    const fullText = `${rtmpUrl}/${effectiveStreamKey}`
    navigator.clipboard
      .writeText(fullText)
      .then(() => message.success('推流地址已复制'))
  }, [rtmpUrl, effectiveStreamKey])

  const handleCopyStreamKey = useCallback(() => {
    navigator.clipboard
      .writeText(effectiveStreamKey)
      .then(() => message.success('流密钥已复制'))
  }, [effectiveStreamKey])

  return (
    <div
      className={`flex min-h-[480px] flex-col gap-4 overflow-y-auto p-6 ${className ?? ''}`}
      style={style}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
          <Text className="text-lg font-semibold">OBS 推流模式</Text>
        </div>
        <Tag color={streamStatus === 'live' ? 'success' : 'default'}>
          {streamStatus === 'live'
            ? '推流中'
            : streamStatus === 'offline'
              ? '未推流'
              : '等待状态'}
        </Tag>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <Paragraph type="secondary" className="m-0 text-xs">
            RTMP 推流地址
          </Paragraph>
          <div className="flex items-center gap-2">
            <Text className="flex-1 truncate rounded px-3 py-1.5 font-mono text-sm">
              {rtmpUrl}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="h-4 w-4" />}
              onClick={handleCopyRtmp}
            >
              复制地址
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Paragraph type="secondary" className="m-0 text-xs">
            流密钥（Stream Key）
          </Paragraph>
          <div className="flex items-center gap-2">
            <Text className="flex-1 truncate rounded px-3 py-1.5 font-mono text-sm">
              {effectiveStreamKey}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="h-4 w-4" />}
              onClick={handleCopyStreamKey}
            >
              复制密钥
            </Button>
          </div>
          {!streamKey && (
            <Paragraph type="danger" className="m-0 text-xs">
              未获取到独立推流密钥，当前显示的是房间号。请先点击「下载 OBS
              配置文件」重新导入，或刷新页面后再试。
            </Paragraph>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="primary"
            icon={<Download className="h-4 w-4" />}
            loading={downloading}
            onClick={handleDownloadConfig}
          >
            下载 OBS 配置文件
          </Button>
          <Button
            variant="ghost"
            icon={<ExternalLink className="h-4 w-4" />}
            onClick={() => setPreviewMode((prev) => !prev)}
          >
            {previewMode ? '隐藏预览' : '显示拉流预览'}
          </Button>
        </div>
      </Card>

      {previewMode && (
        <Card className="aspect-video w-full overflow-hidden p-0">
          <FlvPlayer
            src={flvUrl}
            muted
            autoPlay
            onStatusChange={(status) => {
              // 兜底：当拉流预览实际播放时，同步推流状态为 live
              if (status === 'playing') {
                setStreamStatus('live')
              } else if (status === 'error' || status === 'stopped') {
                setStreamStatus('offline')
              }
            }}
          />
        </Card>
      )}

      <Card className="flex flex-col gap-2 p-4 text-sm">
        <Text className="font-semibold">OBS 推流步骤</Text>
        <ol className="flex flex-col gap-1.5 pl-5 text-[var(--md-sys-color-on-surface-variant)]">
          <li>
            点击「下载 OBS 配置文件」获取{' '}
            <code className="font-mono">zcontrol-obs-config.json</code>
          </li>
          <li>
            打开 OBS → 顶部菜单「场景集合」→「导入」→ 选择下载的 JSON 文件
          </li>
          <li>
            切换到导入的「ZControl 推流」场景集合，确认推流服务地址与流密钥正确
          </li>
          <li>点击 OBS 右下角「开始推流」，本页面状态将变为「推流中」</li>
          <li>观众通过观看链接进入房间后会自动拉流播放</li>
        </ol>
        <Paragraph type="secondary" className="m-0 mt-2 text-xs">
          提示：结束推流请在 OBS 中点击「停止推流」。切换回 WebRTC
          共享前请先停止 OBS 推流。
        </Paragraph>
      </Card>

      <div className="flex justify-end">
        <Button
          variant="ghost"
          onClick={() => navigate('/', { replace: true })}
        >
          返回主页
        </Button>
      </div>
    </div>
  )
}
