/** 弹幕搜索结果统计数据（播放量、点赞、投币等） */
export interface DanmakuSearchStats {
  /** 播放量 */
  play?: number;
  /** 弹幕数 */
  danmaku?: number;
  /** 收藏数 */
  favorites?: number;
  /** 点赞数 */
  like?: number;
  /** 投币数 */
  coin?: number;
  /** 评论数 */
  reply?: number;
}

export interface DanmakuSearchResult {
  id: string;
  title: string;
  cover?: string;
  description?: string;
  source: string;
  /** 视频统计数据（B站搜索结果可用） */
  stats?: DanmakuSearchStats;
  extra?: Record<string, unknown>;
}

export interface DanmakuEpisode {
  id: string;
  title: string;
  episodeNumber: number;
  playbackParams: Record<string, unknown>;
}

export interface DanmakuItem {
  id: string;
  content: string;
  time: number;
  mode: number;
  color: number;
  size?: number;
}

/**
 * Provider 调用上下文，由路由层注入。
 * 不同源按需使用其中的字段，未使用的源可忽略。
 */
export interface DanmakuProviderContext {
  /** B站登录 Cookie（来自用户扫码登录），用于搜索/WBI 签名等需登录态的接口 */
  cookie?: string;
}

export interface DanmakuSourceProvider {
  name: string;
  search(keyword: string, ctx?: DanmakuProviderContext): Promise<DanmakuSearchResult[]>;
  getEpisodes(identifier: string, ctx?: DanmakuProviderContext): Promise<DanmakuEpisode[]>;
  getDanmaku(episode: DanmakuEpisode, ctx?: DanmakuProviderContext): Promise<DanmakuItem[]>;
}
