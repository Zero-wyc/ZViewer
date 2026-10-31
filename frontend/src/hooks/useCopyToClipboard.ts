import { useCallback, useEffect, useRef } from 'react'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'

export interface CopyOptions {
  /** 成功提示文案；传 false 静默不提示 */
  successMessage?: string | false
  /** 失败提示文案 */
  errorMessage?: string
}

/**
 * 将文本写入剪贴板。优先 navigator.clipboard，
 * 非 HTTPS 环境自动回退 document.execCommand('copy')。
 * 返回是否成功。
 */
export async function writeTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
    throw new Error('clipboard API unavailable')
  } catch {
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 统一剪贴板复制 hook：收敛散落各处的复制逻辑
 * （此前 10+ 处各自实现，错误处理不一致，部分静默失败）。
 *
 * @example
 * const copy = useCopyToClipboard()
 * await copy(roomId, { successMessage: '房间号已复制' })
 */
export function useCopyToClipboard(defaultOptions?: CopyOptions) {
  const defaultOptionsRef = useRef<CopyOptions | undefined>(defaultOptions)
  useEffect(() => {
    defaultOptionsRef.current = defaultOptions
  }, [defaultOptions])

  return useCallback(async (text: string, options?: CopyOptions) => {
    const ok = await writeTextToClipboard(text)
    const merged = { ...defaultOptionsRef.current, ...options }
    const successMessage =
      merged.successMessage !== undefined
        ? merged.successMessage
        : t('已复制到剪贴板')
    if (ok) {
      if (successMessage !== false) {
        message.success(successMessage)
      }
    } else {
      message.error(merged.errorMessage ?? t('复制失败，请手动复制'))
    }
    return ok
  }, [])
}
