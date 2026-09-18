/**
 * 哔哩哔哩收藏夹选择弹窗（播放控制栏「添加到哔哩哔哩我的收藏夹」按钮）：
 * 列出当前 B站 账号的收藏夹，点击即收藏当前播放的 B站 视频
 * （后端 /bilibili/fav/collect：view 拿 aid → resource/deal 收藏）。
 * 黑底 SETTING 风格（与歌词页设置/屏蔽词弹窗同语言）。
 *
 * 展开动画（网易云搜索弹窗同款）：屏幕居中锚定，cloud-add-in 宽→高
 * 两段式从中心向四周舒展；面板**固定高度**（列表区域内部滚动），收藏夹
 * 列表在展开动画结束后才挂载——加载多快都不会把框瞬时拉大。
 *
 * 收藏夹拉取与展开动画**并行**：open 即发请求（模块级缓存 60s TTL +
 * in-flight 去重，导出 prefetchBiliFavFolders 供触发按钮 hover 预取）。
 *
 * 渲染经 portal 挂到 body：widget 播放条等祖先带 transform 动画，会把
 * position:fixed 变为相对该祖先定位（弹窗卡在底部而非屏幕中央），portal
 * 绕过 transform 祖先恢复视口居中。收藏夹封面统一走后端防盗链代理
 * （B站 CDN 直链 403），加载失败回退图标。
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListMusic, Loader2, X } from 'lucide-react'
import { apiPost } from '@/lib/api'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'
import {
  prefetchBiliFavFolders,
  type BilibiliFavFolder,
} from '@/modules/bilibili/bilibiliApi'
import {
  buildBilibiliImageProxyUrl,
  isBilibiliImageUrl,
} from '@/modules/room/watch-together/resolveSource'

interface BiliFavCollectModalProps {
  open: boolean
  /** 当前播放的 B站 视频 BV 号 */
  bvid: string
  /** 收藏成功回调（供外部同步红心状态；folderTitle 为实际收藏到的收藏夹名） */
  onCollected?: (bvid: string, folderTitle?: string) => void
  onClose: () => void
}

/** 收藏夹列表拉取走模块级缓存：见 bilibiliApi.prefetchBiliFavFolders */

export function BiliFavCollectModal({
  open,
  bvid,
  onCollected,
  onClose,
}: BiliFavCollectModalProps) {
  const [folders, setFolders] = useState<BilibiliFavFolder[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [collectingId, setCollectingId] = useState<number | null>(null)
  /** 面板展开动画是否已结束（列表内容延后挂载，加载多快都不撑框） */
  const [unfoldDone, setUnfoldDone] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // 打开即拉取收藏夹（与展开动画并行：请求在 effect 内立即发出，不等待
  // 动画；缓存命中零等待）+ 复位展开标记。
  // 状态更新走 setTimeout(0) 规避 effect 内同步 setState
  useEffect(() => {
    if (!open) return
    let cancelled = false
    const fetchPromise = prefetchBiliFavFolders()
    const timer = setTimeout(() => {
      if (cancelled) return
      setUnfoldDone(false)
      setLoading(true)
      setError(null)
      void (async () => {
        try {
          const list = await fetchPromise
          if (!cancelled) setFolders(list)
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : '获取收藏夹失败')
          }
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open])

  const handleCollect = async (folder: BilibiliFavFolder) => {
    if (collectingId != null) return
    setCollectingId(folder.id)
    try {
      const { data, ok } = await apiPost<{
        success?: boolean
        message?: string
        folderTitle?: string
      }>('/api/stream/bilibili/fav/collect', { bvid, mediaId: folder.id })
      if (!ok || data?.success === false) {
        throw new Error(data?.message || '收藏失败')
      }
      message.success(`已收藏到「${data?.folderTitle || folder.title}」`)
      onCollected?.(bvid, data?.folderTitle || folder.title)
      onClose()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '收藏失败')
    } finally {
      setCollectingId(null)
    }
  }

  if (!open) return null

  return createPortal(
    <>
      <button
        type="button"
        aria-label="关闭收藏夹选择"
        className="fixed inset-0 z-[74] cursor-default bg-black/40"
        onClick={onClose}
      />
      {/* 面板：居中锚定 + cloud-add-in 两段式展开（宽 0→360 → 高 0→420，
          以中心为原点向四周舒展）；固定高度，列表区域内部滚动 */}
      <div
        className="fixed left-1/2 top-1/2 z-[75] flex w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden"
        style={
          {
            transform: 'translate(-50%, -50%)',
            '--add-panel-w': 'min(360px, calc(100vw - 32px))',
            '--add-panel-h': 'min(420px, calc(100vh - 160px))',
            animation: 'cloud-add-in 0.6s 0.3s both',
            backgroundColor: 'rgba(8, 8, 8, 0.86)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '0.5px solid rgba(255, 255, 255, 0.12)',
            boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)',
          } as React.CSSProperties
        }
        onAnimationEnd={(e) => {
          if (
            e.target === e.currentTarget &&
            e.animationName === 'cloud-add-in'
          ) {
            setUnfoldDone(true)
          }
        }}
      >
        {/* 四角白色方块点缀 */}
        <span
          aria-hidden="true"
          className="absolute left-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 left-2 z-[2] h-2 w-2 bg-white"
        />
        <span
          aria-hidden="true"
          className="absolute bottom-2 right-2 z-[2] h-2 w-2 bg-white"
        />
        {/* 内容（展开结束后挂载：标题 0.5s 延迟淡入 + 列表即刻就位——
            预取通常已完成，加载多快都不会再改变面板尺寸） */}
        {unfoldDone && (
          <>
            {/* 标题行：超大 FAV 水印 */}
            <div
              className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
              style={{ animation: 'cloud-add-title-in 0.3s 0.5s both' }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
              >
                FAV
              </span>
              <p className="relative text-center text-[15px] font-bold text-white">
                添加到哔哩哔哩收藏夹
              </p>
            </div>
            <div className="zen-scroll relative min-h-0 flex-1 overflow-y-auto px-3 py-3">
              {loading && (
                <div className="flex items-center justify-center gap-2 py-6 text-xs font-bold text-white/60">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  正在获取收藏夹…
                </div>
              )}
              {!loading && error && (
                <p className="py-4 text-center text-xs font-bold text-white/60">
                  {error}
                </p>
              )}
              {!loading && !error && folders.length === 0 && (
                <p className="py-4 text-center text-xs font-bold text-white/60">
                  暂无收藏夹
                </p>
              )}
              {!loading &&
                !error &&
                folders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => void handleCollect(f)}
                    disabled={collectingId != null}
                    className="group flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-[rgba(255,255,255,0.08)] disabled:opacity-60"
                  >
                    <span
                      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md overflow-hidden"
                      style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}
                    >
                      {f.cover ? (
                        <img
                          src={
                            isBilibiliImageUrl(f.cover)
                              ? buildBilibiliImageProxyUrl(f.cover)
                              : f.cover
                          }
                          alt=""
                          className="h-full w-full object-cover"
                          onError={(e) => {
                            // 加载失败隐藏自身，露出图标兜底
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      ) : (
                        <ListMusic className="h-4 w-4 text-white/50" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold text-white">
                        {f.title}
                      </span>
                      <span className="block text-[11px] font-medium text-white/50">
                        {f.mediaCount} 个视频
                      </span>
                    </span>
                    {collectingId === f.id && (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin text-white/70" />
                    )}
                  </button>
                ))}
            </div>
          </>
        )}
        {/* 关闭按钮 */}
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-[3] flex h-6 w-6 items-center justify-center rounded-full transition-opacity hover:opacity-70"
          style={{ backgroundColor: 'rgba(255, 255, 255, 0.12)' }}
          title="关闭"
          aria-label="关闭"
        >
          <X className={cn('h-3.5 w-3.5 text-white')} />
        </button>
      </div>
    </>,
    document.body
  )
}
