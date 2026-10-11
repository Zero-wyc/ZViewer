/**
 * 顶栏公告按钮 + 公告二级窗口。
 *
 * - 公告内容拉取 GitHub 仓库根目录 announce.md（raw 直连，失败回退
 *   master 分支与 CDN 代理前缀）。
 * - 点击图标打开公告窗口（Modal 居中二级窗口，非顶栏下拉面板）。
 * - 自动弹出：
 *   1. 首次启动（本地无已读版本记录）→ 强制弹出一次；
 *   2. 版本更新（public-settings 下发的 appVersion 与本地记录不同）→
 *      弹出，受管理员基础设置 announceAutoPopupOnUpdate 开关控制。
 *   关闭窗口时写入当前版本号作为已读记录（localStorage）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Megaphone, ExternalLink, Loader2 } from 'lucide-react'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

/** 已读记录 localStorage key（值为上次已读的 appVersion） */
const SEEN_VERSION_KEY = 'zviewer-announce-seen-version'

/**
 * 拉取公告 markdown：raw(main) → raw(master) → CDN 代理（开启加速时）。
 * 全部失败返回 null。
 */
async function fetchAnnouncement(
  cdnAccelerate: boolean,
  cdnProxyUrl: string
): Promise<string | null> {
  const paths = ['/main/announce.md', '/master/announce.md']
  const bases: string[] = ['https://raw.githubusercontent.com/Zero-wyc/ZViewer']
  if (cdnAccelerate && cdnProxyUrl) {
    bases.push(
      `${cdnProxyUrl.replace(/\/+$/, '')}/https://raw.githubusercontent.com/Zero-wyc/ZViewer`
    )
  }
  for (const base of bases) {
    for (const p of paths) {
      try {
        const res = await fetch(`${base}${p}`, { cache: 'no-store' })
        if (!res.ok) continue
        const text = await res.text()
        if (text.trim()) return text
      } catch {
        // 逐个候选源静默重试
      }
    }
  }
  return null
}

/** 极简 markdown 渲染：标题/无序有序列表/引用/粗体/行内代码/链接 */
function renderMarkdownLine(line: string, key: number) {
  const inline = (text: string) => {
    // 顺序：行内代码 → 链接 → 粗体
    const parts: React.ReactNode[] = []
    const re =
      /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(https?:\/\/[^\s)]+)/g
    let last = 0
    let m: RegExpExecArray | null
    let i = 0
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(text.slice(last, m.index))
      const token = m[0]
      if (token.startsWith('`')) {
        parts.push(
          <code
            key={`${key}-c${i}`}
            className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 text-[11px]"
          >
            {token.slice(1, -1)}
          </code>
        )
      } else if (token.startsWith('[')) {
        const label = token.slice(1, token.indexOf(']'))
        const href = token.slice(token.indexOf('(') + 1, -1)
        parts.push(
          <a
            key={`${key}-a${i}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--md-sys-color-primary)] underline underline-offset-2"
          >
            {label}
          </a>
        )
      } else if (token.startsWith('**')) {
        parts.push(<strong key={`${key}-b${i}`}>{token.slice(2, -2)}</strong>)
      } else {
        parts.push(
          <a
            key={`${key}-u${i}`}
            href={token}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-[var(--md-sys-color-primary)] underline underline-offset-2"
          >
            {token}
          </a>
        )
      }
      last = m.index + token.length
      i++
    }
    if (last < text.length) parts.push(text.slice(last))
    return parts
  }

  const t = line.trim()
  if (!t) return <div key={key} className="h-1.5" />
  if (t.startsWith('# ')) {
    return (
      <p
        key={key}
        className="text-sm font-bold text-[var(--md-sys-color-on-surface)]"
      >
        {inline(t.slice(2))}
      </p>
    )
  }
  if (t.startsWith('## ')) {
    return (
      <p
        key={key}
        className="text-[13px] font-semibold text-[var(--md-sys-color-on-surface)]"
      >
        {inline(t.slice(3))}
      </p>
    )
  }
  if (t.startsWith('### ')) {
    return (
      <p
        key={key}
        className="text-xs font-semibold text-[var(--md-sys-color-on-surface)]"
      >
        {inline(t.slice(4))}
      </p>
    )
  }
  if (t.startsWith('> ')) {
    return (
      <blockquote
        key={key}
        className="border-l-2 border-[var(--md-sys-color-outline)] pl-2 text-xs text-[var(--md-sys-color-on-surface-variant)]"
      >
        {inline(t.slice(2))}
      </blockquote>
    )
  }
  if (/^[-*] /.test(t)) {
    return (
      <p
        key={key}
        className="flex gap-1.5 text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]"
      >
        <span className="text-[var(--md-sys-color-primary)]">•</span>
        <span>{inline(t.slice(2))}</span>
      </p>
    )
  }
  const ol = /^(\d+)[.、] /.exec(t)
  if (ol) {
    return (
      <p
        key={key}
        className="flex gap-1.5 text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]"
      >
        <span className="font-medium text-[var(--md-sys-color-primary)]">
          {ol[1]}.
        </span>
        <span>{inline(t.slice(ol[0].length))}</span>
      </p>
    )
  }
  return (
    <p
      key={key}
      className="text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]"
    >
      {inline(t)}
    </p>
  )
}

interface AnnouncementButtonProps {
  /** 窗口开闭回调（顶栏沉浸模式据此锁定显隐） */
  onOpenChange?: (open: boolean) => void
}

export function AnnouncementButton({ onOpenChange }: AnnouncementButtonProps) {
  const {
    announceAutoPopupOnUpdate,
    appVersion,
    cdnAccelerate,
    cdnProxyUrl,
    fetched,
  } = useSystemSettingsStore()
  const [open, setOpen] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  /** 本地记录版本 ≠ 当前版本（含无记录）→ 图标显示红点 */
  const [unseen, setUnseen] = useState(false)

  const loadAnnouncement = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    const text = await fetchAnnouncement(cdnAccelerate, cdnProxyUrl)
    if (text) setContent(text)
    else setFailed(true)
    setLoading(false)
  }, [cdnAccelerate, cdnProxyUrl])

  const openWindow = useCallback(() => {
    setOpen(true)
    onOpenChange?.(true)
    if (!content && !loading) void loadAnnouncement()
  }, [content, loading, loadAnnouncement, onOpenChange])

  const closeWindow = useCallback(() => {
    setOpen(false)
    onOpenChange?.(false)
    // 关闭即写已读记录（当前版本），红点随之熄灭
    if (appVersion) {
      try {
        localStorage.setItem(SEEN_VERSION_KEY, appVersion)
      } catch {
        // localStorage 不可用时忽略，下次仍会弹出
      }
    }
    setUnseen(false)
  }, [appVersion, onOpenChange])

  // 自动弹出判定：等 public-settings 就绪（拿到 appVersion 与开关）后执行一次
  const decidedRef = useRef(false)
  useEffect(() => {
    if (!fetched || decidedRef.current) return
    decidedRef.current = true
    let seen: string | null
    try {
      seen = localStorage.getItem(SEEN_VERSION_KEY)
    } catch {
      seen = null
    }
    const isFirstLaunch = seen == null
    const isVersionUpdate = seen != null && appVersion && seen !== appVersion
    if (isFirstLaunch || (isVersionUpdate && announceAutoPopupOnUpdate)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 自动弹出公告属挂载期一次性决策，非派生状态
      openWindow()
    }

    setUnseen(Boolean(appVersion) && (isFirstLaunch || isVersionUpdate))
  }, [fetched, appVersion, announceAutoPopupOnUpdate, openWindow])

  return (
    <>
      <button
        type="button"
        onClick={() => (open ? closeWindow() : openWindow())}
        className={cn(
          'relative p-2 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
          open
            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
            : 'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
        )}
        style={{
          border: '1px solid var(--md-sys-color-outline)',
        }}
        title="公告"
      >
        <Megaphone className="w-4 h-4" />
        {unseen && !open && (
          <span
            className="absolute right-1 top-1 h-2 w-2 rounded-full border border-[var(--md-sys-color-surface)]"
            style={{ backgroundColor: 'var(--md-sys-color-error)' }}
          />
        )}
      </button>

      <Modal
        open={open}
        onClose={closeWindow}
        title="公告"
        className="max-w-lg"
        footer={
          <div className="flex w-full items-center justify-between gap-2">
            <a
              href="https://github.com/Zero-wyc/ZViewer/blob/main/announce.md"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:text-[var(--md-sys-color-primary)]"
            >
              <ExternalLink className="h-3.5 w-3.5" />在 GitHub 查看原始公告
            </a>
            <Button variant="secondary" size="sm" onClick={closeWindow}>
              关闭
            </Button>
          </div>
        }
      >
        <div
          className="max-h-[60vh] min-h-[120px] overflow-y-auto rounded-[var(--md-sys-shape-corner)] border p-4"
          style={{
            borderColor: 'var(--md-sys-color-outline-variant)',
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-surface-container) 55%, transparent)',
          }}
        >
          {loading ? (
            <div className="flex h-24 items-center justify-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在拉取公告…
            </div>
          ) : failed || content == null ? (
            <div className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              <span>公告拉取失败</span>
              <button
                type="button"
                className="text-[var(--md-sys-color-primary)] underline underline-offset-2"
                onClick={() => void loadAnnouncement()}
              >
                重试
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {content
                .split(/\r?\n/)
                .map((line, i) => renderMarkdownLine(line, i))}
            </div>
          )}
        </div>
      </Modal>
    </>
  )
}
