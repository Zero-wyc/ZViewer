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

/**
 * B站视频分集（P）信息。
 * 多 P 视频的每个分集有独立的 cid 和 m4s 文件。
 * 前端用于在影片列表中显示分P选择器，切换分P时使用对应 cid 重新解析。
 */
export interface BilibiliVideoPage {
  /** 分集序号，从 1 开始 */
  page: number
  /** 分集 cid */
  cid: number
  /** 分集标题（part） */
  part: string
  /** 分集时长（秒） */
  duration: number
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
  /** 多 P 视频的分集列表（单 P 视频为 undefined） */
  pages?: BilibiliVideoPage[]
  /** 当前播放的分集序号（从 1 开始，默认 1） */
  currentPage?: number
  /**
   * 展开短链后的完整视频地址（后端解析时对 b23.tv 等短链 302 展开）。
   * 非短链输入时与用户输入一致。添加影片时用它替换原始短链，
   * 下游 BV 号提取 / 分 P 解析 / 弹幕匹配不再依赖短链可达性。
   */
  resolvedUrl?: string
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
  /** 多 P 视频的分集列表（单 P 视频为 undefined） */
  pages?: BilibiliVideoPage[]
  /** 当前播放的分集序号（从 1 开始） */
  currentPage?: number
  /** 展开短链后的完整视频地址（后端解析时对 b23.tv 等短链 302 展开） */
  resolvedUrl?: string
}

export interface BilibiliParseOptions {
  /**
   * 播放模式偏好：true=MP4 直链（流畅，seek 无卡顿，清晰度通常 480P/720P）；
   * false/undefined=DASH 分离流（高清，支持 1080P/4K，seek 需 MSE 重新缓冲）。
   */
  preferMp4?: boolean
  /**
   * 缓冲模式：true=先从 B站 CDN 完整下载 DASH m4s 到 IndexedDB，
   * 然后用 blob URL 播放（零网络流量，URL 过期不影响，seek 极快）。
   *
   * 仅对 DASH 源生效（preferMp4=true 时忽略此选项）。
   * 房主开启后观众端独立缓存，所有用户缓存完成后开始同步播放。
   */
  bufferMode?: boolean
  /**
   * P2P 传输：true=启用 SwarmCloud P2P 引擎，房间内观众通过 WebRTC
   * DataChannel 共享已下载的 m4s 分片，减少服务器流量与 CDN 带宽。
   *
   * 仅对 DASH 流模式生效（preferMp4=true 或 bufferMode=true 时忽略）。
   * 各客户端独立启用，SwarmCloud tracker 自动发现房间内 peer。
   * 房主与观众需各自开启才能建立 P2P 连接。
   */
  p2pEnabled?: boolean
  /**
   * CLI 本地高画质代理：true=启用本地 zcontrol-cli 代理解析/播放该 B站 视频。
   *
   * 启用后，前端通过本地 CLI（127.0.0.1:9333）使用用户自己的 B站 Cookie
   * 解析高画质地址并代理视频流，可获得大会员清晰度。
   *
   * 需要用户事先在本地启动 zcontrol-cli 并连接同一房间；未检测到 CLI 时
   * 自动回退到服务端解析。
   */
  cliEnabled?: boolean
  /**
   * 启用 CLI 之前保存的播放模式，用于关闭 CLI 后恢复原来的 DASH/MP4 选择。
   */
  cliPrevPreferMp4?: boolean
}
