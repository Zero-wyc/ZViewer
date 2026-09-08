/**
 * 一起听（Listen Together）模块公共 API
 *
 * 模块结构：
 * ```
 * music/
 * ├── types.ts                    共享类型（歌曲/队列/同步状态/登录态）
 * ├── store.ts                    zustand store（队列/当前曲目/播放状态镜像）
 * ├── index.ts                    本文件：公共 API 入口
 * └── hooks/
 *     ├── useListenTogether.ts    播放引擎 + 房主/观众同步（心跳/申请制/房主离线判定）
 *     └── useNcmLogin.ts          网易云扫码登录（key/create/check 轮询状态机）
 * ```
 *
 * UI 组件（ListenTogetherPanel / MusicSearchPanel / MusicQueuePanel）
 * 由 Task 5 实现，此处仅导出逻辑层。
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

// Hooks
export { useListenTogether } from './hooks/useListenTogether'
export type {
  UseListenTogetherOptions,
  UseListenTogetherResult,
} from './hooks/useListenTogether'

export { useNcmLogin } from './hooks/useNcmLogin'
export type { NcmQrStatus, UseNcmLoginResult } from './hooks/useNcmLogin'
