/**
 * 语音聊天处理器（服务器中转）。
 *
 * 职责：管理房间内语音聊天成员状态，中转 PCM/Opus 音频数据。
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
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../socket';

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
}

/**
 * 每个房间的语音成员：roomId → (身份键 → 条目)。
 * 身份键：登录用户 `user:{userId}`；游客 `socket:{socketId}`（token 层
 * 游客完全同质（userId=0/username='guest'），无法以 userId 区分，退化为
 * 每连接身份）。
 */
const voiceMembers = new Map<string, Map<string, VoiceMemberEntry>>();

/** 幽灵扫描间隔 */
const GHOST_SWEEP_INTERVAL_MS = 15_000;

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
 * 从房间的语音成员中移除指定身份键的条目，并广播离开事件。
 */
function removeMember(
  io: SocketIOServer,
  roomId: string,
  key: string,
): void {
  const members = voiceMembers.get(roomId);
  if (!members) return;
  const entry = members.get(key);
  if (!entry) return;

  members.delete(key);
  if (members.size === 0) {
    voiceMembers.delete(roomId);
  }
  io.to(roomId).emit('voice-user-left', toInfo(entry));
  console.log(`[voice] ${entry.username}(${key}) left room ${roomId}`);
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
 */
function sweepGhosts(io: SocketIOServer): void {
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
}

export class VoiceChatHandler implements SocketEventHandler {
  readonly name = 'voice-chat';
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  register(socket: Socket, io: SocketIOServer): void {
    // 首个 socket 注册时启动幽灵扫描（handler 为单例，重复调用幂等）
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => sweepGhosts(io), GHOST_SWEEP_INTERVAL_MS);
      // setInterval 不阻止进程退出
      this.sweepTimer.unref?.();
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
        const { roomId } = payload;
        if (!isSocketInRoom(socket, roomId)) {
          return callback?.({ success: false, message: '不在该房间中' });
        }

        const key = memberKeyOf(socket);
        const userId: number = socket.data?.userId ?? 0;
        // 显示名：登录用户取 token 中的真实用户名；游客退化为客户端提供的昵称
        const tokenUsername: string | undefined = socket.data?.username;
        const username =
          (userId > 0 && tokenUsername) || payload.username || '游客';

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

        callback?.({
          success: true,
          members: [...members.values()]
            .filter((m) => m.socketId !== socket.id)
            .map(toInfo),
        });
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
        let isMember = false;
        for (const entry of members.values()) {
          if (entry.socketId === socket.id) {
            isMember = true;
            break;
          }
        }
        if (!isMember) return;

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

        socket.to(payload.roomId).emit('voice-codec-config', {
          from: socket.id,
          description: payload.description,
        });
      } catch (err) {
        console.error('[voice-codec-config] error:', err);
      }
    });

    // --- 断开连接时自动清理语音聊天状态 ---
    socket.on('disconnect', () => {
      for (const roomId of Array.from(socket.rooms)) {
        if (roomId === socket.id) continue;
        removeBySocketId(io, socket, roomId);
      }
    });
  }
}
