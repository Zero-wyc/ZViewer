import { Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { SingleLineInput } from './shared'
import { t } from '@/i18n'

interface BilibiliSourceFormProps {
  url: string
  onChangeUrl: (value: string) => void
  /** 回车/点「解析」：解析视频地址 */
  onResolve: () => void
  onOpenSearch: () => void
  disabled?: boolean
}

/** B站来源：地址输入 + 站内搜索入口 */
export function BilibiliSourceForm({
  url,
  onChangeUrl,
  onResolve,
  onOpenSearch,
  disabled,
}: BilibiliSourceFormProps) {
  return (
    <div className="flex gap-1.5">
      <SingleLineInput
        value={url}
        onChange={onChangeUrl}
        placeholder={t('视频 Url 或 bv 号')}
        onEnter={onResolve}
      />
      <Button
        variant="secondary"
        size="sm"
        title={t('搜索 B站 视频')}
        disabled={disabled}
        onClick={onOpenSearch}
      >
        <Search className="h-4 w-4" />
      </Button>
    </div>
  )
}
