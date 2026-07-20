import type { MediaFormat } from '@/lib/mediaFormat'

export interface FTPMount {
  id: number
  type: 'ftp'
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface FTPMountFormPayload {
  type: 'ftp'
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface FTPConnectionParams {
  serverUrl: string
  path: string
  port?: number
  username?: string
  password?: string
}

export interface FTPDirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  lastModified?: string
}

export interface FTPResolvedSource {
  title: string
  videoUrl: string
  /** 媒体容器格式。后端按文件扩展名推断，可能为 mkv/avi 等浏览器不支持的格式。 */
  format: MediaFormat
  duration: number
  size?: number
}
