/**
 * Bilibili 模块相关类型定义
 *
 * 注意：`QualityOption` 与 `ResolvedSource` 也被 FTP / WebDAV / OpenList 等
 * 非 Bilibili 逻辑使用，因此在本模块定义并由 `resolveSource.ts` re-export
 * 以保持向后兼容。
 */
import type { MediaFormat } from '@/lib/mediaFormat'

export interface QualityOption {
  id: number
  label: string
  resolution?: string
}

export interface ResolvedSource {
  title?: string
  videoUrl: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
  /** 媒体容器格式。FTP/WebDAV/OpenList 可能返回 mkv/avi 等浏览器不支持的格式。 */
  format: MediaFormat
  loggedIn?: boolean
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  /** 大会员状态：0=非大会员，1=大会员。用于统一会员感知逻辑。 */
  vipStatus?: number
}

export interface BilibiliQrData {
  qrcodeKey: string
  qrUrl: string
  qrDataUrl: string
}

export interface BilibiliUserInfo {
  name: string
  avatar: string
  vipStatus?: 0 | 1
}

/** B站 解析进度行（NDJSON 单行） */
export interface ResolveProgressLine {
  success?: boolean
  status: 'parsing' | 'done' | 'error'
  step?: string
  message?: string
  code?: string
  title?: string
  videoUrl?: string
  audioUrl?: string
  videoCodec?: string
  audioCodec?: string
  duration?: number
  format?: MediaFormat
  loggedIn?: boolean
  cid?: number
  currentQn?: number
  acceptQuality?: QualityOption[]
  /** 大会员状态：0=非大会员，1=大会员。后端在解析时会回传该字段。 */
  vipStatus?: number
}

export type BilibiliCodec = 'auto' | 'avc' | 'hevc' | 'av1'

export interface BilibiliParseOptions {
  fnval?: number
  preferCdn?: string
  codec?: BilibiliCodec
}
