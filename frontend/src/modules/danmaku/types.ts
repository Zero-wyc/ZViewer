/** 弹幕源类型（移除了 bilibili_bangumi） */
export type DanmakuSource = 'bilibili' | 'bahamut' | 'dandanplay'

/** 弹幕条目（统一格式，所有源共用） */
export interface DanmakuItem {
  id: string
  content: string
  time: number
  mode: number
  color: number
  size: number
}

/** 弹幕轨道 */
export interface DanmakuTrack {
  trackId: string
  label: string
  source: DanmakuSource
  items: DanmakuItem[]
  offset: number
}

/** 搜索结果统计数据（播放量/点赞/投币等） */
export interface DanmakuSearchStats {
  play?: number
  danmaku?: number
  favorites?: number
  like?: number
  coin?: number
  reply?: number
}

/** 搜索结果 */
export interface DanmakuSearchResult {
  identifier: string
  title: string
  description?: string
  cover?: string
  stats?: DanmakuSearchStats
  /** 源特定附加数据（如 B站 bvid/aid） */
  extra?: Record<string, unknown>
}

/** 集数信息 */
export interface DanmakuEpisode {
  id: string
  title: string
  episodeNumber: number
  /**
   * 源特定回放参数（如弹弹play 的 animeId/episodeId）。
   * 由 getDanmakuEpisodes 返回，fetchDanmaku 时原样回传给后端，
   * 后端 provider 据此调用对应接口。
   * 前端不解读此字段内容，仅做透传。
   */
  playbackParams: Record<string, unknown>
}

/** 弹幕源选项 */
export const DANMAKU_SOURCE_OPTIONS: Array<{
  label: string
  value: DanmakuSource
}> = [
  { label: '哔哩哔哩', value: 'bilibili' },
  { label: '巴哈姆特', value: 'bahamut' },
  { label: '弹弹play', value: 'dandanplay' },
]
