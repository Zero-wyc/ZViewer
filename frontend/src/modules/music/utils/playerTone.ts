/**
 * 播放页 UI 深浅色的「数据层」：持久化 key、偏好读取与容器级 CSS 变量
 * 映射三组（工具栏 / 播放卡 / 歌词面板）+ 卡底 tint。
 *
 * 从 ListenTogetherPanel 抽出（2026-09-24 架构拆分第一步，纯搬迁无行为
 * 变更）：原先这些常量与歌词播放页主组件同文件（近 4000 行），抽出后
 * 便于后续 view 层拆分共享同一份色板定义。此处仅放数据，不含状态——
 * uiTone 的 state / toggle 见 hooks/usePlayerUiTone.ts。
 *
 * 注意两组 light 的语义相反：TOOLBAR_TONE_VARS.light = 工具栏浅色外观
 * （白图标，与主题同侧），CARD_TONE_VARS.light = 浅色 UI（亮玻璃配深字）。
 */
import type { CSSProperties } from 'react'

/** 播放页 UI 深浅色取值：light = 浅色 UI（亮玻璃配深色文字）；
 *  dark = 深色 UI（暗玻璃配浅色文字） */
export type PlayerUiTone = 'light' | 'dark'

/** 播放页 UI 深浅色持久化 key（light = 浅色 UI：亮玻璃配深色文字；
 *  dark = 深色 UI：暗玻璃配浅色文字）。旧 key zviewer-lyric-toolbar-tone
 *  语义是「工具栏文字深浅」且取值相反（light = 白字），仅作用于工具栏，
 *  已废弃不迁移 */
export const PLAYER_UI_TONE_STORAGE_KEY = 'zviewer-player-ui-tone'

/** 读取播放页 UI 深浅色偏好；存储损坏/非法值时回退浅色（= 播放卡既定
 *  「恒黑字白底」观感，迁移成本最低的初始态） */
export function loadPlayerUiTone(): PlayerUiTone {
  try {
    if (localStorage.getItem(PLAYER_UI_TONE_STORAGE_KEY) === '"dark"') {
      return 'dark'
    }
  } catch {
    // ignore（隐私模式等存储不可用场景）
  }
  return 'light'
}

/** 播放页 UI 深浅色的三组容器级变量覆盖（全部按 UI 深浅色键控，随开关
 *  整体翻转；原按背景下亮度逐元素采样的自适应已删除——跨域视频源画入
 *  canvas 会永久污染采样画布，clearRect 无法解除，实际不可用——改为用户
 *  手动切换、容器统一覆盖并持久化）：
 *  - TOOLBAR：song-control / 竖屏工具行容器文字三色（on-surface /
 *    on-surface-variant 供全部按钮 var() 引用，--lt-tone-inverse 供评论数
 *    徽章文字）
 *  - CARD：播放卡容器文字与卡内 surface 派生色。文字恒与卡底 tint 同源
 *    （浅色 UI = 纯黑字配亮玻璃，深色 UI = 纯白字配暗玻璃，on-surface 与
 *    -variant 同值），确保任何卡底上对比度确定——「灰字」失配的根因就是
 *    文字色与背板色各自分支（见卡容器处注释）
 *  - LYRIC_PANEL：歌词面板容器（PlayerLyricPanel 全令牌化零改动）。
 *    on-surface 供歌词/高亮条/描边，surface 供面板底 color-mix 45% 透明
 *    底色与高亮条上的反色文字 */
/** 工具栏色调映射：**按工具栏自身的深浅语义命名**（light = 工具栏呈浅色
 *  ——白色图标；dark = 工具栏呈深色——深色图标），与 UI 开关/主题的
 *  「浅色模式」是同一侧语义（浅色模式 → 工具栏浅色），不做反色。
 *  on-surface / on-surface-variant 供全部按钮 var() 引用，
 *  --lt-tone-inverse 供评论数徽章文字 */
export const TOOLBAR_TONE_VARS = {
  light: {
    '--md-sys-color-on-surface': '#ffffff',
    '--md-sys-color-on-surface-variant': 'rgba(255, 255, 255, 0.5)',
    '--lt-tone-inverse': '#1c1c1c',
  },
  dark: {
    '--md-sys-color-on-surface': '#1c1c1c',
    '--md-sys-color-on-surface-variant': 'rgba(0, 0, 0, 0.5)',
    '--lt-tone-inverse': '#ffffff',
  },
} as Record<PlayerUiTone, CSSProperties>

/** 播放卡容器变量覆盖：**按 UI 开关语义**（light = 浅色 UI：亮玻璃配深色
 *  文字；dark = 深色 UI：暗玻璃配浅色文字）。light 组 = 改版前「恒黑字
 *  白底」定稿值 */
export const CARD_TONE_VARS = {
  light: {
    '--md-sys-color-on-surface': '#000000',
    '--md-sys-color-on-surface-variant': '#000000',
    '--md-sys-color-surface-container-high': 'rgba(255, 255, 255, 0.6)',
  },
  dark: {
    '--md-sys-color-on-surface': '#ffffff',
    '--md-sys-color-on-surface-variant': '#ffffff',
    '--md-sys-color-surface-container-high': 'rgba(255, 255, 255, 0.12)',
  },
} as Record<PlayerUiTone, CSSProperties>

/** 歌词面板容器变量覆盖（语义见 TOOLBAR_TONE_VARS 注释） */
export const LYRIC_PANEL_TONE_VARS = {
  light: {
    '--md-sys-color-on-surface': '#1c1c1c',
    '--md-sys-color-surface': '#ffffff',
  },
  dark: {
    '--md-sys-color-on-surface': '#ffffff',
    '--md-sys-color-surface': '#141418',
  },
} as Record<PlayerUiTone, CSSProperties>

/** 播放卡 tint 颜色（浅色 UI = 亮白玻璃 / 深色 UI = 暗黑玻璃；竖屏 alpha
 *  略高——卡面小，需更实的底托住文字对比度） */
export const CARD_TINT = {
  light: {
    portrait: 'rgba(255, 255, 255, 0.55)',
    desktop: 'rgba(255, 255, 255, 0.45)',
  },
  dark: {
    portrait: 'rgba(0, 0, 0, 0.55)',
    desktop: 'rgba(0, 0, 0, 0.45)',
  },
} as Record<PlayerUiTone, { portrait: string; desktop: string }>
