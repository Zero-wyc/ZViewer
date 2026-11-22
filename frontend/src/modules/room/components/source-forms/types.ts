/** 添加影片面板支持的来源类型（表单侧与面板侧共用） */
export type SourceType =
  | 'bilibili'
  | 'mp4'
  | 'webdav'
  | 'ftp'
  | 'openlist'
  | 'emby'
  | 'jellyfin'
  | 'anime'
  | 'kazumi'
  | 'cms'
  // 「全网搜片」分组里的本地规则库（搜索在弹窗里完成，不走来源表单）
  | 'crawler'
  | 'server-files'
