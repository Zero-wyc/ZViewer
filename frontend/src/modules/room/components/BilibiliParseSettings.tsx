/**
 * B站解析设置（按影片独立配置）。
 *
 * 每个哔哩哔哩影片独享一份解析偏好（preferMp4 / bufferMode / p2pEnabled / cliEnabled），
 * 配置存储在 localStorage 中，以 movieId 为 key，仅对该影片生效。
 * 编码格式由后端自动适配，无需用户手动选择。
 *
 * 折叠展开式，默认收起。修改后立即写入 localStorage 持久化，
 * 若该影片正在播放（即 currentMovieId === movieId）则触发重新解析以即时生效。
 *
 * 房主可操作全部选项；观众端仅可查看房主选择的播放模式 / 缓冲模式，
 * 并独立开启自己的 CLI 高画质代理以降低服务器带宽和提升画质。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  Settings2,
  ChevronDown,
  MonitorSmartphone,
  ExternalLink,
} from 'lucide-react'
import { useRoomStore } from '@/store/roomStore'
import {
  useBilibiliParsePreferences,
  setBilibiliParseOptions,
  getBilibiliParseOptions,
} from '@/modules/bilibili/parseOptions'
import { getEffectivePreferMp4 } from '@/modules/room/watch-together/movie-source-resolver'
import {
  useP2PStatsStore,
  formatKBytes,
} from '@/modules/player/services/p2p-stats-store'
import { useCliAgent } from '@/hooks/useCliAgent'
import { getApiUrl } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'

export interface BilibiliParseSettingsProps {
  /** 影片 ID，配置按此 key 独立存储 */
  movieId: number
  /** 当前房间 ID，用于检测本地 CLI 代理 */
  roomId: string
  /** 当前用户是否为房主（决定选项是否可操作） */
  isHost: boolean
}

export function BilibiliParseSettings({
  movieId,
  roomId,
  isHost,
}: BilibiliParseSettingsProps) {
  const [expanded, setExpanded] = useState(false)
  const [pendingCliReload, setPendingCliReload] = useState(false)
  const { bufferMode, p2pEnabled, cliEnabled } =
    useBilibiliParsePreferences(movieId)
  const cliAgent = useCliAgent(roomId)
  const triggerReloadBilibili = useRoomStore(
    (state) => state.triggerReloadBilibili
  )
  const triggerViewerSourceReload = useRoomStore(
    (state) => state.triggerViewerSourceReload
  )
  const currentMovieId = useRoomStore((state) => state.currentMovieId)
  const watchTogetherBufferMode = useRoomStore(
    (state) => state.watchTogether.bufferMode
  )
  const cliUnavailable = cliEnabled && !cliAgent.available
  const dashDisabled = useSystemSettingsStore((s) => s.dashDisabled)
  // 服务器端 DASH 禁用时，CLI 未启用的影片强制 MP4 且不可切换
  const dashLocked = dashDisabled && !cliEnabled
  const effectivePreferMp4 = dashLocked || getEffectivePreferMp4(movieId)
  const displayPreferMp4 = effectivePreferMp4

  const viewerDisplayBufferMode =
    movieId === currentMovieId ? watchTogetherBufferMode : false
  const displayBufferMode = isHost ? bufferMode : viewerDisplayBufferMode

  const displayP2pEnabled = p2pEnabled
  const displayCliEnabled = cliEnabled

  const p2pEngineActive = useP2PStatsStore((s) => s.engineActive)
  const totalHTTPDownloaded = useP2PStatsStore((s) => s.totalHTTPDownloaded)
  const totalP2PDownloaded = useP2PStatsStore((s) => s.totalP2PDownloaded)
  const totalP2PUploaded = useP2PStatsStore((s) => s.totalP2PUploaded)
  const p2pDownloadSpeed = useP2PStatsStore((s) => s.p2pDownloadSpeed)

  const isCurrentMovie = movieId === currentMovieId

  const handlePreferMp4Change = useCallback(
    (next: boolean) => {
      if (!isHost || dashLocked) return
      setBilibiliParseOptions(movieId, {
        preferMp4: next,
        bufferMode: next ? false : undefined,
        p2pEnabled: next ? false : undefined,
      })
      if (isCurrentMovie) {
        triggerReloadBilibili()
      }
    },
    [movieId, isHost, isCurrentMovie, triggerReloadBilibili, dashLocked]
  )

  const handleBufferModeChange = useCallback(
    (next: boolean) => {
      if (!isHost) return
      setBilibiliParseOptions(movieId, {
        bufferMode: next,
        p2pEnabled: next ? false : undefined,
      })
      if (isCurrentMovie) {
        triggerReloadBilibili()
      }
    },
    [movieId, isHost, isCurrentMovie, triggerReloadBilibili]
  )

  const handleP2PChange = useCallback(
    (next: boolean) => {
      if (!isHost) return
      setBilibiliParseOptions(movieId, {
        p2pEnabled: next,
        cliEnabled: next ? false : undefined,
      })
      if (isCurrentMovie) {
        triggerReloadBilibili()
      }
    },
    [movieId, isHost, isCurrentMovie, triggerReloadBilibili]
  )

  const handleCliChange = useCallback(
    (next: boolean) => {
      const current = getBilibiliParseOptions(movieId)
      if (next) {
        setBilibiliParseOptions(movieId, {
          cliEnabled: true,
          p2pEnabled: false,
          preferMp4: false,
          cliPrevPreferMp4: current.preferMp4,
        })
      } else {
        setBilibiliParseOptions(movieId, {
          cliEnabled: false,
          p2pEnabled: undefined,
          preferMp4: current.cliPrevPreferMp4 ?? true,
          cliPrevPreferMp4: undefined,
        })
      }
      if (!isCurrentMovie) return
      if (next && !cliAgent.available) {
        setPendingCliReload(true)
        return
      }
      if (isHost) {
        triggerReloadBilibili()
      } else {
        triggerViewerSourceReload()
      }
    },
    [
      movieId,
      isHost,
      isCurrentMovie,
      cliAgent.available,
      triggerReloadBilibili,
      triggerViewerSourceReload,
    ]
  )

  // React Compiler 严格规则误报：本 effect 根据外部 CLI 代理状态变化触发重载，
  // setPendingCliReload 用于清除一次性等待标记，不存在级联渲染问题。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!pendingCliReload) return
    if (cliAgent.available) {
      setPendingCliReload(false)
      if (isHost) {
        triggerReloadBilibili()
      } else {
        triggerViewerSourceReload()
      }
      return
    }
    const timer = setTimeout(() => {
      setPendingCliReload(false)
    }, 10000)
    return () => clearTimeout(timer)
  }, [
    pendingCliReload,
    cliAgent.available,
    isHost,
    triggerReloadBilibili,
    triggerViewerSourceReload,
  ])
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleOpenCliSetup = useCallback(() => {
    const url = new URL('http://127.0.0.1:9333/')
    url.searchParams.set('server', getApiUrl())
    url.searchParams.set('room', roomId)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }, [roomId])

  const renderSegmented = (
    value: boolean,
    onChange: (next: boolean) => void,
    leftLabel: string,
    rightLabel: string,
    disabled = false
  ) => (
    <div
      className={cn(
        'grid grid-cols-2 gap-1 rounded-lg p-0.5',
        disabled && 'opacity-40'
      )}
      style={{
        backgroundColor: 'var(--md-sys-color-surface-container-high)',
      }}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(false)}
        className={cn(
          'rounded-md py-1 text-[10px] font-semibold transition-all',
          !value
            ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
            : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
        )}
      >
        {leftLabel}
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(true)}
        className={cn(
          'rounded-md py-1 text-[10px] font-semibold transition-all',
          value
            ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
            : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
        )}
      >
        {rightLabel}
      </button>
    </div>
  )

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
          B站解析设置
        </span>
        <ChevronDown
          className={cn(
            'h-3 w-3 transition-transform',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {expanded && (
        <div
          className="mt-1 flex flex-col gap-2.5 rounded-[var(--md-sys-shape-corner)] p-2"
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container)',
            border: '1px solid var(--md-sys-color-outline-variant)',
          }}
        >
          {/* CLI 本地高画质代理 */}
          <div
            className={cn(
              'rounded-[var(--md-sys-shape-corner)] p-1.5 transition-opacity',
              displayP2pEnabled && 'pointer-events-none opacity-40'
            )}
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
                <MonitorSmartphone
                  className="h-3 w-3"
                  style={{ color: 'var(--md-sys-color-tertiary)' }}
                />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span
                  className="text-[10px] font-bold leading-tight"
                  style={{ color: 'var(--md-sys-color-on-surface)' }}
                >
                  CLI 高画质代理
                </span>
                <span
                  className="text-[8px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  LOCAL PROXY
                </span>
              </div>
              <div className="flex items-center gap-1">
                <span
                  className="inline-block h-1 w-1 rounded-full"
                  style={{
                    backgroundColor: cliAgent.available
                      ? 'var(--md-sys-color-tertiary)'
                      : displayCliEnabled
                        ? 'var(--md-sys-color-error)'
                        : 'var(--md-sys-color-outline)',
                    boxShadow: cliAgent.available
                      ? '0 0 4px var(--md-sys-color-tertiary)'
                      : 'none',
                  }}
                />
                <span
                  className="text-[9px] font-medium"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  {cliAgent.available
                    ? '已连接'
                    : displayCliEnabled
                      ? '未连接'
                      : '未启用'}
                </span>
              </div>
            </div>

            <div className="mt-1.5 grid grid-cols-2 gap-1">
              <button
                type="button"
                disabled={displayP2pEnabled}
                onClick={() => handleCliChange(false)}
                className={cn(
                  'rounded-md py-1 text-[10px] font-semibold transition-all',
                  displayP2pEnabled && 'cursor-not-allowed opacity-40',
                  !displayCliEnabled
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'bg-[var(--md-sys-color-surface-container)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                关闭
              </button>
              <button
                type="button"
                disabled={displayP2pEnabled}
                onClick={() => handleCliChange(true)}
                className={cn(
                  'rounded-md py-1 text-[10px] font-semibold transition-all',
                  displayP2pEnabled && 'cursor-not-allowed opacity-40',
                  displayCliEnabled
                    ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'bg-[var(--md-sys-color-surface-container)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                启用
              </button>
            </div>

            <div
              className={cn(
                'mt-1 text-[9px] leading-snug',
                cliUnavailable && 'text-[var(--md-sys-color-error)]'
              )}
              style={
                cliUnavailable
                  ? undefined
                  : { color: 'var(--md-sys-color-on-surface-variant)' }
              }
            >
              {displayP2pEnabled
                ? 'P2P 与 CLI 代理互斥，请关闭 P2P 后再启用 CLI'
                : displayCliEnabled
                  ? cliAgent.available
                    ? `已连接本地代理 ${cliAgent.agentInfo?.version ?? ''}`
                    : '已启用但未检测到本地 CLI，请先启动本地代理以播放 DASH 高画质'
                  : '使用本地 zcontrol-cli 获取大会员等高画质'}
            </div>

            <button
              type="button"
              onClick={handleOpenCliSetup}
              className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-md bg-[var(--md-sys-color-surface-container)] px-2 py-1 text-[10px] font-semibold text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)]"
              style={{
                border: '1px solid var(--md-sys-color-outline)',
              }}
            >
              <ExternalLink className="h-3 w-3" />
              打开 CLI 配置页
            </button>
          </div>

          {/* 播放模式 */}
          <div>
            <div
              className="mb-1 text-[10px] font-bold uppercase tracking-wide"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              播放模式
            </div>
            {renderSegmented(
              displayPreferMp4,
              handlePreferMp4Change,
              'DASH 高清',
              'MP4 流畅',
              !isHost || cliEnabled || dashLocked
            )}
            <div
              className="mt-1 text-[10px] leading-snug"
              style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
            >
              {' '}
              {dashLocked
                ? '服务器已禁用 DASH 模式，当前强制 MP4 播放'
                : cliEnabled
                  ? cliAgent.available
                    ? 'CLI 代理已启用，当前使用本地 DASH 高画质解析（不再自动降级 MP4）'
                    : '已启用 CLI 但未连接本地代理，请先启动本地 zcontrol-cli 以播放 DASH 高画质'
                  : displayPreferMp4
                    ? 'MP4 直链，seek 流畅，清晰度通常 480P/720P'
                    : 'DASH 分离流，支持 1080P/4K，seek 需缓冲'}
            </div>
          </div>

          {/* 缓冲模式（仅服务器 DASH 可用时显示） */}
          {!dashDisabled && (
            <div
              className={cn(
                'transition-opacity',
                effectivePreferMp4 && 'pointer-events-none opacity-40'
              )}
            >
              <div
                className="mb-1 text-[10px] font-bold uppercase tracking-wide"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                缓冲模式
              </div>
              {renderSegmented(
                displayBufferMode,
                handleBufferModeChange,
                '关闭',
                '开启',
                !isHost || effectivePreferMp4
              )}
              <div
                className="mt-1 text-[10px] leading-snug"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                {!isHost
                  ? '缓冲模式由房主统一管理'
                  : effectivePreferMp4
                    ? 'MP4 模式不支持缓冲，请切换到 DASH'
                    : displayBufferMode
                      ? '进入房间先缓存完整视频到本地，避免 URL 过期与卡顿'
                      : '直接流式播放，无需等待缓存'}
              </div>
            </div>
          )}

          {/* P2P 传输（仅服务器 DASH 可用时显示） */}
          {!dashDisabled && (
            <div
              className={cn(
                'transition-opacity',
                (!isHost ||
                  effectivePreferMp4 ||
                  displayBufferMode ||
                  displayCliEnabled) &&
                  'pointer-events-none opacity-40'
              )}
            >
              <div
                className="mb-1 text-[10px] font-bold uppercase tracking-wide"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                P2P 传输
              </div>
              {renderSegmented(
                displayP2pEnabled,
                handleP2PChange,
                '关闭',
                '开启',
                !isHost ||
                  effectivePreferMp4 ||
                  displayBufferMode ||
                  displayCliEnabled
              )}
              <div
                className="mt-1 text-[10px] leading-snug"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                {!isHost
                  ? 'P2P 传输由房主统一管理'
                  : effectivePreferMp4
                    ? 'MP4 模式不支持 P2P，请切换到 DASH'
                    : displayCliEnabled
                      ? 'CLI 代理与 P2P 互斥，请关闭 CLI 后再启用 P2P'
                      : displayBufferMode
                        ? '缓冲模式下视频已本地缓存，无需 P2P'
                        : displayP2pEnabled
                          ? '房间内观众间共享分片，减少服务器流量（需 WebRTC）'
                          : '所有流量走服务器代理'}
              </div>

              {displayP2pEnabled && p2pEngineActive && (
                <div
                  className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 rounded-lg p-1.5 text-[10px]"
                  style={{
                    backgroundColor:
                      'var(--md-sys-color-surface-container-high)',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      ↓HTTP
                    </span>
                    <span className="font-mono font-semibold">
                      {formatKBytes(totalHTTPDownloaded)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      ↓P2P
                    </span>
                    <span className="font-mono font-semibold">
                      {formatKBytes(totalP2PDownloaded)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      ↑P2P
                    </span>
                    <span className="font-mono font-semibold">
                      {formatKBytes(totalP2PUploaded)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      速度
                    </span>
                    <span className="font-mono font-semibold">
                      {formatKBytes(p2pDownloadSpeed)}/s
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
