import { Link2, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { SourceType } from './types'
import { t } from '@/i18n'

interface SourceActionButtonProps {
  sourceType: SourceType
  loading: boolean
  /** 非房主不可操作 */
  disabled: boolean
  /** 是否已解析出可添加的影片（仅 B站 分支影响按钮语义） */
  resolved: boolean
  onOpenAnimeSource: () => void
  onOpenKazumiSource: () => void
  onOpenCmsSource: () => void
  onAdd: () => void
  onResolve: () => void
}

/** 订阅源（ani-subs / Kazumi / TVBox）的主按钮文案 */
const SEARCH_ACTIONS: Partial<
  Record<SourceType, { label: string; target: 'anime' | 'kazumi' | 'cms' }>
> = {
  anime: { label: '搜索番剧', target: 'anime' },
  kazumi: { label: '搜索番剧', target: 'kazumi' },
  cms: { label: '搜索影片', target: 'cms' },
}

/**
 * 来源表单下的主操作按钮。
 * 订阅源 → 打开搜索面板；B站 → 未解析时「解析」、已解析时「添加」；
 * 其余单步来源 → 「添加」。
 */
export function SourceActionButton({
  sourceType,
  loading,
  disabled,
  resolved,
  onOpenAnimeSource,
  onOpenKazumiSource,
  onOpenCmsSource,
  onAdd,
  onResolve,
}: SourceActionButtonProps) {
  const search = SEARCH_ACTIONS[sourceType]
  if (search) {
    const onOpen = {
      anime: onOpenAnimeSource,
      kazumi: onOpenKazumiSource,
      cms: onOpenCmsSource,
    }[search.target]
    return (
      <Button
        variant="primary"
        size="md"
        block
        loading={loading}
        icon={<Search className="h-4 w-4" />}
        onClick={onOpen}
        disabled={disabled}
      >
        {search.label}
      </Button>
    )
  }

  if (sourceType === 'bilibili' && !resolved) {
    return (
      <Button
        variant="primary"
        size="md"
        block
        loading={loading}
        icon={<Link2 className="h-4 w-4" />}
        onClick={onResolve}
        disabled={disabled}
      >
        {t('解析')}
      </Button>
    )
  }

  return (
    <Button
      variant="primary"
      size="md"
      block
      loading={loading}
      icon={<Plus className="h-4 w-4" />}
      onClick={onAdd}
      disabled={disabled}
    >
      {t('添加')}
    </Button>
  )
}
