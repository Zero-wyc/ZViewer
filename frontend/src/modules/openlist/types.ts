/**
 * OpenList 类型定义
 *
 * OpenList 通过 WebDAV 协议访问，类型结构与 WebDAV 模块对齐。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface OpenListMount {
  id: number
  type: 'openlist'
  name: string
  serverUrl: string | null
  port: number | null
  path: string | null
  username: string | null
  directLink: boolean
  createdAt: string
  updatedAt: string
}

export interface OpenListMountFormPayload {
  name: string
  serverUrl: string | null
  path: string | null
  username: string | null
  password: string | null
  directLink: boolean
}

export interface OpenListConnectionParams {
  serverUrl: string
  path: string
  username?: string
  password?: string
}

export interface OpenListDirectoryEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  lastModified?: string
}

export interface OpenListResolvedSource {
  title: string
  videoUrl: string
  /** 媒体容器格式。后端按文件扩展名推断，可能为 mkv/avi 等浏览器不支持的格式。 */
  format: MediaFormat
  duration: number
  size?: number
}
