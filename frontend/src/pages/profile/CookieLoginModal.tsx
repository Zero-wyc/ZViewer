/**
 * 平台 Cookie 登录弹窗（网易云/B站 共用骨架，仅标题/说明/占位文案不同）。
 * 抽取自 ProfilePage 的两个平行 Modal 实现。
 */
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { Paragraph } from '@/components/ui/Typography'
import { t } from '@/i18n'

interface CookieLoginModalProps {
  open: boolean
  onClose: () => void
  title: string
  /** 操作说明（按行渲染） */
  instructions: string[]
  placeholder: string
  input: string
  onInputChange: (value: string) => void
  loading: boolean
  onSubmit: () => void
}

export function CookieLoginModal({
  open,
  onClose,
  title,
  instructions,
  placeholder,
  input,
  onInputChange,
  loading,
  onSubmit,
}: CookieLoginModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={loading}
          >
            {t('取消')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSubmit}
            disabled={loading || !input.trim()}
          >
            {loading ? t('验证中...') : t('登录')}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Paragraph type="secondary" className="m-0 text-xs leading-relaxed">
          {instructions.map((line, index) => (
            <span key={index}>
              {line}
              {index < instructions.length - 1 && <br />}
            </span>
          ))}
        </Paragraph>
        <textarea
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          placeholder={placeholder}
          rows={5}
          className="w-full resize-none rounded-[var(--md-sys-shape-corner)] border bg-[var(--md-sys-color-surface-container)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
          style={{
            borderColor: 'var(--md-sys-color-outline-variant)',
          }}
          disabled={loading}
        />
      </div>
    </Modal>
  )
}
