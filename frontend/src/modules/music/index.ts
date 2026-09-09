/**
 * 一起听（Listen Together）模块公共 API
 *
 * 模块结构：
 * ```
 * music/
 * ├── types.ts                    共享类型（歌曲/队列/同步状态/登录态/页面数据）
 * ├── store.ts                    zustand store（队列/currentKey/播放状态镜像/UI 状态）
 * ├── index.ts                    本文件：公共 API 入口
 * ├── MusicPlayerContext.tsx      播放器 Context Provider（面板间共享 useListenTogether 实例）
 * ├── utils/
 * │   └── lrc.ts                  LRC 歌词解析（原文 + 翻译合并）
 * ├── hooks/
 * │   ├── useListenTogether.ts    播放引擎 + 房主/观众同步（心跳/申请制/房主离线判定）
 * │   ├── useNcmLogin.ts          网易云扫码登录（key/create/check 轮询状态机）
 * │   ├── useMusicPlayer.ts       播放器 Context 消费 Hook（含 context 定义）
 * │   └── useQueueAdd.ts          添加到队列共享逻辑（queue-upsert + 已添加态）
 * ├── pages/
 * │   ├── MusicHomePage.tsx       首页（Banner + 每日推荐 + 最新音乐 + 推荐区块）
 * │   ├── MusicSearchPage.tsx     搜索页（cloudsearch + SongRow 列表）
 * │   ├── MusicDailyPage.tsx      每日推荐（需登录）
 * │   ├── MusicFmPage.tsx         私人漫游（Hydrogen PersonalFM 范式）
 * │   ├── MusicMyPage.tsx         我的音乐（左侧栏 + 详情视图）
 * │   ├── MusicCloudPage.tsx      云盘（simpleSong → SongRow）
 * │   └── MusicLoginGate.tsx      登录提示卡 + 页面区块头
 * └── components/
 *     ├── MusicAppShell.tsx       主区域根（顶导航 + 内容页 + 底部 widget + 队列弹窗）
 *     ├── MusicTopNav.tsx         顶部导航（搜索框 + 页面链接 + 账户菜单）
 *     ├── MusicWidgetBar.tsx      底部播放控制栏（Hydrogen MusicWidget 范式）
 *     ├── MusicQueuePopup.tsx     队列弹窗（Hydrogen PlayList 范式）
 *     ├── MusicQrLoginModal.tsx   网易云扫码登录弹窗
 *     ├── ListenTogetherPanel.tsx 完整播放器覆盖层（Hydrogen 播放卡 + 歌词面板）
 *     ├── SongRow.tsx           歌曲列表行共享组件（Hydrogen 裸列表行 + EQ 动画）
 *     └── MusicBetaNotice.tsx   Beta 未开启降级提示页
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
  NcmBannerItem,
  NcmPlaylistCard,
  NcmArtistCard,
  NcmAlbumCard,
  NcmToplistCard,
  NcmNewSongCard,
} from './types'

// Store
export { useMusicStore, musicItemKey, parseMusicKey } from './store'
export type { MusicState, MusicPage } from './store'

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

export { useQueueAdd, songToUpsertItem } from './hooks/useQueueAdd'
export type { UseQueueAddResult, QueueUpsertItem } from './hooks/useQueueAdd'

// UI 组件
export { MusicAppShell } from './components/MusicAppShell'
export type { MusicAppShellProps } from './components/MusicAppShell'
export { ListenTogetherPanel } from './components/ListenTogetherPanel'
export type { ListenTogetherPanelProps } from './components/ListenTogetherPanel'
export { MusicBetaNotice } from './components/MusicBetaNotice'
export { SongRow, EqBars } from './components/SongRow'
export type { SongRowProps } from './components/SongRow'

// 工具
export { mergeLyrics } from './utils/lrc'
export type { LyricLine } from './utils/lrc'
