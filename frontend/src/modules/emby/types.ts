/**
 * Emby 挂载类型定义
 *
 * Emby 是媒体库型视频源（itemId 树形结构，非文件目录型），
 * 认证方式二选一：API Key 或 账号密码。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface EmbyMount {
  id: number
  type: 'emby'
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  embyUserId: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface EmbyMountFormPayload {
  name: string
  serverUrl: string | null
  apiKey: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface EmbyTestResult {
  success: boolean
  userId?: string
  userName?: string
  serverId?: string
}

export interface EmbyDirectoryEntry {
  name: string
  path: string
  /** file = 可播放条目（电影/单集），directory = 可继续浏览（媒体库/剧集/季） */
  type: 'file' | 'directory'
  /** Emby 条目类型（CollectionFolder/Series/Season/Movie/Episode/Video） */
  embyType?: string
  childCount?: number
  /** 刮削主海报 tag（ImageTags.Primary，瀑布流海报墙用） */
  imageTag?: string
  /** 刮削年份 */
  productionYear?: number
}

export interface EmbyResolvedSource {
  title: string
  videoUrl: string
  /** 直连 URL（浏览器可直连 Emby 时使用） */
  directUrl?: string
  format: MediaFormat
  duration: number
  /** 默认音轨编码（如 aac/dts/eac3），无法探测时为 null */
  audioCodec?: string | null
  /** 音轨编码浏览器不支持，已自动切换为 Emby 服务端转码流（HLS） */
  needsAudioTranscode?: boolean
  /** 音轨不兼容但管理后台音频转码开关关闭，浏览器可能无声 */
  audioTranscodeDisabled?: boolean
}
