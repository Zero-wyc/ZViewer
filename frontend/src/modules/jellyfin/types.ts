/**
 * Jellyfin 挂载类型定义
 *
 * Jellyfin 是 Emby 开源分支，同为媒体库型（itemId 树形结构）。
 * 认证方式二选一：API Key 或 账号密码。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface JellyfinMount {
  id: number
  type: 'jellyfin'
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  embyUserId: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface JellyfinMountFormPayload {
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface JellyfinTestResult {
  success: boolean
  userId?: string
  userName?: string
  serverId?: string
}

export interface JellyfinDirectoryEntry {
  name: string
  path: string
  /** file = 可播放条目（电影/单集/剧集），directory = 可继续浏览（媒体库/季） */
  type: 'file' | 'directory'
  /** Jellyfin 条目类型（CollectionFolder/Series/Season/Movie/Episode/Video） */
  embyType?: string
  childCount?: number
  /** 刮削主海报 tag（ImageTags.Primary，海报墙用） */
  imageTag?: string
  /** 刮削年份 */
  productionYear?: number
  /** 单集序号（Episode：集号 E） */
  indexNumber?: number
  /** 父级序号（Episode：季号 S） */
  parentIndexNumber?: number
  /** 时长（秒，RunTimeTicks 换算；缺失为 undefined） */
  duration?: number
  /** 原始文件路径（非刮削分集无 IndexNumber，前端从文件名解析集号兜底） */
  filePath?: string
  /** 递归后代条目数（Series≈总集数，海报墙角标用） */
  recursiveItemCount?: number
}

export interface JellyfinResolvedSource {
  title: string
  videoUrl: string
  /** 直连 URL（浏览器可直连 Jellyfin 时使用） */
  directUrl?: string
  format: MediaFormat
  duration: number
  /** 默认音轨编码（如 aac/dts/eac3），无法探测时为 null */
  audioCodec?: string | null
  /** 音轨编码浏览器不支持，已自动切换为 Jellyfin 服务端转码流（HLS） */
  needsAudioTranscode?: boolean
  /** 音轨不兼容但管理后台音频转码开关关闭，浏览器可能无声 */
  audioTranscodeDisabled?: boolean
  /** 是否存在多版本（多个 MediaSource）；单版本时前端不渲染清晰度选择框 */
  multiVersion?: boolean
}
