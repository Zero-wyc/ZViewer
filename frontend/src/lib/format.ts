import { i18next, t } from '@/i18n'
/**
 * 通用格式化工具（计数缩写）。
 * 时间/时长格式化见 lib/utils.ts 的 formatDuration / formatDurationMs。
 */

export interface FormatCountShortOptions {
  /** 无效输入（null/undefined/NaN/Infinity）时返回的占位文案，默认 '' */
  placeholder?: string
  /** true 时 0/负数也返回占位文案（对齐 B站列表旧行为：无数据不显示 0） */
  nonPositiveAsPlaceholder?: boolean
  /**
   * 'cn'（默认）：≥1e8 → x.x亿；≥1e4 → x.x万
   * 'letter'：≥1e4 → x.xw（修剪 .0 尾数，无亿档；对齐 B站评论区 w 缩写风格）
   */
  style?: 'cn' | 'letter'
}

const trimZero = (value: number) => value.toFixed(1).replace(/\.0$/, '')

/** B站/中文互联网风格短计数格式化（x.x万 / x.x亿 / x.xw） */
export function formatCountShort(
  n: number | null | undefined,
  opts: FormatCountShortOptions = {}
): string {
  const {
    placeholder = '',
    nonPositiveAsPlaceholder = false,
    style = 'cn',
  } = opts
  if (n == null || !Number.isFinite(n)) return placeholder
  if (nonPositiveAsPlaceholder && n <= 0) return placeholder
  // 英文按 K / M 缩写：中文的量级词（万 / 亿 / w）在英文界面没有意义，
  // 而且数值本身是「除以一万」后的数，套同一模板会得到错误的量级。
  if (i18next.language !== 'zh-CN') {
    if (n >= 1e6) return `${trimZero(n / 1e6)}M`
    if (n >= 1e3) return `${trimZero(n / 1e3)}K`
    return String(n)
  }
  if (style === 'letter') {
    if (n >= 10_000) {
      return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')}w`
    }
    return String(n)
  }
  if (n >= 1e8) return t('{{value}}亿', { value: (n / 1e8).toFixed(1) })
  if (n >= 1e4) return t('{{value}}万', { value: (n / 1e4).toFixed(1) })
  return String(n)
}
