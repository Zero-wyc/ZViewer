/**
 * B站 视频搜索弹窗（添加影片辅助）。
 *
 * 入口：添加影片面板 B站 来源 URL 输入框旁的「搜索」按钮。
 * 复用音乐模块 B站 页同款后端搜索（/api/stream/bilibili/search，
 * 关键词搜索 + 结果缓存），选中后把 BV 链接回填到添加面板并自动解析。
 *
 * UI 对标 Kazumi / ani-subs 番剧源面板（FullscreenOverlay 大面板），
 * 结果区采用瀑布流布局（CSS multi-column，卡片按列填充、高度不齐自然错落）。
 *
 * - 标题清洗：B站 搜索接口的 title 含 <em class="keyword"> 高亮标记，展示前剥离
 * - 封面经 buildBilibiliImageProxyUrl 代理（hdslb.com 防盗链）
 * - 分页：加载更多（pn 递增追加；total 为 null 时以本页非空继续提供）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2, Search, SearchX, Tv } from 'lucide-react'
import { FullscreenOverlay } from '@/components/ui/FullscreenOverlay'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Text, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import {
  searchBilibiliVideos,
  getBilibiliVideoView,
  type BilibiliVideoItem,
  type BilibiliVideoViewInfo,
} from '@/modules/bilibili/bilibiliApi'
import { buildBilibiliImageProxyUrl } from '@/modules/movie-source/resolveSource'
import { formatDuration } from '@/lib/utils'
import { formatCountShort } from '@/lib/format'

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

  // 分 P 选择页：点击卡片后经 view 接口取分 P 列表；
  // 单 P 直接回填链接（保持旧行为），多 P 进入面板内二级选择页
  const [detailItem, setDetailItem] = useState<BilibiliVideoItem | null>(null)
  const [detailTitle, setDetailTitle] = useState('')
  const [detailPages, setDetailPages] = useState<
    BilibiliVideoViewInfo['pages']
  >([])
  const [detailLoading, setDetailLoading] = useState(false)

  // 关闭时退出分 P 页，重新打开回到结果列表
  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 关闭时清理二级页
      setDetailItem(null)
    }
  }, [open])

  const handleCardClick = useCallback(
    async (v: BilibiliVideoItem) => {
      setDetailItem(v)
      setDetailTitle(stripEm(v.title))
      setDetailPages([])
      setDetailLoading(true)
      try {
        const info = await getBilibiliVideoView(v.bvid)
        if (info.pages.length > 1) {
          setDetailTitle(stripEm(info.title) || stripEm(v.title))
          setDetailPages(info.pages)
        } else {
          // 单 P：直接选中（无 ?p 参数，与旧行为一致）
          onSelect(`https://www.bilibili.com/video/${v.bvid}`)
          onClose()
          setDetailItem(null)
        }
      } catch (err) {
        // view 拉取失败时回退为直接选中根链接，不阻断添加流程
        console.error('[BiliSearchModal] load video pages error:', err)
        message.warning(
          err instanceof Error
            ? `${err.message}，已按单 P 添加`
            : '获取分 P 失败，已按单 P 添加'
        )
        onSelect(`https://www.bilibili.com/video/${v.bvid}`)
        onClose()
        setDetailItem(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [onSelect, onClose]
  )

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
    <FullscreenOverlay
      open={open}
      onClose={onClose}
      className="max-w-4xl h-[624px]"
      title="搜索 B站 视频"
    >
      <div className="flex h-full flex-col">
        {/* 搜索区：回车触发 */}
        <div className="mb-4 flex gap-3">
          <Input
            size="md"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void doSearch(keyword, 1, false)
              }
            }}
            placeholder="输入关键词搜索 B站 视频"
            className="flex-1"
          />
          <Button
            variant="primary"
            size="md"
            icon={<Search className="h-4 w-4" />}
            loading={loading}
            onClick={() => void doSearch(keyword, 1, false)}
            className="h-[42px] shrink-0"
          >
            搜索
          </Button>
        </div>

        {detailItem ? (
          /* 分 P 选择页：返回 + 标题 + 分 P 列表 */
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="mb-3 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowLeft className="h-4 w-4" />}
                onClick={() => setDetailItem(null)}
              >
                返回
              </Button>
              <Text
                className="truncate text-sm font-semibold"
                title={detailTitle}
              >
                {detailTitle}
              </Text>
            </div>
            <div className="zen-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
              {detailLoading ? (
                <div className="flex h-32 items-center justify-center">
                  <Loader2
                    className="h-5 w-5 animate-spin"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                </div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-2">
                  {detailPages.map((p) => (
                    <button
                      key={p.page}
                      type="button"
                      onClick={() => {
                        onSelect(
                          `https://www.bilibili.com/video/${detailItem.bvid}?p=${p.page}`
                        )
                        onClose()
                      }}
                      className="flex min-w-0 items-center gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline-variant)] px-3 py-2.5 text-left transition-all hover:-translate-y-0.5 hover:border-[var(--md-sys-color-primary)] hover:shadow-sm"
                    >
                      <span
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold leading-none"
                        style={{
                          backgroundColor:
                            'var(--md-sys-color-primary-container)',
                          color: 'var(--md-sys-color-on-primary-container)',
                        }}
                      >
                        P{p.page}
                      </span>
                      <Text
                        className="min-w-0 flex-1 truncate text-xs"
                        title={p.part}
                      >
                        {p.part || `P${p.page}`}
                      </Text>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            {/* 工具栏：结果数提示 */}
            <div className="mb-3 flex items-center justify-between">
              <Text type="secondary" className="text-xs">
                {items.length > 0
                  ? `共 ${total ?? items.length} 条结果`
                  : loading
                    ? '搜索中...'
                    : '输入关键词开始搜索'}
              </Text>
            </div>

            {/* 结果区：瀑布流（外层滚动，内层 multi-column 平衡分列，
            列内卡片 break-inside-avoid 不跨列截断） */}
            <div className="zen-scroll min-h-0 flex-1 overflow-y-auto pr-0.5">
              {/* column-width 180px 自适应列数：弹窗默认宽度（max-w-4xl，
              内容区约 848px）下正好排 4 列视频卡片；网页全屏/高分辨率下
              仍自动显示更多列（卡片更小），而不是固定列数把卡片拉大 */}
              <div className="[columns:auto_180px] gap-3">
                {items.map((v) => (
                  <button
                    key={v.bvid}
                    type="button"
                    onClick={() => void handleCardClick(v)}
                    className="group mb-3 block w-full break-inside-avoid overflow-hidden rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline-variant)] text-left transition-all hover:-translate-y-0.5 hover:border-[var(--md-sys-color-primary)] hover:shadow-sm"
                  >
                    {/* 封面：16:9 + 时长角标 */}
                    <div className="relative aspect-video w-full overflow-hidden bg-[var(--glass-bg)]">
                      <img
                        src={buildBilibiliImageProxyUrl(v.pic)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                        onError={(e) => {
                          ;(e.target as HTMLImageElement).style.visibility =
                            'hidden'
                        }}
                      />
                      <span
                        className="absolute bottom-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                        style={{
                          backgroundColor: 'rgba(0, 0, 0, 0.65)',
                          textShadow: '0 1px 2px rgba(0, 0, 0, 0.8)',
                        }}
                      >
                        {formatDuration(v.duration)}
                      </span>
                    </div>
                    {/* 标题 + 元信息 */}
                    <div className="flex flex-col gap-1 p-2.5">
                      <Text
                        className="line-clamp-2 break-all text-xs font-medium leading-snug"
                        title={stripEm(v.title)}
                      >
                        {stripEm(v.title)}
                      </Text>
                      <Text
                        type="secondary"
                        className="truncate text-[10px] leading-tight"
                        title={v.upName}
                      >
                        {v.upName}
                      </Text>
                      <div
                        className="flex items-center gap-2 text-[10px] leading-tight"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      >
                        {v.view != null && (
                          <span>{formatCountShort(v.view)}播放</span>
                        )}
                        {v.danmaku != null && (
                          <span>{formatCountShort(v.danmaku)}弹幕</span>
                        )}
                      </div>
                    </div>
                  </button>
                ))}

                {/* 加载中 / 空态：横跨所有列 */}
                {loading && items.length === 0 && (
                  <div className="flex [column-span:all] flex-col items-center justify-center gap-3 py-16">
                    <div
                      className="flex h-14 w-14 items-center justify-center rounded-full"
                      style={{ backgroundColor: 'var(--glass-bg)' }}
                    >
                      <Loader2
                        className="h-6 w-6 animate-spin"
                        style={{ color: 'var(--md-sys-color-primary)' }}
                      />
                    </div>
                    <Paragraph type="secondary" className="m-0 text-xs">
                      正在搜索…
                    </Paragraph>
                  </div>
                )}

                {searched && !loading && items.length === 0 && (
                  <div className="flex [column-span:all] flex-col items-center justify-center gap-3 py-16">
                    <div
                      className="flex h-14 w-14 items-center justify-center rounded-full"
                      style={{ backgroundColor: 'var(--glass-bg)' }}
                    >
                      <SearchX
                        className="h-6 w-6"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      />
                    </div>
                    <Paragraph type="secondary" className="m-0 text-xs">
                      没有找到相关视频
                    </Paragraph>
                  </div>
                )}

                {/* 首次打开空态：横跨所有列 */}
                {!searched && !loading && items.length === 0 && (
                  <div className="flex [column-span:all] flex-col items-center justify-center gap-3 py-16">
                    <div
                      className="flex h-14 w-14 items-center justify-center rounded-full"
                      style={{ backgroundColor: 'var(--glass-bg)' }}
                    >
                      <Tv
                        className="h-6 w-6"
                        style={{
                          color: 'var(--md-sys-color-on-surface-variant)',
                        }}
                      />
                    </div>
                    <Paragraph type="secondary" className="m-0 text-xs">
                      输入关键词开始搜索
                    </Paragraph>
                  </div>
                )}

                {hasMore && (
                  <Button
                    variant="secondary"
                    size="sm"
                    block
                    loading={loadingMore}
                    onClick={() => void doSearch(keyword, page + 1, true)}
                    className="mb-3 [column-span:all]"
                  >
                    加载更多
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </FullscreenOverlay>
  )
}
