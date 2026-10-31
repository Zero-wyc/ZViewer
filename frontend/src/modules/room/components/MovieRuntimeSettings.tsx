/**
 * 影片级「播放设置」折叠区（影片卡片内）。
 *
 * 与「B站解析设置」同款交互：默认收起，展开后是两张子卡开关。
 * 与添加影片面板的区别：这里的改动直接写回影片记录（updateMovie）并广播
 * 给全房间，属性能实时生效的运行开关，而非「对下一次添加生效」。
 *
 * - 服务器中转：ani-subs / Kazumi / CMS 使用 movie.serverProxy；
 *   Emby / Jellyfin 使用 movie.directLink（取反），内网挂载隐藏切换项。
 *   解析链路每次播放都读该字段（resolveAnimeOnline / resolveKazumiOnline /
 *   resolveCmsOnline），所以改完需要重解析当前源。
 * - 浏览器转码（movie.playsvideoEnabled）：所有非 B站 影片。
 *   该字段是引擎门控（shouldUsePlaysVideo），改完需要重挂载才会重新选引擎。
 *
 * 仅房主可操作；观众看到的是房主设定后的当前状态。
 */
import { useState } from 'react'
import {
  ChevronDown,
  Cpu,
  Network,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import { Switch } from '@/components/ui'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import { getEmbyApiMovieSource } from '@/modules/emby/embyApi'
import {
  canSwitchEmbyPlayback,
  getEmbyMediaSourceId,
} from '@/modules/emby/playbackMode'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

interface SwitchCardProps {
  icon: LucideIcon
  title: string
  subtitle: string
  hint: string
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}

/**
 * 单个开关子卡：图标 + 标题/英文小标 + 右侧开关 + 一行状态说明。
 * 图标沿用影片卡片的处理方式（primary 色系图标块）：
 * 开启 = primary 实底 + on-primary 图标，关闭 = primary 12% 淡底 + primary 图标，
 * 与影片列表卡片的 Film 图标同款视觉语言，明暗主题下都与面板头一致。
 */
function SwitchCard({
  icon: Icon,
  title,
  subtitle,
  hint,
  checked,
  disabled = false,
  onToggle,
}: SwitchCardProps) {
  return (
    <div
      className="rounded-[var(--md-sys-shape-corner)] p-1.5"
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container-high)',
        border: checked
          ? '1px solid color-mix(in srgb, var(--md-sys-color-primary) 38%, transparent)'
          : '1px solid transparent',
      }}
    >
      <div className="flex items-center gap-1.5">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: checked
              ? 'var(--md-sys-color-primary)'
              : 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
          }}
        >
          <Icon
            className="h-3 w-3"
            style={{
              color: checked
                ? 'var(--md-sys-color-on-primary)'
                : 'var(--md-sys-color-primary)',
            }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="text-[10px] font-bold leading-tight"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            {title}
          </span>
          <span
            className="text-[8px] font-medium uppercase tracking-wide"
            style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          >
            {subtitle}
          </span>
        </div>
        <Switch
          checked={checked}
          disabled={disabled}
          onChange={() => onToggle()}
          aria-label={title}
          className="shrink-0"
        />
      </div>
      <div
        className="mt-1 text-[9px] leading-snug"
        style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
      >
        {hint}
      </div>
    </div>
  )
}

export interface MovieRuntimeSettingsProps {
  movieId: number
  /** 当前用户是否为房主（决定开关是否可操作） */
  isHost: boolean
}

export function MovieRuntimeSettings({
  movieId,
  isHost,
}: MovieRuntimeSettingsProps) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const movie = useRoomStore((s) => s.movies.find((m) => m.id === movieId))
  const roomId = useRoomStore((s) => s.roomId)
  const currentMovieId = useRoomStore((s) => s.currentMovieId)
  const updateMovie = useRoomStore((s) => s.updateMovie)
  const triggerMovieSourceReload = useRoomStore(
    (s) => s.triggerMovieSourceReload
  )

  if (!movie) return null

  // 内网 Emby/Jellyfin 沿用挂载策略，只能中转；其余地址均可切换。
  const showServerProxy =
    movie.sourceType === 'anime' ||
    movie.sourceType === 'kazumi' ||
    movie.sourceType === 'cms' ||
    canSwitchEmbyPlayback(movie)
  const isEmbyLike =
    movie.sourceType === 'emby' || movie.sourceType === 'jellyfin'
  const serverProxy = isEmbyLike
    ? movie.directLink !== true
    : movie.serverProxy === true
  // 缺省视为开启，与 shouldUsePlaysVideo 的 `!== false` 宽松语义一致
  const playsvideoEnabled = movie.playsvideoEnabled !== false

  const summary = [
    showServerProxy ? (serverProxy ? t('中转') : t('直连')) : null,
    playsvideoEnabled ? t('转码') : t('原生'),
  ]
    .filter(Boolean)
    .join(' · ')

  const applySetting = async (patch: {
    serverProxy?: boolean
    playsvideoEnabled?: boolean
  }) => {
    if (!isHost || !roomId || saving) return
    setSaving(true)
    try {
      if (isEmbyLike && patch.serverProxy !== undefined) {
        const api = movie.sourceType as 'emby' | 'jellyfin'
        const source = await getEmbyApiMovieSource(
          api,
          movieId,
          getEmbyMediaSourceId(movie.url)
        )
        const directLink = !patch.serverProxy
        const url = directLink ? source.directUrl : source.streamUrl
        if (!url) throw new Error(t('未取得影片播放地址'))
        await updateMovie(roomId, movieId, {
          directLink,
          url,
          format: source.format,
          ...(source.audioCodec ? { audioCodec: source.audioCodec } : {}),
        })
      } else {
        await updateMovie(roomId, movieId, patch)
      }
      // 正在播放的影片才需要即时重解析/重挂载；其余影片的值在下次加载时生效
      if (movieId === currentMovieId) {
        triggerMovieSourceReload()
      }
    } catch (err) {
      console.error('[MovieRuntimeSettings] update setting error:', err)
      message.error(err instanceof Error ? err.message : t('切换播放设置失败'))
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
          播放设置
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[9px]">{summary}</span>
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
          {showServerProxy && (
            <SwitchCard
              icon={Network}
              title={t('服务器中转')}
              subtitle="SERVER RELAY"
              checked={serverProxy}
              disabled={!isHost || saving}
              onToggle={() => void applySetting({ serverProxy: !serverProxy })}
              hint={
                !isHost
                  ? t('由房主统一管理')
                  : serverProxy
                    ? t('媒体流经服务器转发，可绕过防盗链限制')
                    : t('直连源站，不占用服务器带宽')
              }
            />
          )}
          <SwitchCard
            icon={Cpu}
            title={t('浏览器转码')}
            subtitle="BROWSER TRANSCODE"
            checked={playsvideoEnabled}
            disabled={!isHost || saving}
            onToggle={() =>
              void applySetting({ playsvideoEnabled: !playsvideoEnabled })
            }
            hint={
              !isHost
                ? t('由房主统一管理')
                : playsvideoEnabled
                  ? t('MKV / DTS 等非常规格式由浏览器重封装后播放')
                  : t('强制原生播放，浏览器不支持的编码会没有画面或声音')
            }
          />
        </div>
      )}
    </div>
  )
}
