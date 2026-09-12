/**
 * 一起听（Listen Together）音乐同步事件处理器。
 *
 * 职责：房间级播放队列的 CRUD（持久化 + 全房间广播）、房主播放状态同步
 * 与心跳转发、观众申请制控制（复刻 watch-together 的权限模型：
 * 房主控制、观众观看、房管可管理队列、观众控制需申请）。
 *
 * 事件契约（与前端 frontend/src/modules/music/hooks/useListenTogether.ts
 * 及 types.ts 完全对齐，字段名不可改动）：
 * - music:queue-upsert    房主/房管 add 歌曲（append 尾部）→ 广播 music:queue-changed
 * - music:queue-remove    房主/房管删除歌曲（order 压实）→ 广播 music:queue-changed
 * - music:queue-reorder   房主/房管拖拽排序（按 ids 顺序重排 order）→ 广播 music:queue-changed
 * - music:queue-clear     房主/房管清空队列 → 广播 music:queue-changed（空队列）
 * - music:queue-changed   全房间广播 { roomId, items: MusicQueueItemPayload[] }（完整队列，按 order 升序）
 * - music:sync-state      房主广播播放状态 → socket.to(roomId) 转发给其他成员
 * - music:host-heartbeat  房主每 2s 心跳（携带完整同步状态）→ 转发；同时更新内存快照
 * - music:control-request 观众申请控制 → 仅转发给房主（附加申请者 socketId/用户名）
 * - music:control-response 房主应答 → 定向转发给申请者（回传 from 供其校验）
 * - music:get-state       观众/重连房主 join 房间后查询当前队列 + 最新同步状态（ack 返回）
 *
 * 状态恢复：与 watch-together 的 playbackMemoryService 不同，音乐同步状态
 * 体量小且强依赖房主在线（房主离线时观众自主控制），采用内存 Map 保存
 * 每个房间最新 MusicSyncState（sync-state / 心跳时更新），get-state 返回；
 * 队列本身持久化在 MusicQueueItem 表，后端重启后仍可恢复。
 *
 * 设计对齐 voice-chat.handler.ts（register/isSocketInRoom/权限调用方式）
 * 与 sync-playback 的 HeartbeatHandler / SeekApprovalHandler（心跳转发、申请制）。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { In } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { MusicQueueItem } from '../../entities/MusicQueueItem';
import { User } from '../../entities/User';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomSessionService } from '../room/room-session.service';

/** 播放模式（与前端 music/types.ts 的 PlayMode 对齐） */
type MusicPlayMode = 'sequence' | 'repeat-one' | 'shuffle';

/** 合法的控制申请动作（与前端 MusicControlRequest['action'] 对齐） */
const CONTROL_ACTIONS = ['pause', 'play', 'next', 'prev'] as const;
type ControlAction = (typeof CONTROL_ACTIONS)[number];

/**
 * 房间音乐同步状态快照（房主 sync-state / 心跳携带，
 * 与前端 MusicSyncState 对齐）。
 */
export interface MusicSyncStatePayload {
  /** 当前曲目 songId（null 表示未在播放） */
  trackSongId: number | null;
  /** 是否正在播放 */
  isPlaying: boolean;
  /** 播放进度（秒） */
  positionSec: number;
  /** 播放模式 */
  playMode: MusicPlayMode;
  /** 状态生成时间戳（毫秒） */
  updatedAt: number;
}

/**
 * 队列条目广播结构（与前端 MusicQueueItem 契约对齐；
 * addedBy 已由后端解析为用户名字符串）。
 */
export interface MusicQueueItemPayload {
  id: number;
  roomId: string;
  songId: number;
  name: string;
  artist: string;
  album: string;
  cover: string;
  durationMs: number;
  vip: boolean;
  order: number;
  addedBy: string;
}

/** music:queue-upsert 携带的歌曲元数据（搜索结果条目） */
interface MusicQueueUpsertItem {
  songId: number;
  name: string;
  artist: string;
  album: string;
  cover?: string | null;
  durationMs: number;
  vip: boolean;
}

/** music:get-state 的 ack 应答（队列 + 最新同步状态） */
export type GetStateResponse =
  | { success: true; queue: MusicQueueItemPayload[]; syncState: MusicSyncStatePayload | null }
  | { success: false; message: string };

/** 房间最新同步状态（内存）：sync-state / 心跳时更新，get-state 时返回 */
const musicSyncStates = new Map<string, MusicSyncStatePayload>();

/**
 * 清理房间的音乐同步内存状态（房间删除时由 deleteRoomAndRelations 调用，
 * 防止 Map 残留）。
 */
export function clearMusicSyncState(roomId: string): void {
  musicSyncStates.delete(roomId);
}

/**
 * 校验 socket 是否已加入指定房间（socket.io 房间为权威状态，
 * 与 voice-chat.handler 的 isSocketInRoom 一致）。
 */
function isSocketInRoom(socket: Socket, roomId: string): boolean {
  return socket.rooms.has(roomId);
}

/**
 * 校验并提取同步状态字段（防御异常 payload；不合法返回 null）。
 */
function pickSyncState(payload: unknown): MusicSyncStatePayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = payload as Record<string, unknown>;
  const trackSongId =
    v.trackSongId == null ? null : (v.trackSongId as unknown);
  if (
    trackSongId !== null &&
    (typeof trackSongId !== 'number' ||
      !Number.isInteger(trackSongId) ||
      trackSongId <= 0)
  ) {
    return null;
  }
  if (typeof v.isPlaying !== 'boolean') return null;
  if (
    typeof v.positionSec !== 'number' ||
    !Number.isFinite(v.positionSec) ||
    v.positionSec < 0
  ) {
    return null;
  }
  if (
    v.playMode !== 'sequence' &&
    v.playMode !== 'repeat-one' &&
    v.playMode !== 'shuffle'
  ) {
    return null;
  }
  if (typeof v.updatedAt !== 'number' || !Number.isFinite(v.updatedAt)) {
    return null;
  }
  return {
    trackSongId,
    isPlaying: v.isPlaying,
    positionSec: v.positionSec,
    playMode: v.playMode,
    updatedAt: v.updatedAt,
  };
}

/**
 * 校验 queue-upsert 携带的歌曲元数据（不合法返回 false）。
 * songId 必须为正整数。
 */
function isUpsertItemValid(item: unknown): item is MusicQueueUpsertItem {
  if (!item || typeof item !== 'object') return false;
  const v = item as Record<string, unknown>;
  const songIdOk =
    typeof v.songId === 'number' &&
    Number.isInteger(v.songId) &&
    v.songId > 0;
  return (
    songIdOk &&
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.artist === 'string' &&
    typeof v.album === 'string' &&
    (v.cover == null || typeof v.cover === 'string') &&
    typeof v.durationMs === 'number' &&
    Number.isFinite(v.durationMs) &&
    v.durationMs >= 0 &&
    typeof v.vip === 'boolean'
  );
}

/**
 * 校验控制申请动作合法性。
 */
function isControlAction(action: unknown): action is ControlAction {
  return (
    typeof action === 'string' &&
    (CONTROL_ACTIONS as readonly string[]).includes(action)
  );
}

/** 读取房间完整队列（按 order 升序）。
 *  塞壬支持已移除：songId<=0 的历史条目（旧塞壬数据）直接删除并不返回 */
async function loadQueue(roomId: string): Promise<MusicQueueItem[]> {
  const items = await AppDataSource.getRepository(MusicQueueItem).find({
    where: { roomId },
    order: { order: 'ASC' },
  });
  const stale = items.filter((i) => i.songId <= 0);
  if (stale.length > 0) {
    await AppDataSource.getRepository(MusicQueueItem).remove(stale);
  }
  return items.filter((i) => i.songId > 0);
}

/**
 * 批量解析添加者用户名（游客/查无用户时的回退文案）。
 * 返回与 items 同序的用户名数组。
 */
async function resolveAddedByNames(
  items: MusicQueueItem[],
): Promise<string[]> {
  const userIds = [
    ...new Set(items.map((i) => i.addedBy).filter((id) => id > 0)),
  ];
  const nameMap = new Map<number, string>();
  if (userIds.length > 0) {
    const users = await AppDataSource.getRepository(User).find({
      where: { id: In(userIds) },
      select: { id: true, username: true },
    });
    for (const u of users) nameMap.set(u.id, u.username);
  }
  return items.map((item) =>
    nameMap.get(item.addedBy) ??
    (item.addedBy > 0 ? `用户#${item.addedBy}` : '游客'),
  );
}

/**
 * 构建广播队列（实体 → 前端契约结构；addedBy 解析为用户名）。
 */
async function buildQueuePayload(
  roomId: string,
): Promise<MusicQueueItemPayload[]> {
  const items = await loadQueue(roomId);
  const names = await resolveAddedByNames(items);
  return items.map((item, idx) => ({
    id: item.id,
    roomId: item.roomId,
    songId: item.songId,
    name: item.name,
    artist: item.artist,
    album: item.album,
    cover: item.cover ?? '',
    durationMs: item.durationMs,
    vip: item.vip,
    order: item.order,
    addedBy: names[idx],
  }));
}

/**
 * 全房间广播完整队列（music:queue-changed，前端按 items 字段读取）。
 */
async function broadcastQueue(
  io: SocketIOServer,
  roomId: string,
): Promise<void> {
  const items = await buildQueuePayload(roomId);
  io.to(roomId).emit('music:queue-changed', { roomId, items });
}

/**
 * 安全执行 music:get-state 的 ack 回调（应答结构含 queue/syncState 专属字段，
 * 与 safeAck 同防护：客户端可能已断开）。
 */
function safeGetStateAck(
  callback: ((response: GetStateResponse) => void) | undefined,
  response: GetStateResponse,
): void {
  if (callback) {
    try {
      callback(response);
    } catch {
      // 客户端可能已断开
    }
  }
}

export class MusicSyncHandler implements SocketEventHandler {
  readonly name = 'MusicSyncHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // ==================== 队列管理（房主/房管） ====================

    // --- 添加歌曲到队列尾部 ---
    socket.on(
      'music:queue-upsert',
      async (
        payload: { roomId: string; item: MusicQueueUpsertItem },
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (
            !(await roomPermissionService.isRoomHostOrModerator(socket, roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可管理队列',
            });
          }
          if (!isUpsertItemValid(payload.item)) {
            return safeAck(callback, {
              success: false,
              message: '歌曲信息不完整',
            });
          }

          const repo = AppDataSource.getRepository(MusicQueueItem);
          // append 到队列尾部：order = 当前最大 + 1
          const last = await repo.findOne({
            where: { roomId },
            order: { order: 'DESC' },
          });
          await repo.save(
            repo.create({
              roomId,
              songId: payload.item.songId,
              name: payload.item.name,
              artist: payload.item.artist,
              album: payload.item.album,
              cover: payload.item.cover ?? null,
              durationMs: Math.round(payload.item.durationMs),
              vip: payload.item.vip,
              order: (last?.order ?? 0) + 1,
              addedBy: socket.data?.userId ?? 0,
            }),
          );

          await broadcastQueue(io, roomId);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:queue-upsert] error:', err);
          safeAck(callback, { success: false, message: '添加歌曲失败' });
        }
      },
    );

    // --- 删除队列条目（order 压实为 1..n 连续） ---
    socket.on(
      'music:queue-remove',
      async (
        payload: { roomId: string; id: number },
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (
            !(await roomPermissionService.isRoomHostOrModerator(socket, roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可管理队列',
            });
          }
          if (
            typeof payload.id !== 'number' ||
            !Number.isInteger(payload.id)
          ) {
            return safeAck(callback, { success: false, message: '参数无效' });
          }

          const repo = AppDataSource.getRepository(MusicQueueItem);
          // where 同时限定 id + roomId，防止跨房间删除
          const removed = await repo.delete({ id: payload.id, roomId });
          if (!removed.affected || removed.affected === 0) {
            return safeAck(callback, { success: false, message: '歌曲不在队列中' });
          }

          // order 压实：剩余条目按现有顺序重排为 1..n
          const rest = await loadQueue(roomId);
          for (let i = 0; i < rest.length; i++) {
            if (rest[i].order !== i + 1) {
              rest[i].order = i + 1;
              await repo.save(rest[i]);
            }
          }

          await broadcastQueue(io, roomId);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:queue-remove] error:', err);
          safeAck(callback, { success: false, message: '删除歌曲失败' });
        }
      },
    );

    // --- 清空队列（仅房主/房管；删除后广播空队列） ---
    socket.on(
      'music:queue-clear',
      async (
        payload: { roomId: string },
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (
            !(await roomPermissionService.isRoomHostOrModerator(socket, roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可管理队列',
            });
          }

          const repo = AppDataSource.getRepository(MusicQueueItem);
          await repo.delete({ roomId });

          await broadcastQueue(io, roomId);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:queue-clear] error:', err);
          safeAck(callback, { success: false, message: '清空队列失败' });
        }
      },
    );

    // --- 拖拽排序（按 ids 有序列表重排 order） ---
    socket.on(
      'music:queue-reorder',
      async (
        payload: { roomId: string; ids: number[] },
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (
            !(await roomPermissionService.isRoomHostOrModerator(socket, roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主或房管可管理队列',
            });
          }

          const repo = AppDataSource.getRepository(MusicQueueItem);
          const items = await loadQueue(roomId);
          const ids = Array.isArray(payload?.ids) ? payload.ids : null;
          // ids 必须与现有队列的多重集（长度 + 元素）完全一致，防止丢条目/重复
          const isSameMultiset =
            ids !== null &&
            ids.every((id) => Number.isInteger(id)) &&
            (() => {
              const a = [...ids].sort((x, y) => x - y);
              const b = items.map((i) => i.id).sort((x, y) => x - y);
              return a.length === b.length && a.every((v, i) => v === b[i]);
            })();
          if (!isSameMultiset) {
            return safeAck(callback, {
              success: false,
              message: '排序列表与队列不一致',
            });
          }

          const byId = new Map(items.map((i) => [i.id, i]));
          ids.forEach((id, idx) => {
            const item = byId.get(id);
            if (item) item.order = idx + 1;
          });
          await repo.save([...byId.values()]);

          await broadcastQueue(io, roomId);
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:queue-reorder] error:', err);
          safeAck(callback, { success: false, message: '调整顺序失败' });
        }
      },
    );

    // ==================== 播放状态同步（房主专属） ====================

    // --- 房主广播播放状态（换曲/播放暂停/进度/播放模式） ---
    socket.on(
      'music:sync-state',
      async (
        payload: { roomId: string } & MusicSyncStatePayload,
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (!(await roomPermissionService.isRoomHost(socket, roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主可同步播放状态',
            });
          }
          const state = pickSyncState(payload);
          if (!state) {
            return safeAck(callback, { success: false, message: '同步状态无效' });
          }

          // 更新内存快照（观众中途加入 / 房主重连恢复的数据源）
          musicSyncStates.set(roomId, state);
          // 转发给房间内其他成员（不含发送者；保留 roomId 供前端防御跨房间残留）
          socket.to(roomId).emit('music:sync-state', { roomId, ...state });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:sync-state] error:', err);
          safeAck(callback, { success: false, message: '同步状态转发失败' });
        }
      },
    );

    // --- 房主心跳（每 2s，携带完整同步状态） ---
    // 与 HeartbeatHandler 同模式：转发给房间其他成员（观众据此判定房主在线
    // 并对齐进度），同时更新内存快照。
    socket.on(
      'music:host-heartbeat',
      async (
        payload: { roomId: string } & MusicSyncStatePayload,
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (!(await roomPermissionService.isRoomHost(socket, roomId))) {
            return safeAck(callback, {
              success: false,
              message: '无权限发送心跳',
            });
          }
          const state = pickSyncState(payload);
          if (!state) {
            return safeAck(callback, { success: false, message: '心跳状态无效' });
          }

          musicSyncStates.set(roomId, state);
          socket.to(roomId).emit('music:host-heartbeat', { roomId, ...state });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:host-heartbeat] error:', err);
          safeAck(callback, { success: false, message: '心跳转发失败' });
        }
      },
    );

    // ==================== 观众申请制控制 ====================

    // --- 观众申请控制（暂停/继续/切歌） → 仅转发给房主 ---
    socket.on(
      'music:control-request',
      async (
        payload: { roomId: string; action: ControlAction },
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (!isControlAction(payload?.action)) {
            return safeAck(callback, { success: false, message: '参数无效' });
          }
          // 房主在线才可申请（房主离线时前端走自主控制，不走申请）
          const sharer = await roomSessionService.getSharer(roomId);
          if (!sharer) {
            return safeAck(callback, { success: false, message: '房主不在线' });
          }

          // 转发给房主；from/username 以服务器侧 socket 身份为准（防伪造）
          io.to(sharer.socketId).emit('music:control-request', {
            roomId,
            action: payload.action,
            from: socket.id,
            username: socket.data?.username,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:control-request] error:', err);
          safeAck(callback, { success: false, message: '申请控制失败' });
        }
      },
    );

    // --- 房主应答观众的控制申请 → 定向转发给申请者 ---
    socket.on(
      'music:control-response',
      async (
        payload: {
          roomId: string;
          approved: boolean;
          action: ControlAction;
          from: string;
        },
        callback?: AckCallback,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          if (!(await roomPermissionService.isRoomHost(socket, roomId))) {
            return safeAck(callback, { success: false, message: '无权限' });
          }
          if (
            typeof payload.from !== 'string' ||
            !payload.from ||
            !isControlAction(payload?.action) ||
            typeof payload.approved !== 'boolean'
          ) {
            return safeAck(callback, { success: false, message: '参数无效' });
          }

          // 定向发给申请者；回传 from（申请者 socketId）供其校验是发给自己的
          io.to(payload.from).emit('music:control-response', {
            approved: payload.approved,
            action: payload.action,
            from: payload.from,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:control-response] error:', err);
          safeAck(callback, { success: false, message: '应答转发失败' });
        }
      },
    );

    // ==================== 初始状态查询 ====================

    // --- 查询当前队列 + 最新同步状态（观众进入 / 房主重连恢复） ---
    socket.on(
      'music:get-state',
      async (
        payload: { roomId: string },
        callback?: (response: GetStateResponse) => void,
      ) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeGetStateAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }

          const queue = await buildQueuePayload(roomId);
          const syncState = musicSyncStates.get(roomId) ?? null;
          safeGetStateAck(callback, { success: true, queue, syncState });
        } catch (err) {
          console.error('[music:get-state] error:', err);
          safeGetStateAck(callback, { success: false, message: '获取队列失败' });
        }
      },
    );
  }
}
