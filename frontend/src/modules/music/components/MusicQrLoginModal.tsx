/**
 * 网易云扫码登录弹窗（逻辑迁移自 MusicSearchPanel 的二维码弹窗）。
 *
 * 由 MusicAppShell 挂载（store.loginModalOpen 控制），顶部出现、无全屏遮罩、
 * 圆角玻璃卡；useNcmLogin 驱动扫码状态机（800 失效自动重建 / 803 成功关闭）。
 */
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { LoadingLine } from '@/components/ui/LoadingLine'
import { useNcmLogin } from '../hooks/useNcmLogin'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export interface MusicQrLoginModalProps {
  /** 关闭弹窗（登录成功 / 用户点关闭时回调） */
  onClose: () => void
}

/** 扫码状态文案 */
const QR_STATUS_TEXT: Record<string, string> = {
  generating: '正在生成二维码…',
  waiting: '请使用网易云音乐 App 扫码登录',
  scanned: '已扫描，请在手机上确认登录',
  success: '登录成功',
  error: '二维码生成失败，请重试',
}

export function MusicQrLoginModal({ onClose }: MusicQrLoginModalProps) {
  const {
    qrImg,
    status,
    errorMessage,
    startLogin,
    stopPolling,
    logout,
    loginStatus,
  } = useNcmLogin()

  // 挂载即启动扫码登录
  useEffect(() => {
    void startLogin()
  }, [startLogin])

  // 登录成功：提示并关闭弹窗
  useEffect(() => {
    if (status === 'success') {
      message.success(t('网易云登录成功'))
      onClose()
    }
  }, [status, onClose])

  const handleClose = () => {
    stopPolling()
    onClose()
  }

  return createPortal(
    <>
      {/* 透明捕获层：点击外部关闭（不遮挡视觉） */}
      <div
        className="fixed inset-0 z-[998]"
        onClick={handleClose}
        aria-hidden="true"
      />
      <div className="fixed left-1/2 top-16 z-[999] -translate-x-1/2">
        <div
          className={cn(
            'glass-strong flex w-72 flex-col items-center gap-4',
            'rounded-[var(--md-sys-shape-corner)] p-6 shadow-lg',
            'zen-modal-content-enter'
          )}
          style={{
            boxShadow:
              '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
          }}
        >
          <Text className="text-sm font-semibold">
            {t('扫码登录网易云音乐')}
          </Text>
          {qrImg ? (
            <img
              src={qrImg}
              alt={t('网易云登录二维码')}
              className="rounded-lg border"
              style={{
                width: 200,
                height: 200,
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            />
          ) : (
            <div
              className="glass flex items-center justify-center rounded-lg"
              style={{ width: 200, height: 200 }}
            >
              {status === 'generating' ? (
                <LoadingLine
                  text={t('正在生成二维码…')}
                  spinnerClassName="h-6 w-6 text-[var(--md-sys-color-primary)]"
                  className="h-auto"
                />
              ) : status === 'error' ? (
                <span className="p-4 text-center text-sm">
                  {t('二维码暂不可用')}
                </span>
              ) : (
                <Spinner size={28} tip={t('正在生成二维码')} />
              )}
            </div>
          )}
          <Paragraph
            type={
              status === 'error'
                ? 'danger'
                : status === 'success'
                  ? 'success'
                  : 'secondary'
            }
            className="m-0 text-center text-xs"
          >
            {errorMessage ??
              QR_STATUS_TEXT[status] ??
              t('请使用网易云音乐 App 扫码登录')}
            {status === 'waiting' && t('（二维码过期将自动刷新）')}
          </Paragraph>
          {status === 'error' && (
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => void startLogin()}
            >
              {t('重新获取二维码')}
            </Button>
          )}
          {/* 已登录账号：提供退出入口（与 Hydrogen app-option 账号登录/退出一致） */}
          {loginStatus.loggedIn && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => void logout()}
            >
              {t('退出当前账号（')}
              {loginStatus.nickname ?? t('已登录')}）
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            className="w-full"
            onClick={handleClose}
          >
            {t('关闭')}
          </Button>
        </div>
      </div>
    </>,
    document.body
  )
}
