import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button, type ButtonProps } from './Button'
import {
  useCopyToClipboard,
  type CopyOptions,
} from '@/hooks/useCopyToClipboard'

export interface CopyButtonProps extends Omit<
  ButtonProps,
  'onClick' | 'icon' | 'loading'
> {
  /** 要复制的文本 */
  value: string
  /** 按钮文案（可选，纯图标按钮时不传） */
  label?: React.ReactNode
  /** 成功提示文案；传 false 静默 */
  successMessage?: string | false
  /** 失败提示文案 */
  errorMessage?: string
  /** 复制成功后的回调（始终触发，无论是否提示） */
  onCopied?: () => void
  /** 成功后图标切换为对勾的时长（ms），0 表示不切换 */
  feedbackDuration?: number
}

/**
 * 统一复制按钮：内置剪贴板回退、成功提示与对勾反馈。
 * 替代各页面手写的 Copy 图标按钮 + 复制逻辑。
 */
export function CopyButton({
  value,
  label,
  successMessage,
  errorMessage,
  onCopied,
  feedbackDuration = 2000,
  size = 'sm',
  variant = 'ghost',
  ...props
}: CopyButtonProps) {
  const copy = useCopyToClipboard()
  const [copied, setCopied] = useState(false)

  const options: CopyOptions = {
    successMessage,
    errorMessage,
  }

  const handleClick = async () => {
    const ok = await copy(value, options)
    if (ok) {
      onCopied?.()
      if (feedbackDuration > 0) {
        setCopied(true)
        setTimeout(() => setCopied(false), feedbackDuration)
      }
    }
  }

  return (
    <Button
      size={size}
      variant={variant}
      icon={
        copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />
      }
      onClick={handleClick}
      {...props}
    >
      {label}
    </Button>
  )
}
