import type { MediaFormat } from '@/lib/mediaFormat'

export interface WebDAVMount {
  id: number
  type: 'webdav'
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface WebDAVMountFormPayload {
  type: 'webdav'
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface WebDAVConnectionParams {
  serverUrl: string
  path: string
  username?: string
  password?: string
}

export interface WebDAVDirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  lastModified?: string
}

export interface WebDAVResolvedSource {
  title: string
  videoUrl: string
  /** 媒体容器格式。后端按文件扩展名推断，可能为 mkv/avi 等浏览器不支持的格式。 */
  format: MediaFormat
  duration: number
}
