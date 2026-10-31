/**
 * 平台 Cookie 绑定交互 hook（抽取自 ProfilePage 的网易云/B站平行实现）。
 *
 * 收敛两平台共有的交互骨架：Cookie 复制（读取 → 复制到剪贴板）、
 * Cookie 登录（输入校验 → 登录 → 提示 → 关弹窗清输入 → 刷新绑定状态）、
 * 弹窗开合与各自的 loading 态。平台差异（端点、响应解析、文案）通过
 * fetchCookie / loginWithCookie 回调与文案参数注入。
 */
import { useCallback, useState } from 'react'
import { message } from '@/components/ui/message'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { t } from '@/i18n'

interface UseCookieBindingParams {
  /** 读取当前 Cookie；无 Cookie 时返回 null/undefined */
  fetchCookie: () => Promise<string | null | undefined>
  /** 无 Cookie 时的提示文案（区分平台） */
  cookieUnavailableMessage: string
  /** 用 Cookie 登录；失败时抛 Error（message 为展示文案） */
  loginWithCookie: (cookie: string) => Promise<void>
  loginSuccessMessage: string
  /** 非 Error 抛出时的兜底文案 */
  loginFailedMessage: string
  /** 登录成功后刷新绑定状态 */
  refreshStatus: () => Promise<void>
}

export interface CookieBinding {
  /** Cookie 登录弹窗开合 */
  modalOpen: boolean
  openModal: () => void
  closeModal: () => void
  cookieInput: string
  setCookieInput: (value: string) => void
  /** Cookie 登录进行中 */
  loginLoading: boolean
  /** 复制 Cookie 进行中 */
  copyLoading: boolean
  copyCookie: () => Promise<void>
  /** 提交弹窗中的 Cookie 登录 */
  loginWithCookieInput: () => Promise<void>
}

export function useCookieBinding({
  fetchCookie,
  cookieUnavailableMessage,
  loginWithCookie,
  loginSuccessMessage,
  loginFailedMessage,
  refreshStatus,
}: UseCookieBindingParams): CookieBinding {
  const [modalOpen, setModalOpen] = useState(false)
  const [cookieInput, setCookieInput] = useState('')
  const [loginLoading, setLoginLoading] = useState(false)
  const [copyLoading, setCopyLoading] = useState(false)
  const copy = useCopyToClipboard()

  /** 复制当前绑定的平台 Cookie */
  const copyCookie = useCallback(async () => {
    setCopyLoading(true)
    try {
      const cookie = await fetchCookie()
      if (!cookie) {
        message.warning(cookieUnavailableMessage)
        return
      }
      await copy(cookie, {
        successMessage: t('Cookie 已复制到剪贴板'),
        errorMessage: t('复制 Cookie 失败'),
      })
    } catch {
      message.error(t('复制 Cookie 失败'))
    } finally {
      setCopyLoading(false)
    }
  }, [copy, fetchCookie, cookieUnavailableMessage])

  /** Cookie 登录（弹窗提交）：成功后关弹窗清输入并刷新绑定状态 */
  const loginWithCookieInput = useCallback(async () => {
    const trimmed = cookieInput.trim()
    if (!trimmed) {
      message.warning(t('请输入 Cookie'))
      return
    }
    setLoginLoading(true)
    try {
      await loginWithCookie(trimmed)
      message.success(loginSuccessMessage)
      setModalOpen(false)
      setCookieInput('')
      await refreshStatus()
    } catch (err) {
      message.error(err instanceof Error ? err.message : loginFailedMessage)
    } finally {
      setLoginLoading(false)
    }
  }, [
    cookieInput,
    loginWithCookie,
    loginSuccessMessage,
    loginFailedMessage,
    refreshStatus,
  ])

  const closeModal = useCallback(() => {
    setModalOpen(false)
    setCookieInput('')
  }, [])

  const openModal = useCallback(() => setModalOpen(true), [])

  return {
    modalOpen,
    openModal,
    closeModal,
    cookieInput,
    setCookieInput,
    loginLoading,
    copyLoading,
    copyCookie,
    loginWithCookieInput,
  }
}
