import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ScrollText, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { CopyButton } from '@/components/ui/CopyButton'
import { Text } from '@/components/ui/Typography'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'
import type {
  ConnectionLogEntry,
  ConnectionLogLevel,
} from '@/modules/piik-share/connection-log'

/** 级别只用于配色与复制时的标签，不翻译：贴给开发者看时英文更省事。 */
const LEVEL_DOT: Record<ConnectionLogLevel, string> = {
  info: 'bg-[var(--md-sys-color-outline)]',
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
}

const LEVEL_LABEL: Record<ConnectionLogLevel, string> = {
  info: 'INFO',
  ok: 'OK',
  warn: 'WARN',
  error: 'ERROR',
}

/** 毫秒也要显示：候选是成批到达的，只到秒看不出先后。 */
function formatClock(at: number): string {
  const date = new Date(at)
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}.${pad(date.getMilliseconds(), 3)}`
}

export interface ConnectionLogPanelProps {
  entries: ConnectionLogEntry[]
  /** 清空本地记录；不传则不显示清空按钮。 */
  onClear?: () => void
}

/**
 * P2P 连接日志。
 *
 * 观众的共享出问题时只有两种描述：「一直转圈」和「黑屏」。这里把候选收集、
 * STUN 可达性、最终选中的地址对按时间列出来，能直接分清是没拿到公网候选
 * （STUN 被墙/端口没放通）还是打洞被 NAT 挡住（有 srflx 但选不中）。
 */
export function ConnectionLogPanel({
  entries,
  onClear,
}: ConnectionLogPanelProps) {
  const [open, setOpen] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  /** 用户手动往上翻时不要把他拽回底部。 */
  const pinnedRef = useRef(true)

  useEffect(() => {
    const element = listRef.current
    if (!element || !pinnedRef.current) return
    element.scrollTop = element.scrollHeight
  }, [entries.length, open])

  const handleScroll = () => {
    const element = listRef.current
    if (!element) return
    pinnedRef.current =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 8
  }

  const copyText = entries
    .map((entry) => {
      const line = `${formatClock(entry.at)} [${LEVEL_LABEL[entry.level]}] ${t(
        entry.message,
        entry.vars
      )}`
      return entry.detail ? `${line}  (${entry.detail})` : line
    })
    .join('\n')

  return (
    <div
      className="flex flex-col gap-2 border-t pt-3"
      style={{ borderColor: 'var(--md-sys-color-outline-variant)' }}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={open}
        >
          <ScrollText className="h-3.5 w-3.5 flex-shrink-0" />
          <Text type="secondary" className="truncate text-xs">
            {t('P2P 连接日志')}
          </Text>
          {entries.length > 0 && (
            <Text
              type="secondary"
              className="flex-shrink-0 font-mono text-[10px] opacity-60"
            >
              {entries.length}
            </Text>
          )}
          <ChevronDown
            className={cn(
              'ml-auto h-3.5 w-3.5 flex-shrink-0 opacity-60 transition-transform duration-200',
              !open && '-rotate-90'
            )}
          />
        </button>
        {entries.length > 0 && (
          <>
            <CopyButton
              value={copyText}
              label={undefined}
              className="h-6 w-6 p-0"
              aria-label={t('复制连接日志')}
              title={t('复制连接日志')}
            />
            {onClear && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0"
                aria-label={t('清空连接日志')}
                title={t('清空连接日志')}
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={onClear}
              />
            )}
          </>
        )}
      </div>

      {open && (
        <>
          {entries.length === 0 ? (
            <Text
              type="secondary"
              className="block px-0.5 text-[10px] leading-tight opacity-70"
            >
              {t('建立连接后会在这里显示候选、打洞与中转的每一步')}
            </Text>
          ) : (
            <div
              ref={listRef}
              onScroll={handleScroll}
              className="flex max-h-[150px] flex-col gap-1 overflow-y-auto pr-1"
              // 滚到底时最上面那行必然被裁一半：顶部渐隐比露半截字干净，
              // 同时也暗示「上面还有更早的记录」。
              style={{
                maskImage:
                  'linear-gradient(to bottom, transparent 0, black 10px, black 100%)',
                WebkitMaskImage:
                  'linear-gradient(to bottom, transparent 0, black 10px, black 100%)',
              }}
            >
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-1.5 leading-snug"
                >
                  <span
                    className={cn(
                      'mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full',
                      LEVEL_DOT[entry.level]
                    )}
                  />
                  <span className="flex-shrink-0 font-mono text-[10px] tabular-nums opacity-60">
                    {formatClock(entry.at)}
                  </span>
                  <span className="min-w-0 break-words text-[10px]">
                    {t(entry.message, entry.vars)}
                    {entry.detail && (
                      <span className="ml-1 font-mono opacity-55">
                        {entry.detail}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ConnectionLogPanel
