import { useCallback, useEffect, useRef, useState } from 'react'
import { message } from '@/components/ui/message'
import {
  getBilibiliQrCode,
  logoutBilibili,
  pollBilibiliQrCode,
} from './bilibiliApi'
import { t } from '@/i18n'

export const BILI_QR_DEFAULT_MESSAGE = '请使用哔哩哔哩 App 扫码登录'

interface UseBilibiliQrLoginOptions {
  /** 登录成功后刷新本地用户态（拉取用户信息/登录标记等） */
  onLoginSuccess?: () => void | Promise<void>
  /** 退出登录成功后清理本地用户态 */
  onLogoutSuccess?: () => void
  /** 退出失败的提示文案 */
  logoutErrorMessage?: string
  /** 控制台轮询错误日志前缀 */
  logTag?: string
}

/**
 * B站 扫码登录弹窗全套逻辑：二维码获取、状态轮询（2s 间隔、失败重试 2 次）、
 * 过期重取、登出。抽取自 MoviePushPanel 与 ProfilePage 的两份逐行相同实现。
 */
export function useBilibiliQrLogin(options: UseBilibiliQrLoginOptions = {}) {
  const {
    onLoginSuccess,
    onLogoutSuccess,
    logoutErrorMessage = t('退出登录失败'),
    logTag = 'useBilibiliQrLogin',
  } = options

  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrStatus, setQrStatus] = useState(0)
  const [qrMessage, setQrMessage] = useState(BILI_QR_DEFAULT_MESSAGE)
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPollingRef = useRef(false)
  const qrRetryCountRef = useRef(0)

  const stopQrPolling = useCallback(() => {
    isPollingRef.current = false
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const startQrPolling = useCallback(
    (key: string) => {
      if (isPollingRef.current) return
      isPollingRef.current = true
      qrRetryCountRef.current = 0

      const poll = async () => {
        if (!isPollingRef.current) return
        try {
          const result = await pollBilibiliQrCode(key)
          qrRetryCountRef.current = 0
          setQrStatus(result.status)
          if (result.status === 0) {
            setQrMessage(BILI_QR_DEFAULT_MESSAGE)
          } else if (result.status === 1) {
            setQrMessage(t('已扫码，请在 App 中确认登录'))
          } else if (result.status === 2) {
            setQrMessage(t('登录成功'))
            await onLoginSuccess?.()
            setQrModalOpen(false)
            message.success(t('B站 登录成功'))
            stopQrPolling()
            return
          } else if (result.status === 3) {
            setQrMessage(t('二维码已过期，请重新获取'))
            stopQrPolling()
            return
          }
          pollTimerRef.current = setTimeout(poll, 2000)
        } catch (err) {
          console.error(`[${logTag}] QR poll error:`, err)
          qrRetryCountRef.current += 1
          if (qrRetryCountRef.current <= 2) {
            setQrMessage(t('轮询状态失败，正在重试…'))
            pollTimerRef.current = setTimeout(poll, 2000)
          } else {
            setQrMessage(t('轮询状态失败，请重新获取'))
            stopQrPolling()
          }
        }
      }

      void poll()
    },
    [onLoginSuccess, stopQrPolling, logTag]
  )

  const handleOpenQrModal = useCallback(async () => {
    stopQrPolling()
    setQrStatus(0)
    setQrMessage(BILI_QR_DEFAULT_MESSAGE)
    setQrDataUrl('')
    setQrModalOpen(true)
    try {
      const data = await getBilibiliQrCode()
      setQrDataUrl(data.qrDataUrl)
      void startQrPolling(data.qrcodeKey)
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('获取二维码失败'))
      setQrModalOpen(false)
    }
  }, [stopQrPolling, startQrPolling])

  const handleCloseQrModal = useCallback(() => {
    stopQrPolling()
    setQrModalOpen(false)
  }, [stopQrPolling])

  const handleLogoutBilibili = useCallback(async () => {
    try {
      await logoutBilibili()
      onLogoutSuccess?.()
      message.success(t('已退出 B站 登录'))
    } catch {
      message.error(logoutErrorMessage)
    }
  }, [onLogoutSuccess, logoutErrorMessage])

  // 卸载时停止轮询（原先仅 MoviePushPanel 有，现统一兜底）
  useEffect(() => stopQrPolling, [stopQrPolling])

  return {
    qrModalOpen,
    setQrModalOpen,
    qrDataUrl,
    qrStatus,
    qrMessage,
    handleOpenQrModal,
    handleCloseQrModal,
    handleLogoutBilibili,
  }
}
