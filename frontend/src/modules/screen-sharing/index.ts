// 投屏模块入口：导出共享/观看页，以及供房间页在下方卡片区复用的「共享设置」卡片
// hooks / types / constants / signalingApi 仅供模块内部使用，不对外导出
export { default as SharePage } from './components/SharePage'
export { default as WatchPage } from './components/WatchPage'
export { ShareSettingsPanel } from './components/ShareSettingsPanel'
