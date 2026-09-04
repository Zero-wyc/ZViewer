/**
 * 流量统计悬浮面板（房间页左下角）
 *
 * - 普通用户：本次会话的浏览器 HTTP 下载/上传流量（总量 + 即时速度）
 * - root 用户：额外展示服务端网卡级收发流量（轮询 /api/stats/traffic）
 *
 * 交互与右下角的语音聊天面板一致：点击圆形按钮展开，再点收起。
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Activity, ArrowDown, ArrowUp, ChevronDown, Server } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { apiFetch } from '@/lib/api'
import {
  getLocalTraffic,
  installTrafficCounter,
  type LocalTraffic,
} from '@/lib/traffic-counter'
import { cn } from '@/lib/utils'

interface ServerTraffic {
  rxBytes: number
  txBytes: number
  rxSpeed: number
  txSpeed: number
}

const SAMPLE_INTERVAL_MS = 1000
const SERVER_POLL_INTERVAL_MS = 2000

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 2 ** (10 * i)
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function TrafficPanel() {
  const [expanded, setExpanded] = useState(false)
  const [local, setLocal] = useState<LocalTraffic>({ downTotal: 0, upTotal: 0 })
  const [speeds, setSpeeds] = useState({ downSpeed: 0, upSpeed: 0 })
  const [server, setServer] = useState<ServerTraffic | null>(null)
  const [serverAvailable, setServerAvailable] = useState(true)
  const prevLocalRef = useRef({ ...local, at: Date.now() })

  const user = useAuthStore((s) => s.user)
  const isRoot = user?.role === 'root'

  // 安装全局流量打点（幂等）+ 本地速度采样（1s 差分，EMA 平滑）
  useEffect(() => {
    installTrafficCounter()
    const timer = setInterval(() => {
      const now = Date.now()
      const current = getLocalTraffic()
      const prev = prevLocalRef.current
      const dt = (now - prev.at) / 1000
      if (dt > 0.2) {
        const rawDown = Math.max(0, (current.downTotal - prev.downTotal) / dt)
        const rawUp = Math.max(0, (current.upTotal - prev.upTotal) / dt)
        setSpeeds((prevSpeeds) => ({
          downSpeed: prevSpeeds.downSpeed * 0.5 + rawDown * 0.5,
          upSpeed: prevSpeeds.upSpeed * 0.5 + rawUp * 0.5,
        }))
        prevLocalRef.current = { ...current, at: now }
      }
      setLocal(current)
    }, SAMPLE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  // root：轮询服务端网卡流量；403/501 等错误则隐藏该区块
  useEffect(() => {
    if (!isRoot || !expanded) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await apiFetch('/api/stats/traffic')
        if (!res.ok) {
          if (!cancelled) setServerAvailable(false)
          return
        }
        const data = (await res.json()) as {
          success: boolean
          stats?: ServerTraffic
        }
        if (cancelled) return
        if (data.success && data.stats) {
          setServer(data.stats)
          setServerAvailable(true)
        } else {
          setServerAvailable(false)
        }
      } catch {
        if (!cancelled) setServerAvailable(false)
      }
    }
    void poll()
    const timer = setInterval(poll, SERVER_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [isRoot, expanded])

  const rows: { label: string; total: number; speed: number; down: boolean }[] = [
    {
      label: '下载',
      total: local.downTotal,
      speed: speeds.downSpeed,
      down: true,
    },
    {
      label: '上传',
      total: local.upTotal,
      speed: speeds.upSpeed,
      down: false,
    },
  ]

  return createPortal(
    <div
      className={cn(
        'fixed bottom-6 left-6 z-40 flex flex-col items-start gap-3',
        'transition-all duration-300'
      )}
    >
      {/* 展开的流量面板 */}
      {expanded && (
        <div
          className={cn(
            'glass-card flex w-64 flex-col overflow-hidden p-3',
            'zen-modal-content-enter'
          )}
        >
          {/* 标题栏 */}
          <div className="mb-2 flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
            >
              <Activity className="h-4 w-4" />
            </div>
            <div className="flex flex-1 flex-col">
              <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
                流量统计
              </span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                本次会话 · HTTP
              </span>
            </div>
            <button
              onClick={() => setExpanded(false)}
              className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>

          {/* 本机流量 */}
          {rows.map((row) => (
            <div
              key={row.label}
              className="mb-1.5 flex items-center gap-2 rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5"
            >
              <div
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded-full',
                  row.down
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
                )}
              >
                {row.down ? (
                  <ArrowDown className="h-3.5 w-3.5" />
                ) : (
                  <ArrowUp className="h-3.5 w-3.5" />
                )}
              </div>
              <div className="flex flex-1 flex-col">
                <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  {row.label}
                </span>
                <span className="text-sm font-medium tabular-nums text-[var(--md-sys-color-on-surface)]">
                  {formatBytes(row.total)}
                </span>
              </div>
              <span className="text-xs font-medium tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                {formatSpeed(row.speed)}
              </span>
            </div>
          ))}

          {/* 服务端流量（仅 root） */}
          {isRoot && (
            <>
              <div className="my-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                <Server className="h-3 w-3" />
                服务端网卡
              </div>
              {serverAvailable && server ? (
                <>
                  {(
                    [
                      { label: '下载', bytes: server.rxBytes, speed: server.rxSpeed, down: true },
                      { label: '上传', bytes: server.txBytes, speed: server.txSpeed, down: false },
                    ] as const
                  ).map((row) => (
                    <div
                      key={row.label}
                      className="mb-1.5 flex items-center gap-2 rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5"
                    >
                      <div
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded-full',
                          row.down
                            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                            : 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
                        )}
                      >
                        {row.down ? (
                          <ArrowDown className="h-3.5 w-3.5" />
                        ) : (
                          <ArrowUp className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="flex flex-1 flex-col">
                        <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                          服务端{row.label}
                        </span>
                        <span className="text-sm font-medium tabular-nums text-[var(--md-sys-color-on-surface)]">
                          {formatBytes(row.bytes)}
                        </span>
                      </div>
                      <span className="text-xs font-medium tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                        {formatSpeed(row.speed)}
                      </span>
                    </div>
                  ))}
                  <div className="text-center text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                    系统开机以来的全部网卡流量
                  </div>
                </>
              ) : (
                <div className="rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  当前平台不支持服务端流量统计
                </div>
              )}
            </>
          )}

          <div className="mt-1 text-center text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            统计本次会话的 HTTP 流量（不含 WebSocket）
          </div>
        </div>
      )}

      {/* 悬浮触发按钮 */}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          className={cn(
            'glass-card flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200',
            'hover:scale-105 hover:shadow-xl active:scale-95'
          )}
          style={{
            backgroundColor: 'var(--glass-bg)',
            color: 'var(--md-sys-color-on-surface)',
          }}
          title="流量统计"
        >
          <Activity className="h-5 w-5" />
        </button>
      )}
    </div>,
    document.body
  )
}
