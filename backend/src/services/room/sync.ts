import { Server as SocketIOServer, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { getRoomState, setRoomPlayback } from './state';

// watch-together-state 事件的负载类型
// format 类型拓宽为 string，与 services/mediaFormat.ts 的 MediaFormat 对齐，
// 允许 FTP/WebDAV/OpenList 等模块返回 mkv/avi/webm 等容器格式。
// currentQn / acceptQuality 由 B站 解析结果填充，房主广播时一并同步给观众。
export interface WatchTogetherStatePayload {
  roomId: string;
  state: {
    sourceUrl: string;
    sourceType: 'url' | 'webdav' | 'ftp' | 'openlist' | 'smb' | 'bilibili';
    audioUrl?: string;
    format?: string;
    videoCodec?: string;
    audioCodec?: string;
    cid?: number;
    isPlaying: boolean;
    currentTime: number;
    playbackRate: number;
    duration?: number;
    // B站当前清晰度 qn（如 80=1080P、120=4K），观众端据此更新 UI
    currentQn?: number;
    // B站可用清晰度列表，观众端据此渲染选择器
    acceptQuality?: Array<{ id: number; name: string }>;
  };
}

// watch-together-control 事件的负载类型
export interface WatchTogetherControlPayload {
  roomId: string;
  action: 'play' | 'pause' | 'seek' | 'rate';
  value?: number;
}

// host-heartbeat 事件负载：房主定时广播的轻量心跳
export interface HostHeartbeatPayload {
  roomId: string;
  currentTime: number;
  isPlaying: boolean;
}

// track-change 事件负载（合并弹幕/字幕轨道切换）
// - type='danmaku'：value 为弹幕轨道 ID（string）或 null（关闭弹幕）
// - type='subtitle'：value 为字幕轨道索引（number）或 null（关闭字幕）
export interface TrackChangePayload {
  roomId: string;
  type: 'danmaku' | 'subtitle';
  value: string | number | null;
}

// 通用回调类型
export type AckCallback = (response: { success: boolean; message?: string }) => void;

// 处理 watch-together-state 事件
// 仅活跃 sharer 可同步播放状态，向房间内其他成员广播
export async function handleWatchTogetherState(
  socket: Socket,
  io: SocketIOServer,
  payload: WatchTogetherStatePayload,
  callback?: AckCallback,
): Promise<void> {
  try {
    const sessionRepo = AppDataSource.getRepository(Session);
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (!sharer || sharer.roomId !== payload.roomId) {
      return callback?.({ success: false, message: '无权限同步' });
    }

    // 持久化房主最近一次广播的播放状态，用于房主刷新/重连后恢复进度
    // 同时记录当前影片 ID，房主刷新后通过影片 ID 匹配恢复（B站 URL 每次解析会变）
    const roomState = getRoomState(payload.roomId);
    setRoomPlayback(payload.roomId, {
      currentTime: payload.state.currentTime,
      isPlaying: payload.state.isPlaying,
      playbackRate: payload.state.playbackRate,
      duration: payload.state.duration,
      sourceUrl: payload.state.sourceUrl,
      sourceType: payload.state.sourceType,
      audioUrl: payload.state.audioUrl,
      format: payload.state.format,
      videoCodec: payload.state.videoCodec,
      audioCodec: payload.state.audioCodec,
      cid: payload.state.cid,
      currentQn: payload.state.currentQn,
      currentMovieId: roomState.currentMovieId
        ? Number(roomState.currentMovieId)
        : undefined,
    });

    socket.to(payload.roomId).emit('watch-together-state', {
      state: payload.state,
    });
    callback?.({ success: true });
  } catch (err) {
    console.error('watch-together-state error:', err);
    callback?.({ success: false, message: '同步失败' });
  }
}

// 处理 watch-together-control 事件
// 仅活跃 sharer 可下发播放控制指令，向房间内其他成员广播
export async function handleWatchTogetherControl(
  socket: Socket,
  io: SocketIOServer,
  payload: WatchTogetherControlPayload,
  callback?: AckCallback,
): Promise<void> {
  try {
    const sessionRepo = AppDataSource.getRepository(Session);
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (!sharer || sharer.roomId !== payload.roomId) {
      return callback?.({ success: false, message: '无权限控制' });
    }

    socket.to(payload.roomId).emit('watch-together-control', {
      action: payload.action,
      value: payload.value,
    });
    callback?.({ success: true });
  } catch (err) {
    console.error('watch-together-control error:', err);
    callback?.({ success: false, message: '控制失败' });
  }
}

// 处理 watch-together-request-state 事件
// 房间内任意成员可请求其他成员同步当前播放状态
export async function handleWatchTogetherRequestState(
  socket: Socket,
  io: SocketIOServer,
  payload: { roomId: string },
  callback?: AckCallback,
): Promise<void> {
  try {
    if (!socket.rooms.has(payload.roomId)) {
      return callback?.({ success: false, message: '不在该房间中' });
    }
    socket.to(payload.roomId).emit('watch-together-request-state');
    callback?.({ success: true });
  } catch (err) {
    console.error('watch-together-request-state error:', err);
    callback?.({ success: false, message: '请求失败' });
  }
}

// 处理 host-heartbeat 事件
// 仅活跃 sharer 可发送心跳，向房间内其他成员转发。
//
// 修复说明：前端 useHostHeartbeat 每 2s emit 'host-heartbeat'，观众端
// useViewerHeartbeat 监听该事件重置离线计时器。若后端不转发，观众 6s 内
// 必然收不到心跳而误报"房主已离线"并暂停播放。此 handler 修复该 bug。
export async function handleHostHeartbeat(
  socket: Socket,
  io: SocketIOServer,
  payload: HostHeartbeatPayload,
  callback?: AckCallback,
): Promise<void> {
  try {
    const sessionRepo = AppDataSource.getRepository(Session);
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (!sharer || sharer.roomId !== payload.roomId) {
      return callback?.({ success: false, message: '无权限发送心跳' });
    }
    // 转发心跳给房间内其他成员（不含发送者）
    socket.to(payload.roomId).emit('host-heartbeat', {
      currentTime: payload.currentTime,
      isPlaying: payload.isPlaying,
    });
    callback?.({ success: true });
  } catch (err) {
    console.error('host-heartbeat error:', err);
    callback?.({ success: false, message: '心跳转发失败' });
  }
}

// 处理 track-change 事件（合并弹幕/字幕轨道切换）
// 仅活跃 sharer 可下发轨道变更，向房间内其他成员转发。
//
// 修复说明：前端 useTrackSync 合并了旧版 danmaku-track-change 与
// subtitle-track-change 为统一的 track-change 事件（按 type 字段区分）。
// 旧版两个独立事件后端从未实现转发 handler，导致弹幕/字幕轨道同步失效。
// 此 handler 同时修复了这两个 bug。
export async function handleTrackChange(
  socket: Socket,
  io: SocketIOServer,
  payload: TrackChangePayload,
  callback?: AckCallback,
): Promise<void> {
  try {
    const sessionRepo = AppDataSource.getRepository(Session);
    const sharer = await sessionRepo.findOneBy({
      socketId: socket.id,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (!sharer || sharer.roomId !== payload.roomId) {
      return callback?.({ success: false, message: '无权限切换轨道' });
    }
    // 转发给房间内其他成员，观众端 useTrackSync 按 payload.type 分发到对应订阅者
    socket.to(payload.roomId).emit('track-change', {
      type: payload.type,
      value: payload.value,
    });
    callback?.({ success: true });
  } catch (err) {
    console.error('track-change error:', err);
    callback?.({ success: false, message: '轨道切换转发失败' });
  }
}
