/**
 * 语音聊天处理器（服务器中转）。
 *
 * 职责：管理房间内语音聊天成员状态，中转 PCM/Opus 音频数据，
 * 以及语音管理操作（禁言/解禁/踢出，房主或房管可执行）。
 *
 * 设计：
 * - 实现 SocketEventHandler 接口，由 SocketRegistry 统一注册
 * - 从 services/screen-sharing/signaling.ts 中分离，消除信令与语音聊天的耦合
 *
 * 成员身份与幽灵清理（v2）：
 * - 成员以「身份键」为主键：登录用户 user:{userId}，游客 socket:{socketId}。
 *   同一登录用户重连（网络波动后 socket.id 变化）直接顶替旧条目而非追加，
 *   从根源消除「3 人语音显示 8 人」的幽灵残留。
 * - 事件与成员列表携带真实身份（userId + username），前端不再以 socketId
 *   前缀充当显示名，解决「不知道谁在说话/谁进了语音」。
 * - 音频路由仍以 socketId 为准（voice-audio-data 的 from 字段），
 *   顶替/离开时广播旧 socketId 供接收端清理播放链路。
 * - 幽灵兜底：定时扫描成员的 socketId 是否仍存在于 io.sockets.sockets
 *   （连接权威状态），不存在即强制移除——不依赖 disconnect 事件是否触发，
 *   静音用户（不发音频包）不受影响。
 *
 * 语音管理（v3）：
 * - voice-mute / voice-unmute：禁言期间服务器中转层直接丢弃该成员的
 *   voice-audio-data / voice-codec-config（服务器侧强制，客户端无法绕过），
 *   被禁言者仍可收听。登录用户按 userId 持久化（Room.voiceMuted），
 *   游客为会话级（内存，按 socketId）。
 * - voice-kick：移出语音频道并通知被踢者（前端自动断开采集）；
 *   60s 冷却期内禁止重新加入（防反复骚扰），内存记录。
 * - 权限：房主或房管（roomPermissionService.isRoomHostOrModerator）；
 *   房管不可操作房主/其他房管。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import type { SocketEventHandler } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';

/** 语音成员条目 */
interface VoiceMemberEntry {
  /** 当前连接的 socket id（音频路由 key，重连顶替时更新） */
  socketId: string;
  /** 登录用户 ID；游客为 0 */
  userId: number;
  /** 显示名（登录用户取自 token，游客取客户端提供的昵称） */
  username: string;
  /** 加入时间戳（日志用） */
  joinedAt: number;
}

/** 广播/应答中的成员信息 */
export interface VoiceMemberInfo {
  socketId: string;
  userId: number;
  username: string;
  /** 是否被语音禁言（voice-join 应答时填充，供前端初始化标记） */
  muted?: boolean;
}

/**
 * 每个房间的语音成员：roomId → (身份键 → 条目)。
 * 身份键：登录用户 `user:{userId}`；游客 `socket:{socketId}`（token 层
 * 游客完全同质（userId=0/username='guest'），无法以 userId 区分，退化为
 * 每连接身份）。
 */
const voiceMembers = new Map<string, Map<string, VoiceMemberEntry>>();

/**
 * 每个房间的语音禁言集合（内存镜像，与 Room.voiceMuted 持久化同步）。
 * 元素为身份键：登录用户 user:{userId}（持久化），游客 socket:{socketId}（会话级）。
 * 首个成员加入房间语音时从 DB 惰性加载。
 */
const voiceMutedKeys = new Map<string, Set<string>>();

/** 已从 DB 加载过禁言列表的房间（惰性加载标记） */
const voiceMutedLoaded = new Set<string>();

/** 被踢出语音的冷却：身份键 → 解禁时间戳 */
const voiceKickCooldown = new Map<string, number>();

/** 幽灵扫描间隔 */
const GHOST_SWEEP_INTERVAL_MS = 15_000;

/** 被踢出语音后的重新加入冷却时长 */
const VOICE_KICK_COOLDOWN_MS = 60_000;

/**
 * 校验 socket 是否已加入指定房间。
 */
function isSocketInRoom(socket: Socket, roomId: string): boolean {
  return socket.rooms.has(roomId);
}

/**
 * 计算成员身份键。
 */
function memberKeyOf(socket: Socket): string {
  const userId: number | undefined = socket.data?.userId;
  return userId && userId > 0 ? `user:${userId}` : `socket:${socket.id}`;
}

/**
 * 将成员条目转为对外信息。
 */
function toInfo(entry: VoiceMemberEntry): VoiceMemberInfo {
  return { socketId: entry.socketId, userId: entry.userId, username: entry.username };
}

/**
 * 从 DB 加载房间的语音禁言列表到内存（登录用户部分）。
 */
async function loadVoiceMuted(roomId: string): Promise<void> {
  if (voiceMutedLoaded.has(roomId)) return;
  voiceMutedLoaded.add(roomId);
  try {
    const room = await AppDataSource.getRepository(Room).findOneBy({ roomId });
    if (!room) return;
    const userIds: number[] = JSON.parse(room.voiceMuted || '[]');
    const set = voiceMutedKeys.get(roomId) ?? new Set<string>();
    for (const uid of userIds) set.add(`user:${uid}`);
    voiceMutedKeys.set(roomId, set);
  } catch {
    // DB 异常时按空处理，管理操作仍可写入内存
  }
}

/**
 * 持久化语音禁言列表（仅登录用户的 userId）。
 */
async function persistVoiceMuted(roomId: string): Promise<void> {
  const set = voiceMutedKeys.get(roomId);
  if (!set) return;
  const userIds: number[] = [];
  for (const key of set) {
    if (key.startsWith('user:')) userIds.push(Number(key.slice(5)));
  }
  try {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId });
    if (!room) return;
    room.voiceMuted = JSON.stringify(userIds);
    await roomRepo.save(room);
  } catch (err) {
    console.error('[voice] persist voiceMuted error:', err);
  }
}

/**
 * 从房间的语音成员中移除指定身份键的条目，并广播离开事件。
 */
function removeMember(
  io: SocketIOServer,
  roomId: string,
  key: string,
): VoiceMemberEntry | null {
  const members = voiceMembers.get(roomId);
  if (!members) return null;
  const entry = members.get(key);
  if (!entry) return null;

  members.delete(key);
  if (members.size === 0) {
    voiceMembers.delete(roomId);
  }
  io.to(roomId).emit('voice-user-left', toInfo(entry));
  console.log(`[voice] ${entry.username}(${key}) left room ${roomId}`);
  return entry;
}

/**
 * 按 socketId 移除成员（voice-leave / disconnect 清理路径）。
 * 语音房间成员数受房间人数上限约束（个位数），线性扫描成本可忽略。
 */
function removeBySocketId(io: SocketIOServer, socket: Socket, roomId: string): void {
  const members = voiceMembers.get(roomId);
  if (!members) return;
  for (const [key, entry] of members) {
    if (entry.socketId === socket.id) {
      removeMember(io, roomId, key);
      return;
    }
  }
}

/**
 * 幽灵扫描：socketId 不再存在于服务器连接表中的成员强制移除。
 *
 * 不依赖 disconnect 事件（异常断开下可能丢失/延迟），以 io.sockets.sockets
 * 的连接权威状态为准；静音用户（不发音频包）的 socket 仍存活，不受影响。
 * 顺带清理过期的踢出冷却。
 */
function sweepGhosts(io: SocketIOServer): void {
  const now = Date.now();
  for (const [roomId, members] of voiceMembers) {
    for (const [key, entry] of members) {
      if (!io.sockets.sockets.has(entry.socketId)) {
        console.warn(
          `[voice] 幽灵成员清理: ${entry.username}(${key}) in room ${roomId}`,
        );
        removeMember(io, roomId, key);
      }
    }
  }
  for (const [key, until] of voiceKickCooldown) {
    if (now > until) voiceKickCooldown.delete(key);
  }
}

export class VoiceChatHandler implements SocketEventHandler {
  readonly name = 'voice-chat';
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  register(socket: Socket, io: SocketIOServer): void {
    // 首个 socket 注册时启动幽灵扫描（handler 为单例，随进程存活）
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => sweepGhosts(io), GHOST_SWEEP_INTERVAL_MS);
    }

    // --- 加入语音聊天 ---
    socket.on(
      'voice-join',
      (
        payload: { roomId: string; username?: string },
        callback?: (
          response:
            | { success: true; members: VoiceMemberInfo[] }
            | { success: false; message: string },
        ) => void,
      ) => {
        void (async () => {
          const { roomId } = payload;
          if (!isSocketInRoom(socket, roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }
          await loadVoiceMuted(roomId);

          const key = memberKeyOf(socket);
          const userId: number = socket.data?.userId ?? 0;
          // 显示名：登录用户取 token 中的真实用户名；游客退化为客户端提供的昵称
          const tokenUsername: string | undefined = socket.data?.username;
          const username =
            (userId > 0 && tokenUsername) || payload.username || '游客';

          // 踢出冷却检查
          const cooldownUntil = voiceKickCooldown.get(key);
          if (cooldownUntil && Date.now() < cooldownUntil) {
            const remain = Math.ceil((cooldownUntil - Date.now()) / 1000);
            return callback?.({
              success: false,
              message: `您已被移出语音，${remain} 秒后可重新加入`,
            });
          }

          let members = voiceMembers.get(roomId);
          if (!members) {
            members = new Map();
            voiceMembers.set(roomId, members);
          }

          const existing = members.get(key);
          if (existing && existing.socketId === socket.id) {
            // 幂等重入：已用同一连接加入
            return callback?.({
              success: true,
              members: [...members.values()]
                .filter((m) => m.socketId !== socket.id)
                .map(toInfo),
            });
          }

          if (existing) {
            // 同一用户重连（socket.id 已变化）：顶替旧条目。
            // 广播旧 socketId 的离开事件，供接收端清理旧播放链路
            removeMember(io, roomId, key);
          }

          const entry: VoiceMemberEntry = {
            socketId: socket.id,
            userId,
            username,
            joinedAt: Date.now(),
          };
          members.set(key, entry);
          socket.to(roomId).emit('voice-user-joined', toInfo(entry));
          console.log(`[voice] ${username}(${key}) joined room ${roomId}`);

          // join 应答携带各成员禁言状态（前端初始化标记）
          const mutedSet = voiceMutedKeys.get(roomId);
          const toInfoWithMute = (m: VoiceMemberEntry): VoiceMemberInfo => {
            const mKey = m.userId > 0 ? `user:${m.userId}` : `socket:${m.socketId}`;
            return { ...toInfo(m), muted: mutedSet?.has(mKey) ?? false };
          };
          callback?.({
            success: true,
            members: [...members.values()]
              .filter((m) => m.socketId !== socket.id)
              .map(toInfoWithMute),
          });
        })();
      },
    );

    // --- 离开语音聊天 ---
    socket.on(
      'voice-leave',
      (
        payload: { roomId: string },
        callback?: (response: { success: boolean }) => void,
      ) => {
        removeBySocketId(io, socket, payload.roomId);
        callback?.({ success: true });
      },
    );

    // --- 语音音频数据中转 ---
    socket.on('voice-audio-data', (payload: {
      roomId: string;
      data: ArrayBuffer;
      sampleRate?: number;
      timestamp: number;
      mediaTs?: number;
      encoded?: boolean;
    }) => {
      try {
        const members = voiceMembers.get(payload.roomId);
        if (!members) return;
        // 校验发送者确为该房间语音成员（按 socketId 匹配当前连接）
        let entry: VoiceMemberEntry | null = null;
        for (const m of members.values()) {
          if (m.socketId === socket.id) {
            entry = m;
            break;
          }
        }
        if (!entry) return;

        // 语音禁言：服务器侧直接丢弃（客户端无法绕过），仍可收听
        const mutedSet = voiceMutedKeys.get(payload.roomId);
        if (mutedSet?.has(memberKeyOf(socket))) return;

        socket.to(payload.roomId).emit('voice-audio-data', {
          from: socket.id,
          data: payload.data,
          sampleRate: payload.sampleRate,
          timestamp: payload.timestamp,
          mediaTs: payload.mediaTs,
          encoded: payload.encoded,
        });
      } catch (err) {
        console.error('[voice-audio-data] error:', err);
      }
    });

    // --- 语音编解码器配置转发 ---
    socket.on('voice-codec-config', (payload: { roomId: string; description: ArrayBuffer }) => {
      try {
        const members = voiceMembers.get(payload.roomId);
        if (!members) return;
        let isMember = false;
        for (const entry of members.values()) {
          if (entry.socketId === socket.id) {
            isMember = true;
            break;
          }
        }
        if (!isMember) return;
        // 被禁言者的编码配置同样不转发（无音频可解码）
        const mutedSet = voiceMutedKeys.get(payload.roomId);
        if (mutedSet?.has(memberKeyOf(socket))) return;

        socket.to(payload.roomId).emit('voice-codec-config', {
          from: socket.id,
          description: payload.description,
        });
      } catch (err) {
        console.error('[voice-codec-config] error:', err);
      }
    });

    // ==================== 语音管理（房主/房管） ====================

    // --- 语音禁言 / 解禁 ---
    socket.on(
      'voice-mute',
      async (
        payload: { roomId: string; socketId: string; muted: boolean },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const { roomId } = payload;
          if (!(await roomPermissionService.isRoomHostOrModerator(socket, roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主或房管可操作' });
          }

          // 定位目标成员条目
          const members = voiceMembers.get(roomId);
          if (!members) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }
          let target: VoiceMemberEntry | null = null;
          for (const entry of members.values()) {
            if (entry.socketId === payload.socketId) {
              target = entry;
              break;
            }
          }
          if (!target) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }

          // 房管不可操作房主/其他房管（防篡权）
          const isHost = await roomPermissionService.isRoomHost(socket, roomId);
          if (!isHost) {
            const [room, moderators] = await Promise.all([
              AppDataSource.getRepository(Room).findOneBy({ roomId }),
              roomPermissionService.getModerators(roomId),
            ]);
            if (target.userId > 0 && room && room.ownerUserId === target.userId) {
              return callback?.({ success: false, message: '不能对房主操作' });
            }
            if (target.userId > 0 && moderators.includes(target.userId)) {
              return callback?.({ success: false, message: '不能对房管操作' });
            }
          }

          const targetKey =
            target.userId > 0 ? `user:${target.userId}` : `socket:${target.socketId}`;
          await loadVoiceMuted(roomId);
          const mutedSet = voiceMutedKeys.get(roomId) ?? new Set<string>();
          if (payload.muted) {
            mutedSet.add(targetKey);
          } else {
            mutedSet.delete(targetKey);
          }
          voiceMutedKeys.set(roomId, mutedSet);

          // 登录用户的禁言持久化（刷新/重进后仍生效）
          if (target.userId > 0) {
            await persistVoiceMuted(roomId);
          }

          // 通知房间内所有成员（前端更新禁言标记与提示）
          io.to(roomId).emit('voice-muted-changed', {
            socketId: target.socketId,
            userId: target.userId,
            username: target.username,
            muted: payload.muted,
          });

          callback?.({ success: true });
        } catch (err) {
          console.error('[voice-mute] error:', err);
          callback?.({ success: false, message: '操作失败' });
        }
      },
    );

    // --- 踢出语音 ---
    socket.on(
      'voice-kick',
      async (
        payload: { roomId: string; socketId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const { roomId } = payload;
          if (!(await roomPermissionService.isRoomHostOrModerator(socket, roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主或房管可操作' });
          }

          const members = voiceMembers.get(roomId);
          if (!members) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }
          let target: VoiceMemberEntry | null = null;
          let targetKey = '';
          for (const [key, entry] of members) {
            if (entry.socketId === payload.socketId) {
              target = entry;
              targetKey = key;
              break;
            }
          }
          if (!target) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }

          // 房管不可操作房主/其他房管（防篡权）
          const isHost = await roomPermissionService.isRoomHost(socket, roomId);
          if (!isHost) {
            const [room, moderators] = await Promise.all([
              AppDataSource.getRepository(Room).findOneBy({ roomId }),
              roomPermissionService.getModerators(roomId),
            ]);
            if (target.userId > 0 && room && room.ownerUserId === target.userId) {
              return callback?.({ success: false, message: '不能对房主操作' });
            }
            if (target.userId > 0 && moderators.includes(target.userId)) {
              return callback?.({ success: false, message: '不能对房管操作' });
            }
          }

          // 通知被踢者（前端自动断开采集与 UI 状态）
          io.to(target.socketId).emit('voice-kicked', { roomId });
          // 移除成员并广播离开
          removeMember(io, roomId, targetKey);
          // 冷却期内禁止重新加入（防反复骚扰）
          voiceKickCooldown.set(targetKey, Date.now() + VOICE_KICK_COOLDOWN_MS);

          callback?.({ success: true });
        } catch (err) {
          console.error('[voice-kick] error:', err);
          callback?.({ success: false, message: '操作失败' });
        }
      },
    );

    // --- 断开连接时自动清理语音聊天状态 ---
    socket.on('disconnect', () => {
      for (const roomId of Array.from(socket.rooms)) {
        if (roomId === socket.id) continue;
        removeBySocketId(io, socket, roomId);
      }
    });
  }
}
