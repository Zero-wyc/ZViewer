/**
 * 前端多语言入口。
 *
 * 设计约定（2026-10-31）：
 * 1. **key 就是中文原文**，例如 `t('加入语音')`。好处是代码里直接能读出文案，
 *    不用回项目录查 key；缺译文时 i18next 找不到就原样返回 key（中文），
 *    所以任何漏翻的地方只会显示中文，不会露出 `room.voice.join` 这种占位符。
 * 2. 词条统一放在 `./locales/zh-CN.ts`（中文清单）与 `./locales/en-US.ts`（译文），
 *    中文那份由 `node scripts/i18n-extract.mjs --write` 生成，不要手改。
 * 3. 取词统一用这里导出的 `t()`：组件、hook、工具函数都能直接调用，不需要
 *    `useTranslation()`。语言切换时由 `App` 顶层的订阅触发整棵树重渲染，
 *    因此不要在模块顶层把 `t()` 的结果存成常量（那份值会停在初始语言）。
 */
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

/** 支持的语言。新增语言时：加词典文件 → 加进 LANGUAGES → 在 resources 里登记。 */
export type Language = 'zh-CN' | 'en-US'

export const DEFAULT_LANGUAGE: Language = 'zh-CN'

/** 语言选择器的选项（label 用各语言自己的写法，切到英文后仍然认得出） */
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' },
]

const STORAGE_KEY = 'zviewer-language'

export function isLanguage(value: unknown): value is Language {
  return value === 'zh-CN' || value === 'en-US'
}

/** 读取上次选择的语言；没有或非法时返回 null（交给 detectLanguage 兜底） */
export function readStoredLanguage(): Language | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return isLanguage(value) ? value : null
  } catch {
    return null
  }
}

/** 记住用户选择（localStorage 不可用时静默跳过，不影响使用） */
export function storeLanguage(language: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    /* 隐私模式 / 存储被禁用 */
  }
}

/**
 * 决定首次进入的语言：上次选择 → 浏览器语言 → 简体中文。
 *
 * 浏览器是英文环境时给 en-US，其余一律中文——目前只有这两套词条，
 * 其他语种回落到中文比回落到英文更贴近原产品。
 */
export function detectLanguage(): Language {
  const stored = readStoredLanguage()
  if (stored) return stored
  const navigatorLanguage =
    typeof navigator === 'undefined' ? '' : navigator.language || ''
  return navigatorLanguage.toLowerCase().startsWith('en')
    ? 'en-US'
    : DEFAULT_LANGUAGE
}

/**
 * 给含 `{{count}}` 的词条补上复数形式。
 *
 * i18next 一看到插值参数里有 `count` 就走复数查找（`<key>_one` / `<key>_other`），
 * 找不到就整条回退成 key（中文原文），英文界面会突然冒出中文。我们的词条是
 * 「中文原文 → 译文」的扁平表，没有分复数，这里按语言规则把三种形式都指到同一条。
 * 英文单复数默认不完美（"1 items"）：需要区分的条目可以在 `en-US.ts` 里
 * 单独写一条 `<key>_one`，这里不会覆盖已有的形式。
 */
function withPlurals(dict: Record<string, string>): Record<string, string> {
  const filled = { ...dict }
  for (const [key, value] of Object.entries(dict)) {
    if (!key.includes('{{count}}')) continue
    // overrides.json 里已经写好的单复数形式本身也含 {{count}}，别再套一层
    if (key.endsWith('_one') || key.endsWith('_other')) continue
    if (!(`${key}_one` in filled)) filled[`${key}_one`] = value
    if (!(`${key}_other` in filled)) filled[`${key}_other`] = value
  }
  return filled
}

void i18next.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: withPlurals(zhCN) },
    'en-US': { translation: withPlurals(enUS) },
  },
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  // 词典是扁平的「中文原文 → 译文」表，key 里出现 . 或 : 也只是普通字符
  keySeparator: false,
  nsSeparator: false,
  // 必须同步完成：模块顶层就有 t() 调用（常量表等），异步初始化会返回 key 占位
  initAsync: false,
  interpolation: {
    // React 自己会转义，再转一次会把 & < > 变成实体
    escapeValue: false,
  },
  returnNull: false,
})

/**
 * 取词。key 是中文原文，vars 用于插值（`t('已复制 {{count}} 项', { count })`）。
 *
 * 没找到译文时返回 key 本身，也就是中文原文。
 */
export function t(key: string, vars?: Record<string, unknown>): string {
  return i18next.t(key, vars) as unknown as string
}

export { i18next }
export default i18next
