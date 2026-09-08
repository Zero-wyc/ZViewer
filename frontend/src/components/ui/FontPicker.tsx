import { useCallback, useState } from 'react'
import { Check, Loader2, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'

/** 字体选项：value 为 CSS font-family 值（'' 表示默认） */
interface FontOption {
  label: string
  value: string
}

/** 内置常用字体（跨平台 web-safe + 中文常用） */
const BUILTIN_FONTS: FontOption[] = [
  { label: '默认', value: '' },
  { label: '微软雅黑', value: "'Microsoft YaHei', sans-serif" },
  { label: '黑体', value: "'SimHei', 'Heiti SC', sans-serif" },
  { label: '宋体', value: "'SimSun', 'Songti SC', serif" },
  { label: '楷体', value: "'KaiTi', 'Kaiti SC', serif" },
  { label: '仿宋', value: "'FangSong', 'Fangsong SC', serif" },
  { label: '苹方', value: "'PingFang SC', sans-serif" },
  {
    label: '思源黑体',
    value: "'Source Han Sans SC', 'Noto Sans SC', sans-serif",
  },
  { label: '思源宋体', value: "'Source Han Serif SC', 'Noto Serif SC', serif" },
  { label: 'Segoe UI', value: "'Segoe UI', sans-serif" },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: '无衬线', value: 'sans-serif' },
  { label: '衬线', value: 'serif' },
  { label: '等宽', value: 'monospace' },
]

const STORAGE_SYSTEM_KEY = 'zviewer:system-fonts'

/** queryLocalFonts() 类型（Chrome/Edge 103+，需用户授权） */
interface LocalFontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
}
declare global {
  interface Navigator {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
}

function loadSystemFontsCache(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_SYSTEM_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[]
    return Array.isArray(parsed)
      ? parsed.filter((f) => typeof f === 'string')
      : []
  } catch {
    return []
  }
}

export interface FontPickerPanelProps {
  /** 当前 CSS font-family 值（'' 表示默认） */
  value: string
  onChange: (value: string) => void
  className?: string
}

/**
 * 字体选择面板内容（供 AnimatedSidePanel 侧滑面板承载）。
 *
 * - 内置常用字体 + 浏览器枚举的系统字体（queryLocalFonts，结果持久化缓存）
 * - 每项用实际字体渲染预览
 */
export function FontPickerPanel({
  value,
  onChange,
  className,
}: FontPickerPanelProps) {
  const [systemFonts, setSystemFonts] = useState<string[]>(loadSystemFontsCache)
  const [loadingSystem, setLoadingSystem] = useState(false)

  const canQuerySystemFonts =
    typeof navigator !== 'undefined' && !!navigator.queryLocalFonts

  const loadSystemFonts = useCallback(async () => {
    if (!navigator.queryLocalFonts || loadingSystem) return
    setLoadingSystem(true)
    try {
      const fonts = await navigator.queryLocalFonts()
      const families = [
        ...new Set(fonts.map((f) => f.family).filter((f) => f && f.trim())),
      ].sort((a, b) => a.localeCompare(b))
      setSystemFonts(families)
      try {
        localStorage.setItem(STORAGE_SYSTEM_KEY, JSON.stringify(families))
      } catch {
        /* 缓存失败忽略 */
      }
    } catch (err) {
      // 权限拒绝或 API 异常：静默（按钮仍在，用户可重试）
      console.info('[FontPicker] 枚举系统字体失败：', err)
    } finally {
      setLoadingSystem(false)
    }
  }, [loadingSystem])

  const renderItem = (
    key: string,
    label: string,
    fontFamily: string,
    active: boolean
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(fontFamily)}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] px-2.5 py-1.5 text-left text-xs transition-all',
        active
          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
          : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
      )}
    >
      <span
        className="truncate"
        style={{ fontFamily: fontFamily || undefined }}
      >
        {label}
      </span>
      {active && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  )

  return (
    <div className={cn('flex flex-col', className)}>
      {/* 系统字体枚举入口 */}
      {canQuerySystemFonts && (
        <button
          type="button"
          title={
            systemFonts.length > 0
              ? '重新枚举系统字体'
              : '枚举本机已安装的全部字体（需浏览器授权）'
          }
          onClick={() => void loadSystemFonts()}
          disabled={loadingSystem}
          className="mb-1 flex items-center justify-center gap-1.5 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-secondary-container)] px-2 py-1 text-[11px] text-[var(--md-sys-color-on-secondary-container)] transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {loadingSystem ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Monitor className="h-3.5 w-3.5" />
          )}
          {systemFonts.length > 0
            ? `重新枚举（已缓存 ${systemFonts.length} 个）`
            : '枚举本机系统字体'}
        </button>
      )}

      {/* 字体列表（面板整体滚动） */}
      <div>
        {BUILTIN_FONTS.map((f) =>
          renderItem(f.value || 'default', f.label, f.value, f.value === value)
        )}
        {systemFonts.length > 0 && (
          <>
            <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
              系统字体
            </div>
            {systemFonts.map((family) =>
              renderItem(family, family, `"${family}"`, `"${family}"` === value)
            )}
          </>
        )}
      </div>
    </div>
  )
}
