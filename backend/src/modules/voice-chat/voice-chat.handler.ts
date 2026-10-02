/**
 * 语音聊天处理器（服务器中转 + 语音媒体专用连接）。
 *
 * 职责：管理房间内语音聊天成员状态，中转 Opus/PCM 音频数据，
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
 * - 音频路由以主连接 socketId 为准（voice-media-data 的 from 字段），
 *   顶替/离开时广播旧 socketId 供接收端清理播放链路。
 * - 幽灵兜底：定时扫描成员的 socketId 是否仍存在于 io.sockets.sockets
 *   （连接权威状态），不存在即强制移除——不依赖 disconnect 事件是否触发，
 *   静音用户（不发音频包）不受影响。
 *
 * 语音媒体专用连接（v4，低而稳的延迟）：
 * - 语音帧走独立的 Socket.IO 连接（客户端 transports=['websocket'] 直连），
 *   与主连接上的聊天/弹幕/信令完全隔离——TCP 队头阻塞下，一条数 MB 的
 *   业务消息（如字幕同步）不再能把 20ms 的音频帧顶在后面排队秒级延迟。
 * - 绑定：voice-join 应答下发一次性 mediaToken，客户端在媒体连接上发
 *   voice-media-init{roomId, token} 完成绑定（服务端校验 token→成员），
 *   媒体连接加入 voice:{roomId} 房间；主连接不进该房间，音频不会重复下发。
 * - 下行按目标逐个发送并检查对端 TCP 写缓冲：慢消费者（收包停滞）跳过
 *   当前帧，防止服务器内存无限堆积与该端延迟单调恶化（UDP 丢包语义的
 *   应用层等价物）。上行丢帧由客户端背压（bufferedAmount）承担。
 * - 传输层：engine.io 默认关闭 permessage-deflate、ws 库对每条连接无条件
 *   setNoDelay(true)（禁 Nagle）——小帧低延迟的两项关键传输配置无需额外设置。
 *
 * 语音多实例（v5，仅供测试）：
 * - 客户端开关（仅测试用途）：开启后每个浏览器标签页以独立 instanceId
 *   （sessionStorage 持有）加入语音，成员键为 user:{userId}#{instanceId}，
 *   同一登录账号的多个页面互不顶替、作为独立成员存在。
 * - 禁言集合（含 Room.voiceMuted 持久化）始终以基础身份键
 *   user:{userId} 存储（baseVoiceKey 归一化）——禁言与实例无关，
 *   同账号所有页面一并生效。
 * - 游客本就按连接（socket:{socketId}）区分，instanceId 忽略。
 *
 * 语音管理（v3）：
 * - voice-mute / voice-unmute：禁言期间服务器中转层直接丢弃该成员的
 *   voice-media-data / voice-codec-config（服务器侧强制，客户端无法绕过），
 *   被禁言者仍可收听。登录用户按 userId 持久化（Room.voiceMuted），
 *   游客为会话级（内存，按 socketId）。
 * - voice-kick：移出语音频道并通知被踢者（前端自动断开采集）；
 *   60s 冷却期内禁止重新加入（防反复骚扰），内存记录。
 * - 权限：房主或房管（roomPermissionService.isRoomHostOrModerator）；
 *   房管不可操作房主/其他房管。
 */
import { randomBytes } from 'crypto';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import type { SocketEventHandler } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { getSystemSettings } from '../../services/system-settings';
import { voiceSfu } from './voice-sfu';

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
  /** 语音媒体连接绑定令牌（voice-join 应答下发，voice-media-init 校验） */
  mediaToken: string;
  /** 已绑定的媒体专用连接 socket id（媒体连接断开后清除） */
  mediaSocketId?: string;
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
 * socketId → 成员定位（roomId + 身份键）反向索引。
 * 音频/配置包每秒 50 次/成员到达，凭此 O(1) 校验成员身份，
 * 避免每包线性扫描成员表。与 voiceMembers 同生命周期维护。
 */
const socketIndex = new Map<string, { roomId: string; key: string }>();

/**
 * 媒体专用连接 socketId → 成员定位（roomId + 身份键）反向索引。
 * 媒体连接是独立 socket（有自己的 id），凭此 O(1) 将上行音频归属到成员。
 */
const mediaSocketIndex = new Map<string, { roomId: string; key: string }>();

/** 语音媒体房间名：媒体专用连接加入，主连接不加入（音频不重复下发） */
function voiceRoomOf(roomId: string): string {
  return `voice:${roomId}`;
}

/** 服务器下行慢消费者阈值：对端 TCP 写缓冲超过此字节数则跳过当前帧 */
const SERVER_DOWNLINK_LIMIT_BYTES = 128 * 1024;

/**
 * 读取某 socket 底层 engine.io WebSocket 的未发送积压字节数。
 * 非 WebSocket transport 或访问失败时返回 0（不丢帧）
 */
function getServerDownlinkBacklog(socket: Socket): number {
  try {
    const conn = socket.conn as unknown as {
      transport?: { socket?: { bufferedAmount?: number } };
    };
    return conn.transport?.socket?.bufferedAmount ?? 0;
  } catch {
    return 0;
  }
}

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
 * 剥离多实例后缀：user:{userId}#{instanceId} → user:{userId}。
 * 禁言集合（含持久化）始终以基础身份键存储——禁言与实例无关，
 * 同账号所有页面一并生效。
 */
function baseVoiceKey(key: string): string {
  const hash = key.indexOf('#');
  return hash === -1 ? key : key.slice(0, hash);
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
  socketIndex.delete(entry.socketId);
  // 关闭该成员的 SFU WebRtcTransport（连带 producer/consumers；空房间关 Router）
  voiceSfu.closePeer(roomId, key);
  // 同步断开已绑定的媒体专用连接（客户端重进语音时会重建并重新绑定）
  if (entry.mediaSocketId) {
    mediaSocketIndex.delete(entry.mediaSocketId);
    io.sockets.sockets.get(entry.mediaSocketId)?.disconnect(true);
  }
  if (members.size === 0) {
    voiceMembers.delete(roomId);
  }
  io.to(roomId).emit('voice-user-left', toInfo(entry));
  console.log(`[voice] ${entry.username}(${key}) left room ${roomId}`);
  return entry;
}

/**
 * 按 socketId 移除成员（voice-leave / disconnect 清理路径）。
 * 经反向索引 O(1) 定位，无需扫描成员表。
 */
function removeBySocketId(io: SocketIOServer, socket: Socket, roomId: string): void {
  const idx = socketIndex.get(socket.id);
  if (!idx || idx.roomId !== roomId) return;
  removeMember(io, roomId, idx.key);
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
        continue;
      }
      // 媒体专用连接已死（静音成员不产生音频断连感知）：解除绑定，
      // 客户端重连后会以同一 token 重新 voice-media-init
      if (
        entry.mediaSocketId &&
        !io.sockets.sockets.has(entry.mediaSocketId)
      ) {
        mediaSocketIndex.delete(entry.mediaSocketId);
        entry.mediaSocketId = undefined;
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
        payload: {
          roomId: string;
          username?: string;
          /** 多实例（仅供测试）：每标签页独立实例 ID，派生独立成员键 */
          instanceId?: string;
        },
        callback?: (
          response:
            | {
                success: true;
                members: VoiceMemberInfo[];
                selfMuted?: boolean;
                /** 语音媒体专用连接绑定令牌（voice-media-init 校验用） */
                mediaToken: string;
                /** mediasoup Router RTP 能力（SFU 传输层 Device.load 用） */
                sfuRtpCapabilities?: unknown;
              }
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
          // 多实例（仅供测试，系统设置 roomMultiInstanceLogin 开启时生效）：
          // 登录用户附带每标签页独立的 instanceId 时，成员键退化为
          // user:{userId}#{instanceId}——同一账号的多个页面互不顶替，
          // 作为独立语音成员存在。游客本就按连接区分，忽略
          const settings = await getSystemSettings();
          const instanceId =
            settings.roomMultiInstanceLogin === true &&
            userId > 0 &&
            typeof payload.instanceId === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/.test(payload.instanceId)
              ? payload.instanceId
              : '';
          const memberKey = instanceId ? `${key}#${instanceId}` : key;
          // 显示名：登录用户取 token 中的真实用户名；游客退化为客户端提供的昵称
          const tokenUsername: string | undefined = socket.data?.username;
          const username =
            (userId > 0 && tokenUsername) || payload.username || '游客';

          // 踢出冷却检查（多实例模式下按实例键隔离：踢一个实例只冷却该页面）
          const cooldownUntil = voiceKickCooldown.get(memberKey);
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

          const existing = members.get(memberKey);
          if (existing && existing.socketId === socket.id) {
            // 幂等重入：已用同一连接加入
            const mutedSet = voiceMutedKeys.get(roomId);
            return callback?.({
              success: true,
              members: [...members.values()]
                .filter((m) => m.socketId !== socket.id)
                .map((m) => ({
                  ...toInfo(m),
                  muted:
                    mutedSet?.has(
                      m.userId > 0 ? `user:${m.userId}` : `socket:${m.socketId}`,
                    ) ?? false,
                })),
              selfMuted: mutedSet?.has(baseVoiceKey(memberKey)) ?? false,
              // 已有令牌原样下发（媒体连接可重复 init 绑定）
              mediaToken: existing.mediaToken,
              sfuRtpCapabilities: await voiceSfu
                .getRouterRtpCapabilities(roomId)
                .catch(() => undefined),
            });
          }

          if (existing) {
            // 同一用户重连（socket.id 已变化）：顶替旧条目。
            // 广播旧 socketId 的离开事件，供接收端清理旧播放链路
            removeMember(io, roomId, memberKey);
          }

          const entry: VoiceMemberEntry = {
            socketId: socket.id,
            userId,
            username,
            joinedAt: Date.now(),
            // 一次性媒体绑定令牌：仅持有者可将其媒体连接绑定为该成员
            mediaToken: randomBytes(16).toString('hex'),
          };
          members.set(memberKey, entry);
          socketIndex.set(socket.id, { roomId, key: memberKey });
          socket.to(roomId).emit('voice-user-joined', toInfo(entry));
          console.log(`[voice] ${username}(${memberKey}) joined room ${roomId}`);

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
            // 自己的禁言状态（登录用户持久化，重进房间仍生效；按基础
            // 身份键判定——禁言与实例无关）
            selfMuted: mutedSet?.has(baseVoiceKey(memberKey)) ?? false,
            // 媒体专用连接绑定令牌
            mediaToken: entry.mediaToken,
            // mediasoup Router RTP 能力（SFU 传输层；失败时 undefined，
            // 前端据此回退 WebSocket 传输管线）
            sfuRtpCapabilities: await voiceSfu
              .getRouterRtpCapabilities(roomId)
              .catch(() => undefined),
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

    // --- 语音媒体专用连接绑定 ---
    // 媒体连接（客户端第二个 Socket.IO 连接，仅 WebSocket 传输）以
    // voice-join 应答下发的 mediaToken 绑定到成员，避免按主连接 socketId
    // 伪造他人身份上行。同一 token 重复 init（媒体连接自动重连）直接复用
    socket.on(
      'voice-media-init',
      (
        payload: { roomId: string; token: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        const members = voiceMembers.get(payload.roomId);
        if (!members) {
          return callback?.({ success: false, message: '未在该房间语音中' });
        }
        let matched: { key: string; entry: VoiceMemberEntry } | undefined;
        for (const [key, e] of members.entries()) {
          if (e.mediaToken === payload.token) {
            matched = { key, entry: e };
            break;
          }
        }
        if (!matched) {
          return callback?.({ success: false, message: '媒体绑定令牌无效' });
        }

        // 顶替旧媒体连接（自动重连前残留的绑定）
        const { key, entry } = matched;
        if (entry.mediaSocketId && entry.mediaSocketId !== socket.id) {
          mediaSocketIndex.delete(entry.mediaSocketId);
        }
        entry.mediaSocketId = socket.id;
        mediaSocketIndex.set(socket.id, { roomId: payload.roomId, key });
        socket.join(voiceRoomOf(payload.roomId));
        callback?.({ success: true });
      },
    );

    // --- 语音音频数据中转（媒体专用连接） ---
    socket.on('voice-media-data', (payload: {
      data: ArrayBuffer;
      sampleRate?: number;
      timestamp: number;
      mediaTs?: number;
      encoded?: boolean;
    }) => {
      try {
        // O(1) 校验发送者确为已绑定的语音媒体连接（反向索引）
        const idx = mediaSocketIndex.get(socket.id);
        if (!idx) return;
        const entry = voiceMembers.get(idx.roomId)?.get(idx.key);
        if (!entry) return;

        // 语音禁言：服务器侧直接丢弃（客户端无法绕过），仍可收听。
        // 禁言集合按基础身份键存储（与实例无关）
        const mutedSet = voiceMutedKeys.get(idx.roomId);
        if (mutedSet?.has(baseVoiceKey(idx.key))) return;

        const out = {
          // 音频路由 key 恒为主连接 socketId（成员身份标识，接收端
          // 据此挂播放链路；媒体连接 id 仅服务端内部使用）
          from: entry.socketId,
          data: payload.data,
          sampleRate: payload.sampleRate,
          timestamp: payload.timestamp,
          mediaTs: payload.mediaTs,
          encoded: payload.encoded,
        };

        // 逐目标发送（不用 socket.to 广播）：下行需按对端写缓冲丢帧。
        // 不用 volatile：中转丢帧无法恢复（播放实时消耗、发送实时生产），
        // 只会持续排空接收端 jitter buffer 造成频繁 underrun。排队的
        // 突发延迟由接收端 jitter buffer 吸收，仅慢消费者按缓冲丢帧
        const targets = io.sockets.adapter.rooms.get(voiceRoomOf(idx.roomId));
        if (!targets) return;
        for (const sid of targets) {
          if (sid === socket.id) continue;
          const target = io.sockets.sockets.get(sid);
          if (!target) continue;
          // 慢消费者（TCP 收包停滞）：跳过当前帧。否则服务器发送缓冲
          // 无限堆积（内存 + 该端延迟单调恶化），UDP 丢包语义的等价物
          if (getServerDownlinkBacklog(target) > SERVER_DOWNLINK_LIMIT_BYTES) {
            continue;
          }
          target.emit('voice-media-data', out);
        }
      } catch (err) {
        console.error('[voice-media-data] error:', err);
      }
    });

    // --- 语音编解码器配置转发 ---
    socket.on('voice-codec-config', (payload: { roomId: string; description: ArrayBuffer }) => {
      try {
        // O(1) 校验成员身份（反向索引）
        const idx = socketIndex.get(socket.id);
        if (!idx || idx.roomId !== payload.roomId) return;
        // 被禁言者的编码配置同样不转发（无音频可解码）。禁言按基础身份键
        const mutedSet = voiceMutedKeys.get(payload.roomId);
        if (mutedSet?.has(baseVoiceKey(idx.key))) return;

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

          // 经反向索引 O(1) 定位目标成员
          const members = voiceMembers.get(roomId);
          const targetIdx = socketIndex.get(payload.socketId);
          if (!members || !targetIdx || targetIdx.roomId !== roomId) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }
          const target = members.get(targetIdx.key);
          if (!target) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }

          // 房管不可操作房主/其他房管/root（防篡权，统一走 canModeratorActOn）
          if (!(await roomPermissionService.isRoomHost(socket, roomId))) {
            const denial = await roomPermissionService.canModeratorActOn(
              roomId,
              target.userId > 0 ? target.userId : undefined,
            );
            if (denial) {
              return callback?.({ success: false, message: denial });
            }
          }

          await loadVoiceMuted(roomId);
          const mutedSet = voiceMutedKeys.get(roomId) ?? new Set<string>();
          // 禁写基础身份键（剥多实例后缀）：同账号所有页面一并生效
          const targetBaseKey = baseVoiceKey(targetIdx.key);
          if (payload.muted) {
            mutedSet.add(targetBaseKey);
          } else {
            mutedSet.delete(targetBaseKey);
          }
          voiceMutedKeys.set(roomId, mutedSet);

          // 登录用户的禁言持久化（刷新/重进后仍生效）
          if (target.userId > 0) {
            await persistVoiceMuted(roomId);
          }

          // SFU 层强制禁言：暂停该成员的上行 Producer（RTP 直接停止，
          // 客户端无法绕过；解禁时恢复）
          voiceSfu.setPeerMuted(roomId, targetIdx.key, payload.muted);

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

          // 经反向索引 O(1) 定位目标成员
          const members = voiceMembers.get(roomId);
          const targetIdx = socketIndex.get(payload.socketId);
          if (!members || !targetIdx || targetIdx.roomId !== roomId) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }
          const target = members.get(targetIdx.key);
          if (!target) {
            return callback?.({ success: false, message: '目标不在语音中' });
          }

          // 房管不可操作房主/其他房管/root（防篡权，统一走 canModeratorActOn）
          if (!(await roomPermissionService.isRoomHost(socket, roomId))) {
            const denial = await roomPermissionService.canModeratorActOn(
              roomId,
              target.userId > 0 ? target.userId : undefined,
            );
            if (denial) {
              return callback?.({ success: false, message: denial });
            }
          }

          // 通知被踢者（前端自动断开采集与 UI 状态）
          io.to(target.socketId).emit('voice-kicked', { roomId });
          // 移除成员并广播离开（removeMember 内部同步清理反向索引）
          removeMember(io, roomId, targetIdx.key);
          // 冷却期内禁止重新加入（防反复骚扰）
          voiceKickCooldown.set(targetIdx.key, Date.now() + VOICE_KICK_COOLDOWN_MS);

          callback?.({ success: true });
        } catch (err) {
          console.error('[voice-kick] error:', err);
          callback?.({ success: false, message: '操作失败' });
        }
      },
    );

    // --- mediasoup SFU 信令（v6 传输层；仅做低频 offer/answer/ICE 与轨管理） ---
    socket.on(
      'voice-sfu-rtp-capabilities',
      (
        payload: { roomId: string },
        callback?: (r: {
          success: boolean;
          rtpCapabilities?: unknown;
          message?: string;
        }) => void,
      ) => {
        if (!isSocketInRoom(socket, payload.roomId)) {
          return callback?.({ success: false, message: '不在该房间中' });
        }
        voiceSfu
          .getRouterRtpCapabilities(payload.roomId)
          .then((rtpCapabilities) => callback?.({ success: true, rtpCapabilities }))
          .catch((err) => {
            console.error('[voice-sfu-rtp-capabilities] error:', err);
            callback?.({ success: false, message: '获取 RTP 能力失败' });
          });
      },
    );

    socket.on(
      'voice-sfu-create-transport',
      (
        payload: { roomId: string },
        callback?: (r: {
          success: boolean;
          sendTransport?: unknown;
          recvTransport?: unknown;
          message?: string;
        }) => void,
      ) => {
        const idx = socketIndex.get(socket.id);
        if (!idx || idx.roomId !== payload.roomId) {
          return callback?.({ success: false, message: '未加入该房间语音' });
        }
        const entry = voiceMembers.get(idx.roomId)?.get(idx.key);
        voiceSfu
          .createPeerTransports(
            idx.roomId,
            idx.key,
            entry?.username ?? '成员',
            entry?.socketId ?? socket.id
          )
          .then(({ sendTransport, recvTransport }) =>
            callback?.({ success: true, sendTransport, recvTransport })
          )
          .catch((err) => {
            console.error('[voice-sfu-create-transport] error:', err);
            callback?.({ success: false, message: '创建传输失败' });
          });
      },
    );

    socket.on(
      'voice-sfu-connect-transport',
      (
        payload: {
          roomId: string;
          which: 'send' | 'recv';
          dtlsParameters: unknown;
        },
        callback?: (r: { success: boolean; message?: string }) => void,
      ) => {
        const idx = socketIndex.get(socket.id);
        if (!idx || idx.roomId !== payload.roomId) {
          return callback?.({ success: false, message: '未加入该房间语音' });
        }
        voiceSfu
          .connectPeerTransport(
            idx.roomId,
            idx.key,
            payload.which === 'recv' ? 'recv' : 'send',
            payload.dtlsParameters as never
          )
          .then(() => {
            console.log(
              `[voice-sfu] transport connected (${payload.which}): ${idx.key}`
            );
            callback?.({ success: true });
          })
          .catch((err) => {
            console.error('[voice-sfu-connect-transport] error:', err);
            callback?.({ success: false, message: 'DTLS 连接失败' });
          });
      },
    );

    // 上行产生音频轨。应答同时回带同房间其他成员的现有轨列表，
    // 新成员一次往返即可消费全部现有音频
    socket.on(
      'voice-sfu-produce',
      (
        payload: { roomId: string; rtpParameters: unknown },
        callback?: (r: {
          success: boolean;
          producerId?: string;
          existingProducers?: Array<{
            producerId: string;
            memberKey: string;
            username: string;
          }>;
          message?: string;
        }) => void,
      ) => {
        const idx = socketIndex.get(socket.id);
        if (!idx || idx.roomId !== payload.roomId) {
          return callback?.({ success: false, message: '未加入该房间语音' });
        }
        voiceSfu
          .produceAudio(
            idx.roomId,
            idx.key,
            payload.rtpParameters as never
          )
          .then(({ producerId }) => {
            // 服务器侧禁言强制补位：成员被禁言后重新 produce（重连/重入）
            // 时新轨默认未暂停，必须立即暂停，否则禁言被绕过
            const mutedSet = voiceMutedKeys.get(idx.roomId);
            if (mutedSet?.has(baseVoiceKey(idx.key))) {
              voiceSfu.setPeerMuted(idx.roomId, idx.key, true);
              console.log(
                `[voice-sfu] producer paused (admin-muted): ${idx.key}`
              );
            }
            const existingProducers = voiceSfu.listProducers(
              idx.roomId,
              idx.key
            );
            // 通知房间内其他成员消费新轨
            const entry = voiceMembers.get(idx.roomId)?.get(idx.key);
            console.log(
              `[voice-sfu] produced: ${entry?.username ?? '成员'}(${idx.key}) producer=${producerId} existing=${existingProducers.length}`
            );
            socket.to(idx.roomId).emit('voice-sfu-new-producer', {
              roomId: idx.roomId,
              producerId,
              memberKey: idx.key,
              username: entry?.username ?? '成员',
              socketId: entry?.socketId ?? socket.id,
            });
            callback?.({ success: true, producerId, existingProducers });
          })
          .catch((err) => {
            console.error('[voice-sfu-produce] error:', err);
            callback?.({ success: false, message: '发布音频轨失败' });
          });
      },
    );

    // 消费指定上行轨（应答附带生产者归属成员，前端按成员挂 <audio>）
    socket.on(
      'voice-sfu-consume',
      (
        payload: { roomId: string; producerId: string; rtpCapabilities: unknown },
        callback?: (r: {
          success: boolean;
          consumerId?: string;
          producerId?: string;
          kind?: string;
          rtpParameters?: unknown;
          producerMemberKey?: string;
          producerUsername?: string;
          message?: string;
        }) => void,
      ) => {
        const idx = socketIndex.get(socket.id);
        if (!idx || idx.roomId !== payload.roomId) {
          return callback?.({ success: false, message: '未加入该房间语音' });
        }
        voiceSfu
          .consumeFrom(
            idx.roomId,
            idx.key,
            payload.producerId,
            payload.rtpCapabilities as never
          )
          .then((result) => {
            if (result) {
              console.log(
                `[voice-sfu] consumed: ${idx.key} <- ${result.producerMemberKey} consumer=${result.consumerId}`
              );
            } else {
              console.warn(
                `[voice-sfu] consume 未找到目标 producer=${payload.producerId}（请求方 ${idx.key}）`
              );
            }
            callback?.({ success: true, ...(result ?? {}) as object });
          })
          .catch((err) => {
            console.error('[voice-sfu-consume] error:', err);
            callback?.({ success: false, message: '订阅音频轨失败' });
          });
      },
    );

    socket.on(
      'voice-sfu-resume-consumer',
      (payload: { roomId: string; consumerId: string }) => {
        const idx = socketIndex.get(socket.id);
        if (!idx || idx.roomId !== payload.roomId) return;
        voiceSfu.resumeConsumer(idx.roomId, idx.key, payload.consumerId);
      },
    );

    // --- 断开连接时自动清理语音聊天状态 ---
    socket.on('disconnect', () => {
      // 媒体专用连接断开：解除绑定（成员仍在语音中，客户端自动重连后
      // 会以同一 token 重新 voice-media-init）
      const mediaIdx = mediaSocketIndex.get(socket.id);
      if (mediaIdx) {
        mediaSocketIndex.delete(socket.id);
        const entry = voiceMembers.get(mediaIdx.roomId)?.get(mediaIdx.key);
        if (entry && entry.mediaSocketId === socket.id) {
          entry.mediaSocketId = undefined;
        }
        return;
      }
      for (const roomId of Array.from(socket.rooms)) {
        if (roomId === socket.id) continue;
        removeBySocketId(io, socket, roomId);
      }
    });
  }
}
