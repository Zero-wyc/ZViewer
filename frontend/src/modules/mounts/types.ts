// 统一挂载类型：聚合 webdav/openlist/ftp 三种挂载
// 各模块保持独立 CRUD，此类型仅用于统一展示和选择
import type { WebDAVMount } from '@/modules/webdav/types'
import type { OpenListMount } from '@/modules/openlist/types'
import type { FTPMount } from '@/modules/ftp/types'

export type MountType = 'webdav' | 'ftp' | 'openlist'

export type UnionMount = WebDAVMount | OpenListMount | FTPMount

export interface MountTypeMeta {
  label: string
  color: 'primary' | 'warning' | 'success'
  icon: React.ReactNode
}

// 类型守卫
export function isWebDAVMount(m: UnionMount): m is WebDAVMount {
  return m.type === 'webdav'
}

export function isOpenListMount(m: UnionMount): m is OpenListMount {
  return m.type === 'openlist'
}

export function isFTPMount(m: UnionMount): m is FTPMount {
  return m.type === 'ftp'
}
