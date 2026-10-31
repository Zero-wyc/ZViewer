/**
 * 弹幕输入框（桌面控制行与移动端溢出菜单复用）。
 *
 * 内部管理输入文本状态，Enter（非 Shift）或点击发送按钮提交，
 * 提交后清空输入。父组件通过 onSend 接收纯文本。
 */
import { useState } from 'react'
import { Send } from 'lucide-react'
import { IconButton } from '@/components/VideoControls'
import { t } from '@/i18n'

export interface DanmakuInputProps {
  onSend?: (text: string) => void
  /** 占位文案：桌面端较长，移动端较短 */
  placeholder?: string
}

export function DanmakuInput({
  onSend,
  placeholder = t('发个友善的弹幕见证当下'),
}: DanmakuInputProps) {
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)

  const send = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend?.(trimmed)
    setText('')
  }

  return (
    <>
      <div className="relative flex-1">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          className="h-8 w-full rounded-lg border bg-transparent px-3 text-xs outline-none transition-all duration-200 placeholder:text-[var(--md-sys-color-on-surface-variant)]"
          style={{
            borderColor: focused
              ? 'var(--md-sys-color-primary)'
              : 'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
            backgroundColor: focused
              ? 'color-mix(in srgb, var(--md-sys-color-surface-container-high) 60%, transparent)'
              : 'color-mix(in srgb, var(--md-sys-color-surface-container-high) 30%, transparent)',
          }}
        />
      </div>
      <IconButton
        variant={text.trim() ? 'primary' : 'ghost'}
        size="sm"
        icon={<Send />}
        label={t('发送弹幕')}
        disabled={!text.trim()}
        onClick={send}
      />
    </>
  )
}
