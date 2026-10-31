import { create } from 'zustand'
import {
  detectLanguage,
  i18next,
  isLanguage,
  storeLanguage,
  type Language,
} from '@/i18n'

/**
 * 界面语言。
 *
 * 只影响本机界面文字（存 localStorage，不写服务端设置）——同一台服务器上
 * 不同用户各看各的语言更符合预期。
 *
 * 切换后 `App` 顶层订阅到变化会整棵树重渲染，所以不需要在每个组件里
 * 用 `useTranslation()`；`t()` 直接调用即可。
 */
interface LanguageState {
  language: Language
  setLanguage: (language: Language) => void
}

export const useLanguageStore = create<LanguageState>((set) => ({
  language: isLanguage(i18next.language) ? i18next.language : detectLanguage(),
  setLanguage: (language) => {
    storeLanguage(language)
    void i18next.changeLanguage(language)
    set({ language })
  },
}))
