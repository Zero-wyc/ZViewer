/**
 * 一起听（Listen Together）音乐同步事件处理器。
 *
 * 职责：房间级播放队列的 CRUD（持久化 + 全房间广播）、房主播放状态同步
 * 与心跳转发、观众申请制控制（复刻 watch-together 的权限模型：
 * 房主控制、观众观看、房管可管理队列、观众控制需申请）。
 *
 * 事件契约（与前端 frontend/src/modules/music/hooks/useListenTogether.ts
 * 及 types.ts 完全对齐，字段名不可改动）：
 * - music:queue-upsert    房主/房管 add 歌曲（append 尾部；afterCurrent 时
 *                         插入当前播放曲目之后并右移后续 order）→ 广播 music:queue-changed
 * - music:queue-remove    房主/房管删除歌曲（order 压实）→ 广播 music:queue-changed
 * - music:queue-reorder   房主/房管拖拽排序（按 ids 顺序重排 order）→ 广播 music:queue-changed
 * - music:queue-clear     房主/房管清空队列 → 广播 music:queue-changed（空队列）
 * - music:queue-changed   全房间广播 { roomId, items: MusicQueueItemPayload[] }（完整队列，按 order 升序）
 * - music:sync-state      房主广播播放状态（附 clientTs）→ 写入服务器基线（写侧传输延迟
 *                         补偿，锚定服务器时间轴）→ socket.to(roomId) 转发给其他成员
 * - music:host-heartbeat  房主每 2s 心跳（携带完整同步状态 + clientTs）→ 合并进服务器
 *                         基线（10s 节流落盘）→ 转发保留作旧前端兼容 + 新前端 fallback
 * - music:sync-heartbeat  服务器每 2s 广播推算状态（source='server'，观众进度唯一
 *                         权威来源；由 MusicBroadcasterService 驱动，本文件不处理）
 * - music:check-status    观众每 10s 主动自检（±10s 容差）→ ack 下发权威状态 + 服务器时间戳
 * - music:control-request 观众申请控制 → 仅转发给房主（附加申请者 socketId/用户名）
 * - music:control-response 房主应答 → 定向转发给申请者（回传 from 供其校验）
 * - music:sync-ack        观众切歌同步成功回执 → 仅转发给房主（附加用户名，
 *                         供房主左下角「xx 已同步」提示）
 * - music:get-state       观众/重连房主 join 房间后查询当前队列 + 最新同步状态（ack 返回，
 *                         附 serverTs 与 hostOnline 供观众端初始化自主控制模式）
 *
 * 状态恢复：与 watch-together 的 playbackMemoryService 对齐——音乐同步状态由
 * musicPlaybackMemoryService 持有（内存缓存 + MusicPlaybackState 表节流落盘，
 * 写侧补偿锚定服务器时间轴），后端重启后 get-state 经 DB 恢复续播；
 * 队列本身持久化在 MusicQueueItem 表。
 *
 * 设计对齐 voice-chat.handler.ts（register/isSocketInRoom/权限调用方式）
 * 与 sync-playback 的 HeartbeatHandler / PlaybackMemoryHandler（心跳转发、
 * check-status 自检）。
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
import { musicPlaybackMemoryService } from './music-playback-memory.service';
import { needsProgressSync } from '../playback-memory';
import type {
  MusicPlayMode,
  MusicSyncStatePayload,
} from './music-sync.types';

export type { MusicPlayMode, MusicSyncStatePayload };

/** 合法的控制申请动作（与前端 MusicControlRequest['action'] 对齐）；
 *  addQueue = 观众申请添加音频到播放队列（携带 item 载荷，房主端按
 *  「自动通过」开关决定代理入队或拒绝）；seek = 观众申请调节播放进度
 *  （携带 positionSec 载荷，自动通过时房主端直接执行并应答）；
 *  playItem = 观众申请切换到播放列表条目（携带 item 载荷，房主端按
 *  key 匹配房间队列后代理切歌） */
const CONTROL_ACTIONS = [
  'pause',
  'play',
  'next',
  'prev',
  'addQueue',
  'seek',
  'playItem',
] as const;
type ControlAction = (typeof CONTROL_ACTIONS)[number];

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
  /** B站 条目：bvid/cid（source=bili 时存在，songId=0） */
  biliBvid?: string;
  biliCid?: number;
  /** B站 相关推荐自动加入的条目（列表中显示「推荐」tag） */
  recommended?: boolean;
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
  /** B站 本地插播条目：bvid 存在时走 B站 音源（songId=0） */
  biliBvid?: string;
  biliCid?: number;
  /** B站 相关推荐自动加入的条目（列表中显示「推荐」tag） */
  recommended?: boolean;
}

/** music:get-state 的 ack 应答（队列 + 最新同步状态 + 服务器时间戳/房主在线标记） */
export type GetStateResponse =
  | {
      success: true;
      queue: MusicQueueItemPayload[];
      syncState: MusicSyncStatePayload | null;
      /** 服务器当前时间（毫秒），供观众端时钟参考 */
      serverTs?: number;
      /** 房主是否在线（缺省 = 旧后端；false 时观众直接进入自主控制模式） */
      hostOnline?: boolean;
    }
  | { success: false; message: string };

/** music:check-status 的 ack 应答数据（与一起看 CheckStatusAckData 同构） */
export interface MusicCheckStatusAckData {
  needsSync: boolean;
  serverTs: number;
  /** needsSync=true 时携带服务器权威推算状态 */
  state?: MusicSyncStatePayload;
}

/**
 * 清理房间的音乐同步状态（房间删除时由 deleteRoomAndRelations 调用）。
 * 状态已收编进 musicPlaybackMemoryService（内存缓存 + DB 落盘），
 * 此处委托清理（含 DB 行删除，防止残留）。
 */
export function clearMusicSyncState(roomId: string): void {
  void musicPlaybackMemoryService.clear(roomId);
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
  // trackKey：`ncm:<songId>` / `bili:<bvid>:<cid>`；缺省/非法回退 null
  const rawTrackKey = v.trackKey == null ? null : (v.trackKey as unknown);
  const trackKey =
    typeof rawTrackKey === 'string' &&
    (rawTrackKey.startsWith('ncm:') || rawTrackKey.startsWith('bili:'))
      ? rawTrackKey
      : null;
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
    v.playMode !== 'order' &&
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
    trackKey,
    isPlaying: v.isPlaying,
    positionSec: v.positionSec,
    playMode: v.playMode,
    updatedAt: v.updatedAt,
  };
}

/**
 * 校验 queue-upsert 携带的歌曲元数据（不合法返回 false）。
 * 网易云条目：songId 必须为正整数；
 * B站 条目：biliBvid 为合法 BV 号且 biliCid 为正整数（songId=0）。
 */
function isUpsertItemValid(item: unknown): item is MusicQueueUpsertItem {
  if (!item || typeof item !== 'object') return false;
  const v = item as Record<string, unknown>;
  const commonOk =
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.artist === 'string' &&
    typeof v.album === 'string' &&
    (v.cover == null || typeof v.cover === 'string') &&
    typeof v.durationMs === 'number' &&
    Number.isFinite(v.durationMs) &&
    v.durationMs >= 0 &&
    typeof v.vip === 'boolean';
  if (!commonOk) return false;
  const biliBvid = typeof v.biliBvid === 'string' ? v.biliBvid : '';
  if (/^BV[0-9A-Za-z]{10}$/.test(biliBvid)) {
    return (
      typeof v.biliCid === 'number' &&
      Number.isInteger(v.biliCid) &&
      v.biliCid > 0
    );
  }
  return (
    typeof v.songId === 'number' &&
    Number.isInteger(v.songId) &&
    v.songId > 0
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
 *  塞壬支持已移除：songId<=0 且非 B站 条目的历史数据直接删除并不返回 */
async function loadQueue(roomId: string): Promise<MusicQueueItem[]> {
  const items = await AppDataSource.getRepository(MusicQueueItem).find({
    where: { roomId },
    order: { order: 'ASC' },
  });
  const stale = items.filter(
    (i) => i.songId <= 0 && i.source !== 'bili',
  );
  if (stale.length > 0) {
    await AppDataSource.getRepository(MusicQueueItem).remove(stale);
  }
  return items.filter((i) => i.songId > 0 || i.source === 'bili');
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
  return items.map((item, idx) => {
    const isBili = item.source === 'bili';
    const [biliBvid = '', biliCidStr = ''] = isBili
      ? (item.sourceId ?? '').split(':')
      : [];
    return {
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
      biliBvid: isBili ? biliBvid : undefined,
      biliCid: isBili && /^\d+$/.test(biliCidStr) ? Number(biliCidStr) : undefined,
      recommended: item.recommended === true,
    };
  });
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

    // --- 添加歌曲到队列（默认尾部；afterCurrent 插到当前播放下一首） ---
    socket.on(
      'music:queue-upsert',
      async (
        payload: {
          roomId: string;
          item: MusicQueueUpsertItem;
          afterCurrent?: boolean;
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
          if (!(await roomPermissionService.canViewerPerform(socket, roomId, 'musicQueue'))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：没有队列管理权限',
            });
          }
          if (!isUpsertItemValid(payload.item)) {
            return safeAck(callback, {
              success: false,
              message: '歌曲信息不完整',
            });
          }

          const repo = AppDataSource.getRepository(MusicQueueItem);
          const items = await loadQueue(roomId);

          // afterCurrent：按房间最新同步状态定位当前播放条目，插入其后
          // （把 ≥ 新 order 的既有条目 order 整体右移 1 压留空位）。
          // trackKey 为 bili 前缀时按 sourceId（"bvid:cid"）匹配 B站 条目
          let order = (items[items.length - 1]?.order ?? 0) + 1;
          let insertAfterIndex = -1;
          if (payload.afterCurrent === true) {
            const syncState = await musicPlaybackMemoryService.getRawState(roomId);
            const trackKey = syncState?.trackKey ?? null;
            if (trackKey?.startsWith('bili:')) {
              const sourceId = trackKey.slice(5);
              insertAfterIndex = items.findIndex(
                (it) => it.source === 'bili' && it.sourceId === sourceId,
              );
            } else {
              const trackSongId =
                syncState?.trackSongId ??
                (trackKey?.startsWith('ncm:')
                  ? Number(trackKey.slice(4))
                  : null);
              if (trackSongId != null) {
                insertAfterIndex = items.findIndex(
                  (it) => it.songId === trackSongId,
                );
              }
            }
          }
          if (insertAfterIndex >= 0) {
            // 新条目位次 = 当前条目 order+1；右移从当前条目的**下一个**开始
            // （此前从当前条目自身开始右移，导致当前条目与新条目 order 相同、
            //  连续插入时整批 order 全部平局，队列排序退化为 rowid 随机序，
            //  表现为「点下一首跳到推荐批次里的任意一首」）。
            // 前端连续插入是倒序逐条调用的（fresh.reverse()），本修正后
            // 每条都精确落在当前条目之后一位，最终顺序与推荐一致且无平局
            for (let i = insertAfterIndex + 1; i < items.length; i++) {
              items[i].order += 1;
              await repo.save(items[i]);
            }
            order = items[insertAfterIndex].order + 1;
          }

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
              order,
              addedBy: socket.data?.userId ?? 0,
              recommended: payload.item.recommended === true,
              // B站 本地插播条目：source=bili，sourceId 存 "bvid:cid"
              ...(payload.item.biliBvid
                ? {
                    source: 'bili',
                    sourceId: `${payload.item.biliBvid}:${payload.item.biliCid ?? 0}`,
                  }
                : {}),
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
          if (!(await roomPermissionService.canViewerPerform(socket, roomId, 'musicQueue'))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：没有队列管理权限',
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
          if (!(await roomPermissionService.canViewerPerform(socket, roomId, 'musicQueue'))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：没有队列管理权限',
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
          if (!(await roomPermissionService.canViewerPerform(socket, roomId, 'musicQueue'))) {
            return safeAck(callback, {
              success: false,
              message: '无权限：没有队列管理权限',
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

    // --- 房主广播播放状态（换曲/播放暂停/进度/播放模式；附 clientTs） ---
    socket.on(
      'music:sync-state',
      async (
        payload: { roomId: string; clientTs?: number } & MusicSyncStatePayload,
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

          // 写入服务器基线（Step 1 写侧传输延迟补偿：房主上报的 positionSec
          // 是发出时刻的值，播放中到达服务器时已推进 delay 秒，补回后基线
          // 锚定服务器时间轴——观众进度统一改读服务器推算值（Step 2）的前提）。
          // clientTs 可选：旧前端不携带时由服务端原样接收（无补偿）。
          const clientTs =
            typeof payload.clientTs === 'number' && Number.isFinite(payload.clientTs)
              ? payload.clientTs
              : undefined;
          await musicPlaybackMemoryService.setPlayback(
            roomId,
            state,
            socket.id,
            clientTs,
          );
          // 转发给房间内其他成员（不含发送者；保留 roomId 供前端防御跨房间残留）。
          // 旧前端兼容路径 + 新前端「即时操作低延迟通道」，进度权威在服务器心跳。
          socket.to(roomId).emit('music:sync-state', { roomId, ...state });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:sync-state] error:', err);
          safeAck(callback, { success: false, message: '同步状态转发失败' });
        }
      },
    );

    // --- 房主心跳（每 2s，携带完整同步状态 + clientTs） ---
    // 与 HeartbeatHandler 同模式：合并进服务器基线（10s 节流落盘，供
    // MusicBroadcasterService 外推广播）后转发给房间其他成员。转发保留作
    // 旧前端兼容；新前端观众不直接消费（仅 7s 无服务器心跳时 fallback）。
    socket.on(
      'music:host-heartbeat',
      async (
        payload: { roomId: string; clientTs?: number } & MusicSyncStatePayload,
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

          // 合并进基线（含写侧补偿；音乐心跳是完整状态，无缓存可自建）
          const clientTs =
            typeof payload.clientTs === 'number' && Number.isFinite(payload.clientTs)
              ? payload.clientTs
              : undefined;
          await musicPlaybackMemoryService.applyHostHeartbeat(
            roomId,
            state,
            socket.id,
            clientTs,
          );
          socket.to(roomId).emit('music:host-heartbeat', { roomId, ...state });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:host-heartbeat] error:', err);
          safeAck(callback, { success: false, message: '心跳转发失败' });
        }
      },
    );

    // --- 观众主动自检（CHECK_STATUS，Step 3） ---
    // 每 10s 上报本地播放状态，服务端与权威推算状态比对（±10s 容差，
    // 只比 isPlaying + 补偿后进度），分歧超限通过 ack 下发权威状态——
    // 作为服务器心跳丢失（socket 重连窗口/网络抖动）时的自愈通道。
    socket.on(
      'music:check-status',
      async (
        payload: {
          roomId: string;
          positionSec: number;
          isPlaying: boolean;
          clientTs?: number;
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
          if (
            typeof payload?.positionSec !== 'number' ||
            !Number.isFinite(payload.positionSec) ||
            payload.positionSec < 0 ||
            typeof payload?.isPlaying !== 'boolean'
          ) {
            return safeAck(callback, { success: false, message: '自检参数无效' });
          }

          const serverTs = Date.now();
          const serverState =
            await musicPlaybackMemoryService.getAdvancedState(roomId);
          if (!serverState) {
            return safeAck(callback, {
              success: true,
              data: { needsSync: false, serverTs },
            });
          }

          const clientTs =
            typeof payload.clientTs === 'number' && Number.isFinite(payload.clientTs)
              ? payload.clientTs
              : undefined;
          const needsSync = needsProgressSync({
            clientCurrentTime: payload.positionSec,
            clientIsPlaying: payload.isPlaying,
            clientPlaybackRate: 1,
            clientTs,
            serverCurrentTime: serverState.positionSec,
            serverIsPlaying: serverState.isPlaying,
          });

          safeAck(callback, {
            success: true,
            data: {
              needsSync,
              serverTs,
              ...(needsSync ? { state: serverState } : {}),
            },
          });
        } catch (err) {
          console.error('[music:check-status] error:', err);
          safeAck(callback, { success: false, message: '自检失败' });
        }
      },
    );

    // ==================== 观众申请制控制 ====================

    // --- 观众申请控制（暂停/继续/切歌/添加队列） → 仅转发给房主 ---
    socket.on(
      'music:control-request',
      async (
        payload: {
          roomId: string;
          action: ControlAction;
          /** addQueue/playItem 申请携带的条目载荷 */
          item?: MusicQueueUpsertItem;
          afterCurrent?: boolean;
          /** seek 申请携带的目标进度（秒） */
          positionSec?: number;
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
          if (!isControlAction(payload?.action)) {
            return safeAck(callback, { success: false, message: '参数无效' });
          }
          // addQueue/playItem：条目元数据必须完整（房主端代理时复用校验逻辑）
          if (
            (payload.action === 'addQueue' || payload.action === 'playItem') &&
            !isUpsertItemValid(payload?.item)
          ) {
            return safeAck(callback, { success: false, message: '歌曲信息不完整' });
          }
          // seek：目标进度必须是非负有限数（截断到毫秒精度防浮点噪声）
          if (payload.action === 'seek') {
            const pos = Number(payload?.positionSec);
            if (!Number.isFinite(pos) || pos < 0 || pos > 86400) {
              return safeAck(callback, { success: false, message: '进度参数无效' });
            }
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
            ...(payload.action === 'addQueue'
              ? { item: payload.item, afterCurrent: payload.afterCurrent === true }
              : {}),
            ...(payload.action === 'playItem'
              ? { item: payload.item }
              : {}),
            ...(payload.action === 'seek'
              ? { positionSec: Number(payload.positionSec) }
              : {}),
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

    // --- 观众同步回执（切歌同步成功） → 仅转发给房主 ---
    socket.on(
      'music:sync-ack',
      async (payload: { roomId: string }, callback?: AckCallback) => {
        try {
          const roomId = payload?.roomId;
          if (
            typeof roomId !== 'string' ||
            !roomId ||
            !isSocketInRoom(socket, roomId)
          ) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          // 房主不在线时无处转发（观众端此时自主控制，通常不会回执；静默成功）
          const sharer = await roomSessionService.getSharer(roomId);
          if (!sharer) {
            return safeAck(callback, { success: true });
          }
          // username 以服务器侧 socket 身份为准（防伪造）
          io.to(sharer.socketId).emit('music:sync-ack', {
            roomId,
            username: socket.data?.username,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[music:sync-ack] error:', err);
          safeAck(callback, { success: false, message: '同步回执转发失败' });
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
          // 服务器推算后的权威状态（内存未命中读 DB——后端重启后恢复续播的关键）
          const syncState =
            await musicPlaybackMemoryService.getAdvancedState(roomId);
          const serverTs = Date.now();
          const hostOnline = await roomSessionService.isSharerOnline(roomId);
          safeGetStateAck(callback, { success: true, queue, syncState, serverTs, hostOnline });
        } catch (err) {
          console.error('[music:get-state] error:', err);
          safeGetStateAck(callback, { success: false, message: '获取队列失败' });
        }
      },
    );
  }
}
