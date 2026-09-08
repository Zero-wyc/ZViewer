/** 服务器文件目录条目。 */
export interface ServerFileEntry {
  name: string
  /** 前缀式路径（如 'uploads:/movies/a.mp4' 或 'custom:3:/videos/b.mp4'）。 */
  path: string
  type: 'directory' | 'file'
  size?: number
  modifiedAt?: string
}

/** 浏览目录返回结果。 */
export interface ServerBrowseResult {
  entries: ServerFileEntry[]
  /** 当前目录的前缀式路径。 */
  currentPath: string
  /** 当前根是否只读。 */
  readonly?: boolean
}

/** 解析文件返回结果。 */
export interface ServerFileResolved {
  title: string
  videoUrl: string
  format: string
  size: number
  /** 音频编码（由前端 MKV demux 探测回填） */
  audioCodec?: string | null
  /** 视频时长（秒） */
  duration?: number | null
}

/** 上传成功的文件信息。 */
export interface UploadedFile {
  name: string
  path: string
  size: number
}

/** 服务器文件根目录描述。 */
export interface ServerFileRoot {
  /** 唯一标识：'uploads' 或 'custom:<id>'。 */
  key: string
  /** 显示名称。 */
  name: string
  /** 服务器上的真实绝对路径。 */
  absPath: string
  /** 是否只读。 */
  readonly: boolean
  /** 目录是否真实存在。 */
  exists: boolean
}

/** 系统目录浏览返回的条目（仅目录）。 */
export interface SystemDirEntry {
  name: string
  absPath: string
}

/** 系统目录浏览返回结果。 */
export interface SystemDirBrowseResult {
  entries: SystemDirEntry[]
  /** 当前目录的绝对路径（系统根时为空字符串或 '/'）。 */
  currentPath: string
  /** 父目录的绝对路径（用于返回上一级，系统根时为空）。 */
  parentPath: string
  /** 是否为系统根（Windows 盘符列表 / Unix 根目录）。 */
  isRoot: boolean
}

// ============ B站视频下载 ============

/** B站下载进度行（NDJSON 流式响应）。 */
export interface BilibiliDownloadProgress {
  status: 'parsing' | 'downloading' | 'done' | 'error'
  /** parsing 阶段的步骤标识 */
  step?: string
  /** 进度说明文本 */
  message?: string
  /** downloading 阶段已接收字节数 */
  received?: number
  /** downloading 阶段总字节数（未知时为 0） */
  total?: number
  /** downloading 阶段百分比 0-100 */
  percent?: number
  /** done 阶段的文件信息 */
  file?: { name: string; path: string; size: number }
  /** error 阶段的错误码 */
  code?: string
}

/** B站下载完成后的文件信息。 */
export interface BilibiliDownloadedFile {
  name: string
  path: string
  size: number
}

/** B站下载进度回调。 */
export interface BilibiliDownloadCallbacks {
  /** 解析阶段进度（step + message） */
  onParsing?: (step: string, message: string) => void
  /** 下载阶段进度（received/total/percent） */
  onDownloading?: (received: number, total: number, percent: number) => void
}
