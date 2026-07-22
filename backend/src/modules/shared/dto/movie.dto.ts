/**
 * 影片 DTO —— 统一定义。
 *
 * 消除旧架构中三处不统一的 Movie 类型：
 * - entities/Movie.ts（DB 实体，18 字段，含加密 password）
 * - services/room/state.ts（运行时 Movie 接口，11 字段）
 * - routes/rooms.ts（MovieDto，18 字段但类型不同）
 *
 * 序列化规则：
 * - DB 实体 → MovieDto：通过 serializeMovie() 函数转换
 * - 运行时状态 → MovieDto：直接使用
 * - 所有 socket 事件和 REST API 统一使用 MovieDto
 */

/** 影片源类型（与 DB Movie.source 对齐） */
export type MovieSourceType =
  | 'bilibili'
  | 'mp4'
  | 'webdav'
  | 'ftp'
  | 'openlist'
  | 'smb'
  | 'anime';

/**
 * 影片 DTO —— 客户端与服务端统一的影片表示。
 *
 * 用于：
 * - REST API 响应（GET /api/rooms/:roomId/movies）
 * - Socket 事件 movie-list 的 payload
 * - 内部服务间传递
 */
export interface MovieDto {
  /** 数据库主键 ID */
  id: number;
  /** 房间 ID */
  roomId: string;
  /** 视频 URL（B站为 BV 页面地址，其他为直链） */
  url: string;
  /** 标题 */
  title: string;
  /** 封面图 URL */
  cover?: string | null;
  /** 源类型 */
  source?: MovieSourceType | null;
  /** DASH 音频流地址 */
  audioUrl?: string | null;
  /** 媒体容器格式 */
  format?: string | null;
  /** 视频编码 */
  videoCodec?: string | null;
  /** 音频编码 */
  audioCodec?: string | null;
  /** 时长（秒） */
  duration?: number | null;
  /** B站 cid */
  cid?: number | null;
  /** B站当前清晰度 qn */
  currentQn?: number | null;
  /** B站可用清晰度列表（JSON 字符串） */
  acceptQuality?: string | null;
  /** WebDAV/FTP 服务器 URL */
  serverUrl?: string | null;
  /** WebDAV/FTP 路径 */
  path?: string | null;
  /** WebDAV/FTP 用户名 */
  username?: string | null;
  /** WebDAV/FTP 密码（已解密） */
  password?: string | null;
  /** 是否为直链 */
  directLink?: boolean;
  /** 排序序号 */
  order?: number;
  /** 创建时间（ISO 字符串） */
  createdAt?: string;
  /** 更新时间（ISO 字符串） */
  updatedAt?: string;
}

/**
 * 房间 DTO —— REST API 响应用。
 */
export interface RoomDto {
  roomId: string;
  name: string | null;
  mode: string;
  shareMethod: string;
  status: string;
  requireApproval: boolean;
  maxViewers: number;
  hasPassword: boolean;
  ownerUserId: number | null;
  viewerCount: number;
  sharerOnline: boolean;
  lastAccessedAt: string;
  createdAt: string;
}

/**
 * 观众信息 DTO。
 */
export interface ViewerDto {
  socketId: string;
  userId: number | null;
  username: string;
  role: 'sharer' | 'viewer';
}

/**
 * 观众加入事件 payload（统一字段名，修复旧架构 socketId vs viewerSocketId 不一致问题）。
 */
export interface ViewerJoinedPayload {
  viewerSocketId: string;
  userId: number | null;
  username: string;
  role: 'sharer' | 'viewer';
}

/**
 * 观众离开事件 payload（统一字段名）。
 */
export interface ViewerLeftPayload {
  viewerSocketId: string;
}
