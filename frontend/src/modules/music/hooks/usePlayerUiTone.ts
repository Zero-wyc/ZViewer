/**
 * 播放页 UI 深浅色（双子色调）。
 *
 * 同一个播放页里其实挂着两套互不相同的深浅语义，此前混在组件里极易写反：
 *
 * - **uiTone（手动开关，localStorage 持久化）**：作用于播放卡文字/卡底 tint
 *   与歌词面板底色文字。卡底是毛玻璃，采样内容亮度不定，文字色必须与卡底
 *   tint 同组切换，不能按主题分支，否则会出现浅字配亮底 / 黑字配暗底。
 *   变量名 TOOLBAR/CARD/LYRIC 三组映射见 utils/playerTone.ts。
 * - **toolbarTone（跟随主题，不可手动）**：song-control 工具栏悬出在播放卡
 *   之外的封面/视频背景上，可读性取决于页面整体亮度，故与主题同侧
 *   （深色模式 → 工具栏呈深色，浅色模式 → 工具栏呈浅色），不做反色。
 *
 * 切换只改变量值与 tint 背景色，绝不许给容器加 opacity/transform
 * （会成为 Backdrop Root 让后代冰霜层失效）。
 */
import { useCallback, useState } from 'react'
import { useThemeStore } from '@/store/themeStore'
import {
  PLAYER_UI_TONE_STORAGE_KEY,
  loadPlayerUiTone,
  type PlayerUiTone,
} from '../utils/playerTone'

export function usePlayerUiTone() {
  const [uiTone, setUiTone] = useState<PlayerUiTone>(loadPlayerUiTone)

  const toggleUiTone = useCallback(() => {
    setUiTone((prev) => {
      const next: PlayerUiTone = prev === 'light' ? 'dark' : 'light'
      try {
        localStorage.setItem(PLAYER_UI_TONE_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // ignore（隐私模式等存储不可用场景）
      }
      return next
    })
  }, [])

  /** 工具栏色调跟随主题：浅色模式 → 浅色工具栏（白图标），深色反之 */
  const isDark = useThemeStore((s) => s.isDark)
  const toolbarTone: PlayerUiTone = isDark ? 'dark' : 'light'

  return { uiTone, toggleUiTone, toolbarTone }
}
