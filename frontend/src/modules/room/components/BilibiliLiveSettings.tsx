/**
 * B站直播「解析设置」（影片卡片内，仅直播间影片显示）。
 *
 * 与点播的 BilibiliParseSettings 同款折叠交互，只有一个选项：播放线路。
 *
 * - CLI：媒体流由**每台设备自己的** ZViewer CLI 直连 B站 CDN，服务器出口
 *   带宽归零。直播是「每个观众各拉一条流」，中转意味着服务器出口 =
 *   观众数 × 码率，人一多就是硬瓶颈。
 *   B站 直播 CDN 有防盗链（Referer/Origin 必须是 live.bilibili.com），
 *   浏览器直连必被拒——所以「不经服务器」这条线路只能由 CLI 实现。
 * - 中转：媒体流经服务器转发（后端注入 Referer/Origin），兼容性最好，
 *   不要求任何本地程序。
 *
 * 线路属于播放源属性而非本机偏好，写回 movie.serverProxy 并随房间状态广播，
 * 保证全房间看的是同一条线路（解析与鉴权都用房主身份，线路也应该一致）。
 * 房主可切换；观众只读，显示房主当前选择。
 *
 * 注意 `serverProxy` 是历史字段名：false 现在表示「CLI 线路」，不再表示
 * 「浏览器直连」——后者在这条链路上已被证伪，见上。
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Settings2, Signal } from 'lucide-react'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import { useCliAgentStore } from '@/store/cliAgentStore'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export interface BilibiliLiveSettingsProps {
  movieId: number
  /** 当前用户是否为房主（决定线路是否可切换） */
  isHost: boolean
}

export function BilibiliLiveSettings({
  movieId,
  isHost,
}: BilibiliLiveSettingsProps) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  // 待生效的目标线路：updateMovie 只发 PUT、不回写本地 state，等后端
  // movie-list 广播到达后才可靠；在此之前重载会读到旧 serverProxy，
  // 解析出来的仍是旧线路（=切了没反应）。用 ref 保存，广播到达时由
  // serverProxy 变化驱动 effect，不需要额外 setState 触发重渲染。
  const pendingRouteRef = useRef<boolean | null>(null)
  const movie = useRoomStore((s) => s.movies.find((m) => m.id === movieId))
  const roomId = useRoomStore((s) => s.roomId)
  const currentMovieId = useRoomStore((s) => s.currentMovieId)
  const updateMovie = useRoomStore((s) => s.updateMovie)
  const triggerReloadBilibili = useRoomStore((s) => s.triggerReloadBilibili)
  // CLI 代理按账号归属注册，agents 非空即表示本机（或旧版无归属的）CLI
  // 已连上服务器。播放层用的也是同一份数据，这里不另做判断。
  const cliReady = useCliAgentStore((s) => s.agents.length > 0)

  const serverProxy = movie?.serverProxy === true

  // 广播到达（store 里的值等于目标）后再重载：此时重新解析才会拿到新线路。
  useEffect(() => {
    const target = pendingRouteRef.current
    if (target === null || serverProxy !== target) return
    pendingRouteRef.current = null
    if (movieId === currentMovieId) triggerReloadBilibili()
  }, [serverProxy, movieId, currentMovieId, triggerReloadBilibili])

  if (!movie) return null

  // serverProxy 缺省为 false：直播新建时显式写入 true（沿用既有中转行为），
  // 因此这里 false 仅表示房主主动选了「CLI」。
  const disabled = !isHost || saving

  const applyRoute = async (next: boolean) => {
    if (disabled || !roomId || next === serverProxy) return
    setSaving(true)
    // 必须在发请求前登记：后端 movie-list 广播可能比 PUT 响应更早到达，
    // 那时 effect 已经跑过一次（旧 ref 为 null 会直接返回），之后再赋值
    // 就没有第二次触发机会，线路切换会静默失效。
    pendingRouteRef.current = next
    try {
      await updateMovie(roomId, movieId, { serverProxy: next })
      if (!next && !cliReady) {
        message.warning(
          t('本机未检测到 CLI，将退回服务器中转；启动 ZViewer CLI 后自动生效')
        )
      } else {
        message.success(
          next
            ? t('已切回服务器中转，观众将经本服务器拉流')
            : t('已切换为 CLI 线路，媒体流由各端本地 CLI 直连')
        )
      }
    } catch (err) {
      pendingRouteRef.current = null
      console.error('[BilibiliLiveSettings] update route error:', err)
      message.error(err instanceof Error ? err.message : t('切换播放线路失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between rounded-[var(--md-sys-shape-corner)] px-1.5 py-1 text-[10px] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-1 font-medium">
          <Settings2 className="h-3 w-3" />
          {t('B站解析设置')}
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[9px]">{serverProxy ? t('中转') : 'CLI'}</span>
          <ChevronDown
            className={cn(
              'h-3 w-3 transition-transform',
              expanded && 'rotate-180'
            )}
          />
        </span>
      </button>

      {expanded && (
        <div
          className="mt-1 flex flex-col gap-2.5 rounded-[var(--md-sys-shape-corner)] p-2"
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container)',
            border: '1px solid var(--md-sys-color-outline-variant)',
          }}
        >
          <div
            className="rounded-[var(--md-sys-shape-corner)] p-1.5"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            <div className="flex items-center gap-1.5">
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                style={{
                  background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-secondary) 18%, transparent))',
                }}
              >
                <Signal
                  className="h-3 w-3"
                  style={{ color: 'var(--md-sys-color-tertiary)' }}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className="text-[10px] font-bold leading-tight"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                >
                  {t('播放线路')}
                </span>
                <span
                  className="text-[8px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  STREAM ROUTE
                </span>
              </div>
              <span
                className="text-[9px] font-medium"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                {serverProxy ? t('中转') : 'CLI'}
              </span>
            </div>

            <div className="mt-1.5 grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={disabled}
                onClick={() => void applyRoute(false)}
                className={cn(
                  'rounded-md py-1 text-[10px] font-semibold transition-all disabled:opacity-50',
                  !serverProxy
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'bg-[var(--md-sys-color-surface-container)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                CLI
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void applyRoute(true)}
                className={cn(
                  'rounded-md py-1 text-[10px] font-semibold transition-all disabled:opacity-50',
                  serverProxy
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'bg-[var(--md-sys-color-surface-container)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                {t('中转')}
              </button>
            </div>

            <div
              className="mt-1 text-[9px] leading-snug"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {!isHost
                ? t('播放线路由房主统一设置')
                : serverProxy
                  ? t('媒体流经本服务器转发；观众越多，服务器出口带宽占用越大')
                  : cliReady
                    ? t(
                        '媒体流由各端本地 ZViewer CLI 直连 B站，服务器不转发；未开 CLI 的一端会自动退回中转'
                      )
                    : t(
                        '未检测到本地 CLI：本机将退回服务器中转。启动 ZViewer CLI 后自动生效'
                      )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
