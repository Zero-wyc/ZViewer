/**
 * 一起听（Listen Together）模块公共 API
 *
 * 模块结构：
 * ```
 * music/
 * ├── types.ts                    共享类型（歌曲/队列/同步状态/登录态）
 * ├── store.ts                    zustand store（队列/当前曲目/播放状态镜像）
 * ├── index.ts                    本文件：公共 API 入口
 * ├── MusicPlayerContext.tsx      播放器 Context Provider（面板间共享 useListenTogether 实例）
 * ├── utils/
 * │   └── lrc.ts                  LRC 歌词解析（原文 + 翻译合并）
 * ├── hooks/
 * │   ├── useListenTogether.ts    播放引擎 + 房主/观众同步（心跳/申请制/房主离线判定）
 * │   ├── useNcmLogin.ts          网易云扫码登录（key/create/check 轮询状态机）
 * │   └── useMusicPlayer.ts       播放器 Context 消费 Hook（含 context 定义）
 * └── components/
 *     ├── ListenTogetherPanel.tsx 主区域播放器（封面/歌词/控制条）
 *     ├── MusicSearchPanel.tsx   歌曲搜索 + 队列添加 + 网易云登录
 *     └── MusicQueuePanel.tsx    播放队列（切歌/删除/排序）
 * ```
 */

// 类型
export type {
  NcmSong,
  MusicQueueItem,
  PlayMode,
  MusicSyncState,
  MusicControlRequest,
  MusicControlResponse,
  NcmLoginStatus,
} from './types'

// Store
export { useMusicStore } from './store'
export type { MusicState } from './store'

// Context（播放器面板间共享实例）
export { MusicPlayerProvider } from './MusicPlayerContext'
export type { MusicPlayerProviderProps } from './MusicPlayerContext'
export { useMusicPlayer, MusicPlayerContext } from './hooks/useMusicPlayer'
export type { MusicPlayerContextValue } from './hooks/useMusicPlayer'

// Hooks
export { useListenTogether } from './hooks/useListenTogether'
export type {
  UseListenTogetherOptions,
  UseListenTogetherResult,
} from './hooks/useListenTogether'

export { useNcmLogin } from './hooks/useNcmLogin'
export type { NcmQrStatus, UseNcmLoginResult } from './hooks/useNcmLogin'

// UI 组件
export { ListenTogetherPanel } from './components/ListenTogetherPanel'
export type { ListenTogetherPanelProps } from './components/ListenTogetherPanel'
export { MusicBetaNotice } from './components/ListenTogetherPanel'
export { MusicSearchPanel } from './components/MusicSearchPanel'
export type { MusicSearchPanelProps } from './components/MusicSearchPanel'
export { MusicQueuePanel } from './components/MusicQueuePanel'
export type { MusicQueuePanelProps } from './components/MusicQueuePanel'

// 工具
export { mergeLyrics } from './utils/lrc'
export type { LyricLine } from './utils/lrc'
