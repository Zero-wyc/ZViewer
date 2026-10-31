import { useCallback, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CloudModal, type CloudModalHandle } from '../../components/CloudModal'
import { t } from '@/i18n'

/** 添加栏目弹窗（黑底 SETTING 风格）：粘贴 B站 链接解析视频合集/系列/收藏夹，
 *  名称留空自动使用 B站 侧标题；提交经后端 link-meta 校验
 *  （链接无法识别 / 收藏夹私密等错误原样提示） */
export function AddCustomTabModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void
  /** 提交解析；返回错误消息（成功返回空串） */
  onSubmit: (link: string, name: string) => Promise<string>
}) {
  const [link, setLink] = useState('')
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 遮罩 + 面板 + 进出动画（两段式展开/反向收起、渐进压暗、Esc、内容
  // 延后挂载闸门）统一由 CloudModal 承载；提交中禁关走 canClose 守卫，
  // 提交成功经 ref 触发带动画关闭
  const modalRef = useRef<CloudModalHandle>(null)

  const submit = useCallback(async () => {
    if (submitting) return
    if (!link.trim()) {
      setError(t('请粘贴 B站 链接'))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const err = await onSubmit(link.trim(), name)
      if (err) {
        setError(err)
        setSubmitting(false)
        return
      }
      modalRef.current?.requestClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('解析链接失败'))
      setSubmitting(false)
    }
  }, [submitting, link, name, onSubmit])

  return (
    <CloudModal
      ref={modalRef}
      canClose={!submitting}
      width="min(380px, calc(100vw - 32px))"
      height="min(360px, calc(100vh - 120px))"
      onClose={onClose}
    >
      {(unfoldDone) => (
        <>
          {/* 标题行：超大 ADD 水印 */}
          <div
            className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
            style={{ animation: 'cloud-add-title-in 0.2s 0.3s both' }}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
            >
              ADD
            </span>
            <p className="relative text-center text-[17px] font-bold text-white">
              {t('添加栏目')}
            </p>
          </div>
          {unfoldDone && (
            <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {/* 说明 */}
              <p className="mb-3 text-[13px] font-medium leading-relaxed text-white/50">
                粘贴 B站 链接添加顶栏栏目：视频合集 / 系列 （
                {'space.bilibili.com/{mid}/lists/{sid}'} 或旧版 channel
                链接）、收藏夹（{'…/favlist?fid=…'}）；b23.tv 短链自动展开。
              </p>
              {/* 链接输入 */}
              <div className="mb-2">
                <input
                  autoFocus
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                  placeholder={t('粘贴 B站 链接')}
                  className="h-8 w-full rounded-full px-3 text-sm font-bold outline-none"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: '#ffffff',
                    border: '0.5px solid rgba(255, 255, 255, 0.25)',
                  }}
                />
              </div>
              {/* 名称输入（留空用 B站 侧标题） */}
              <div className="mb-3">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                  placeholder={t('栏目名称（留空自动使用 B站 标题）')}
                  className="h-8 w-full rounded-full px-3 text-sm font-bold outline-none"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: '#ffffff',
                    border: '0.5px solid rgba(255, 255, 255, 0.25)',
                  }}
                />
              </div>
              {error && (
                <p
                  className="mb-2 text-[13px] font-bold leading-relaxed"
                  style={{ color: '#ff8a8a' }}
                >
                  {error}
                </p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => modalRef.current?.requestClose()}
                  className="rounded-full px-3 py-1.5 text-sm font-bold text-white/70 transition-colors hover:text-white"
                >
                  {t('取消')}
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={submitting}
                  className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-bold transition-opacity hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ backgroundColor: '#ffffff', color: '#000000' }}
                >
                  {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
                  {submitting ? t('解析中…') : t('添加')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </CloudModal>
  )
}
