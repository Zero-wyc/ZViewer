/**
 * B站 视频搜索弹窗（添加影片辅助）。
 *
 * 入口：添加影片面板 B站 来源 URL 输入框旁的「搜索」按钮。
 * 复用音乐模块 B站 页同款后端搜索（/api/stream/bilibili/search，
 * 关键词搜索 + 结果缓存），选中后把 BV 链接回填到添加面板并自动解析。
 *
 * - 标题清洗：B站 搜索接口的 title 含 <em class="keyword"> 高亮标记，展示前剥离
 * - 封面经 buildBilibiliImageProxyUrl 代理（hdslb.com 防盗链）
 * - 分页：加载更多（pn 递增追加；total 为 null 时以本页非空继续提供）
 */
import { useCallback, useRef, useState } from 'react'
import { Loader2, Search, SearchX } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import {
  searchBilibiliVideos,
  type BilibiliVideoItem,
} from '@/modules/bilibili/bilibiliApi'
import { buildBilibiliImageProxyUrl } from '@/modules/room/watch-together/resolveSource'

interface BiliSearchModalProps {
  open: boolean
  onClose: () => void
  /** 选中某条结果（参数为该视频的 B站 链接，回填到添加面板） */
  onSelect: (url: string) => void
}

/** 剥离 B站 搜索标题里的 <em class="keyword"> 高亮标记 */
function stripEm(title: string): string {
  return title.replace(/<\/?em[^>]*>/g, '')
}

/** 秒 → mm:ss / h:mm:ss */
function formatDuration(sec: number): string {
  const s = Math.max(Math.round(sec), 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

/** 播放/弹幕数万位缩写 */
function formatCount(n?: number): string {
  if (n == null) return ''
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`
  return String(n)
}

export function BiliSearchModal({
  open,
  onClose,
  onSelect,
}: BiliSearchModalProps) {
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<BilibiliVideoItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searched, setSearched] = useState(false)
  /** 防止快速切页时旧响应覆盖新结果 */
  const requestSeqRef = useRef(0)

  const doSearch = useCallback(
    async (kw: string, targetPage: number, append: boolean) => {
      const trimmed = kw.trim()
      if (!trimmed) {
        message.warning('请输入搜索关键词')
        return
      }
      const seq = ++requestSeqRef.current
      if (append) {
        setLoadingMore(true)
      } else {
        setLoading(true)
      }
      try {
        const { items: newItems, total: newTotal } = await searchBilibiliVideos(
          trimmed,
          targetPage
        )
        if (seq !== requestSeqRef.current) return
        setItems((prev) => (append ? [...prev, ...newItems] : newItems))
        setTotal(newTotal)
        setPage(targetPage)
        setSearched(true)
      } catch (err) {
        if (seq !== requestSeqRef.current) return
        message.error(err instanceof Error ? err.message : '搜索失败')
      } finally {
        if (seq === requestSeqRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    []
  )

  // 不在打开时重置状态：重新打开保留上次搜索结果（误关可找回），
  // 关键词保留可直接微调重搜；首次打开为干净的空态。

  const hasMore =
    searched && items.length > 0 && (total == null || items.length < total)

  return (
    <Modal open={open} onClose={onClose} title="搜索 B站 视频">
      <div className="flex min-h-0 flex-col gap-2.5">
        {/* 搜索行：回车触发 */}
        <div className="flex gap-1.5">
          <Input
            size="sm"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void doSearch(keyword, 1, false)
              }
            }}
            placeholder="输入关键词搜索 B站 视频"
            autoFocus
          />
          <Button
            variant="primary"
            size="sm"
            loading={loading}
            icon={<Search className="h-4 w-4" />}
            onClick={() => void doSearch(keyword, 1, false)}
          >
            搜索
          </Button>
        </div>

        {/* 结果列表 */}
        <div className="zen-scroll flex max-h-[52vh] min-h-[180px] flex-col gap-1.5 overflow-y-auto pr-0.5">
          {items.map((v) => (
            <button
              key={v.bvid}
              type="button"
              onClick={() => {
                onSelect(`https://www.bilibili.com/video/${v.bvid}`)
                onClose()
              }}
              className="group flex w-full items-center gap-2.5 rounded-[var(--md-sys-shape-corner)] border border-transparent p-1.5 text-left transition-all hover:border-[var(--md-sys-color-outline-variant)] hover:bg-[var(--md-sys-color-surface-container-high)]"
            >
              <img
                src={buildBilibiliImageProxyUrl(v.pic)}
                alt=""
                loading="lazy"
                className="relative h-[54px] w-24 shrink-0 rounded-md object-cover"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.visibility = 'hidden'
                }}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Text className="line-clamp-2 break-all text-xs font-medium leading-snug">
                  {stripEm(v.title)}
                </Text>
                <Text
                  type="secondary"
                  className="truncate text-[10px] leading-tight"
                >
                  {v.upName}
                  {v.view != null ? ` · ${formatCount(v.view)}播放` : ''}
                  {v.danmaku != null ? ` · ${formatCount(v.danmaku)}弹幕` : ''}
                  {` · ${formatDuration(v.duration)}`}
                </Text>
              </div>
            </button>
          ))}

          {loading && items.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-10">
              <Loader2 className="h-6 w-6 animate-spin text-[var(--md-sys-color-primary)]" />
              <Text type="secondary" className="text-xs">
                正在搜索…
              </Text>
            </div>
          )}

          {searched && !loading && items.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-10">
              <SearchX className="h-8 w-8 opacity-40" />
              <Text type="secondary" className="text-xs">
                没有找到相关视频
              </Text>
            </div>
          )}

          {hasMore && (
            <Button
              variant="secondary"
              size="sm"
              block
              loading={loadingMore}
              onClick={() => void doSearch(keyword, page + 1, true)}
            >
              加载更多
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
