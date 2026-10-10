/**
 * 观众端「仅允许CLI模式」引导覆盖层。
 *
 * 当前影片 cliOnly（仅允许CLI模式）且本机 CLI 未连接时显示
 * （roomStore.viewerCliRequiredMovieId）：覆盖播放器区域，与
 * useVideoSource.applySourceToVideo 的同标志挂载拦截配合——cliOnly
 * 语义下不回退服务器转发（服务器零媒体流量），观众必须自备
 * ZViewer CLI 并用自己的 CLI 解析播放。
 *
 * 恢复路径：
 * - 手动：「我已连接，重试」触发观众端源重载；
 * - 自动：cliAgent.available 由未连接变为已连接时自动重载。
 */
import { ExternalLink, Lock, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { useRoomStore } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import { useCliAgent } from '@/hooks/useCliAgent'
import { getApiUrl } from '@/lib/api'

export function ViewerCliRequiredOverlay() {
  const movieId = useRoomStore((s) => s.viewerCliRequiredMovieId)
  const triggerViewerSourceReload = useRoomStore(
    (s) => s.triggerViewerSourceReload
  )
  const movie = useRoomStore((s) => s.movies.find((m) => m.id === movieId))
  const cliAgent = useCliAgent()

  const handleOpenCliSetup = useCallback(() => {
    const url = new URL('http://127.0.0.1:9333/')
    url.searchParams.set('server', getApiUrl())
    const username = useAuthStore.getState().user?.username
    if (username) url.searchParams.set('user', username)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }, [])

  // CLI 连接后自动重载：available false→true 时触发观众端源重载，
  // ensureViewerLocalOverride 将清除标志并按 CLI 正常解析
  const prevAvailableRef = useRef(cliAgent.available)
  useEffect(() => {
    if (cliAgent.available && !prevAvailableRef.current && movieId != null) {
      triggerViewerSourceReload()
    }
    prevAvailableRef.current = cliAgent.available
  }, [cliAgent.available, movieId, triggerViewerSourceReload])

  if (movieId == null) return null

  return (
    <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/80 px-6 text-center backdrop-blur-sm">
      <Lock className="h-10 w-10 shrink-0 text-[var(--md-sys-color-tertiary)]" />
      <div className="text-sm font-bold text-white">
        该影片仅允许 CLI 模式观看
      </div>
      <div className="max-w-md text-xs leading-relaxed text-white/70">
        房主已对本影片
        {movie?.title ? `「${movie.title}」` : ''}
        开启「仅允许CLI模式」：媒体流不经服务器转发，每位成员需安装并连接
        ZViewer CLI 后使用自己的 CLI 解析播放。
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={handleOpenCliSetup}
          className="flex items-center gap-1 rounded-md bg-[var(--md-sys-color-primary)] px-3 py-1.5 text-xs font-semibold text-[var(--md-sys-color-on-primary)] transition-opacity hover:opacity-90"
        >
          <ExternalLink className="h-3 w-3" />
          打开 CLI 配置页
        </button>
        <button
          type="button"
          onClick={() => triggerViewerSourceReload()}
          className="flex items-center gap-1 rounded-md border border-white/30 px-3 py-1.5 text-xs font-semibold text-white/90 transition-colors hover:bg-white/10"
        >
          <RefreshCw className="h-3 w-3" />
          我已连接，重试
        </button>
      </div>
    </div>
  )
}
