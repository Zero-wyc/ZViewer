/**
 * 一起看「提交站点」入口。
 *
 * 任意房间成员（含游客）都可以把想看的影视站点提交给桌面端爬虫引擎；
 * 提交记录出现在桌面控制台「爬虫引擎 → 成员提交」，由房主用 Agent 生成规则。
 * 规则生成后站点搜索由后端完成，网页端只负责收集地址。
 */
import { useState } from 'react'
import { Globe } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { message } from '@/components/ui/message'
import { apiPost } from '@/lib/api'
import { useRoomStore } from '@/store/roomStore'
import { t } from '@/i18n'

interface SubmitResponse {
  success?: boolean
  message?: string
  error?: string
  duplicate?: boolean
}

export function CrawlerSubmitButton() {
  const roomId = useRoomStore((state) => state.roomId)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)

  const reset = () => {
    setUrl('')
    setName('')
    setKeyword('')
  }

  const handleClose = () => {
    if (busy) return
    setOpen(false)
    reset()
  }

  const handleSubmit = async () => {
    if (!roomId || busy) return
    if (!url.trim()) {
      message.error(t('请填写站点地址'))
      return
    }
    setBusy(true)
    try {
      const { data, ok } = await apiPost<SubmitResponse>(
        '/api/crawler/submit',
        {
          url: url.trim(),
          name: name.trim(),
          keyword: keyword.trim(),
          roomId,
        }
      )
      if (!ok || !data?.success) {
        message.error(data?.message || data?.error || t('提交失败'))
        return
      }
      if (data.duplicate) {
        message.info(t('这个站点已经提交过了，等待生成规则即可'))
      } else {
        message.success(t('已提交，房主会在桌面控制台生成站点规则'))
      }
      setOpen(false)
      reset()
    } catch (err) {
      console.error('[CrawlerSubmitButton] submit failed:', err)
      message.error(t('提交失败，请稍后再试'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        title={t('提交想看的影视站点')}
        aria-label={t('提交站点')}
      >
        <Globe className="h-3.5 w-3.5" />
      </button>
      <Modal
        open={open}
        onClose={handleClose}
        title={t('提交影视站点')}
        className="max-w-lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={handleClose} disabled={busy}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={busy} onClick={handleSubmit}>
              {t('提交')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]">
            {t(
              '提交后由房主在桌面控制台用 Agent 生成站点规则；规则生效后即可在房间内搜索这个站点。'
            )}
          </p>
          <Input
            label={t('站点地址')}
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={busy}
          />
          <Input
            label={t('站点名称（可选）')}
            placeholder={t('例如：某某影视')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
          <Input
            label={t('想看的影片（可选）')}
            placeholder={t('例如：流浪地球')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            disabled={busy}
          />
        </div>
      </Modal>
    </>
  )
}
