import { useCallback, useEffect, useState } from 'react'
import { Download, Radio, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Card } from '@/components/ui/Card'
import { message } from '@/components/ui/message'
import {
  useWatchPlayback,
  downloadObsConfig,
  getPublishConfiguration,
} from '../streamPushApi'
import { FlvPlayer } from './FlvPlayer'
import { t } from '@/i18n'

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
  const [publish, setPublish] = useState<{
    room: string
    server: string
    key: string
    error: string
  }>({ room: roomId, server: '', key: '', error: '' })
  const [downloading, setDownloading] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setPublish({ room: roomId, server: '', key: '', error: '' })
    void getPublishConfiguration(roomId, controller.signal)
      .then((config) => {
        if (!controller.signal.aborted)
          setPublish({ room: roomId, ...config, error: '' })
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setPublish({
            room: roomId,
            server: '',
            key: '',
            error:
              error instanceof Error ? error.message : t('获取发布配置失败'),
          })
      })
    return () => controller.abort()
  }, [roomId])
  const rtmpUrl = publish.room === roomId ? publish.server : ''
  const effectiveStreamKey = publish.room === roomId ? publish.key : ''
  const { url: flvUrl, error: watchError } = useWatchPlayback(
    roomId,
    previewMode
  )

  const handleDownloadConfig = useCallback(async () => {
    setDownloading(true)
    try {
      await downloadObsConfig(roomId)
      message.success(t('OBS 配置文件已下载'))
    } catch (err) {
      console.error(err)
      const msg = err instanceof Error ? err.message : t('下载失败')
      message.error(msg)
    } finally {
      setDownloading(false)
    }
  }, [roomId])

  return (
    <div
      className={`h-full min-h-0 overflow-y-auto p-6 space-y-4 ${className ?? ''}`}
      style={style}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
          <Text className="!text-white text-lg font-semibold">
            {t('OBS 推流模式')}
          </Text>
        </div>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <Paragraph type="secondary" className="m-0 text-xs">
            {t('RTMP 推流地址')}
          </Paragraph>
          <div className="flex items-center gap-2">
            <Text className="flex-1 truncate rounded px-3 py-1.5 font-mono text-sm">
              {rtmpUrl}
            </Text>
            <CopyButton
              value={rtmpUrl}
              label={t('复制地址')}
              successMessage={t('推流地址已复制（不含流密钥）')}
              size="sm"
              variant="ghost"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Paragraph type="secondary" className="m-0 text-xs">
            {t('流密钥（Stream Key）')}
          </Paragraph>
          <div className="flex items-center gap-2">
            <Text className="flex-1 truncate rounded px-3 py-1.5 font-mono text-sm">
              {effectiveStreamKey}
            </Text>
            <CopyButton
              value={effectiveStreamKey}
              label={t('复制密钥')}
              successMessage={t('流密钥已复制')}
              size="sm"
              variant="ghost"
            />
          </div>
          {!effectiveStreamKey && (
            <Paragraph type="danger" className="m-0 text-xs">
              {publish.error || t('正在获取发布配置，请稍候')}
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
            {t('下载 OBS 配置文件')}
          </Button>
          <Button
            variant="ghost"
            icon={<ExternalLink className="h-4 w-4" />}
            onClick={() => setPreviewMode((prev) => !prev)}
          >
            {previewMode ? t('隐藏预览') : t('显示拉流预览')}
          </Button>
        </div>
      </Card>

      {previewMode && (
        <Card className="aspect-video w-full min-h-[480px] overflow-hidden p-0">
          {flvUrl ? (
            <FlvPlayer src={flvUrl} muted autoPlay />
          ) : (
            <Paragraph>{watchError || t('正在获取观看权限')}</Paragraph>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-2 p-4 text-sm">
        <Text className="font-semibold">{t('OBS 推流步骤')}</Text>
        <ol className="flex flex-col gap-1.5 pl-5 text-[var(--md-sys-color-on-surface-variant)]">
          <li>
            {t('点击「下载 OBS 配置文件」获取')}{' '}
            <code className="font-mono">zviewer-obs-config.json</code>
          </li>
          <li>
            {t(
              '打开 OBS → 顶部菜单「场景集合」→「导入」→ 选择下载的 JSON 文件'
            )}
          </li>
          <li>
            {t(
              '切换到导入的「ZViewer 推流」场景集合，确认推流服务地址与流密钥正确'
            )}
          </li>
          <li>{t('点击 OBS 右下角「开始推流」')}</li>
          <li>{t('观众通过观看链接进入房间后会自动拉流播放')}</li>
        </ol>
        <Paragraph type="secondary" className="m-0 mt-2 text-xs">
          {t(
            '提示：结束推流请在 OBS 中点击「停止推流」。切换回 WebRTC 共享前请先停止 OBS 推流。'
          )}
        </Paragraph>
      </Card>
    </div>
  )
}
