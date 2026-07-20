import { Server as SocketIOServer, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../data-source';
import { Room } from '../entities/Room';
import { Session } from '../entities/Session';
import { User } from '../entities/User';
import type { UserRole } from '../entities/User';
import {
  type Movie,
  getRoomState,
  getRoomPlayback,
  closeRoomAndNotify,
  hostReconnectTimers,
  HOST_RECONNECT_GRACE_MS,
} from '../services/room/state';
import { isRoomHost } from '../services/room/permissions';
import {
  handleWatchTogetherState,
  handleWatchTogetherControl,
  handleWatchTogetherRequestState,
  handleHostHeartbeat,
  handleTrackChange,
} from '../services/room/sync';
import { registerScreenSharingHandlers } from '../services/screen-sharing';
import { registerStreamPushHandlers } from '../services/stream-push';

// 在 io 上注册所有房间相关的 Socket 事件处理器
// 内部注册 io.on('connection', ...) 连接处理器，所有房间事件均在该处理器内注册
export function registerRoomHandlers(io: SocketIOServer): void {
  registerScreenSharingHandlers(io);
  registerStreamPushHandlers(io);
  io.on('connection', (socket) => {
    console.log(`[room] Socket connected: ${socket.id}`);

    // --- 房主注册：用于断线重连后恢复房主身份 ---
    socket.on(
      'register-host',
      async (
        payload: { roomId: string },
        callback: (response: {
          success: boolean;
          message?: string;
          mode?: 'screen-share' | 'watch-together';
          shareMethod?: 'webrtc' | 'stream-push';
          name?: string | null;
          playback?: {
            currentTime: number;
            isPlaying: boolean;
            playbackRate: number;
            duration?: number;
            sourceUrl?: string;
            sourceType?: string;
            audioUrl?: string;
            // 与 services/mediaFormat.ts 的 MediaFormat 对齐
            format?: string;
            videoCodec?: string;
            audioCodec?: string;
            cid?: number;
            currentQn?: number;
            currentMovieId?: number;
            updatedAt: number;
          };
        }) => void,
      ) => {
        try {
          const userId: number = socket.data.userId;
          const role: UserRole = socket.data.role;
          if (role !== 'root' && role !== 'admin') {
            return callback({
              success: false,
              message: '无权限：仅管理员可注册为房主',
            });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const sessionRepo = AppDataSource.getRepository(Session);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });

          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }
          if (room.status !== 'active') {
            return callback({ success: false, message: '房间已关闭' });
          }
          if (
            role !== 'root' &&
            room.ownerUserId !== null &&
            room.ownerUserId !== userId
          ) {
            return callback({
              success: false,
              message: '无权限：仅 root 可接管他人创建的房间',
            });
          }

          // 取消可能存在的关闭房间定时器
          const timer = hostReconnectTimers.get(payload.roomId);
          if (timer) {
            clearTimeout(timer);
            hostReconnectTimers.delete(payload.roomId);
          }

          const existingSharer = await sessionRepo.findOne({
            where: { roomId: payload.roomId, role: 'sharer' },
            order: { startedAt: 'DESC' },
          });

          if (existingSharer) {
            existingSharer.socketId = socket.id;
            existingSharer.endedAt = null;
            await sessionRepo.save(existingSharer);
          } else {
            const sharerSession = sessionRepo.create({
              roomId: payload.roomId,
              socketId: socket.id,
              role: 'sharer',
            });
            await sessionRepo.save(sharerSession);
          }

          await roomRepo.update(
            { roomId: payload.roomId },
            { lastAccessedAt: new Date() },
          );

          socket.join(payload.roomId);

          // 房主刷新/重连恢复：返回最近一次持久化的播放状态，由前端应用并强制暂停
          // 仅 watch-together 模式且存在 playback 时返回
          const playback =
            room.mode === 'watch-together'
              ? getRoomPlayback(payload.roomId)
              : undefined;

          callback({ success: true, mode: room.mode, shareMethod: room.shareMethod, name: room.name, playback });
        } catch (err) {
          console.error('register-host error:', err);
          callback({ success: false, message: '恢复房主身份失败' });
        }
      },
    );

    // --- 观众请求加入房间 ---
    socket.on(
      'request-join',
      async (
        payload: { roomId: string; password?: string },
        callback: (response: {
          success: boolean;
          message?: string;
          mode?: 'screen-share' | 'watch-together';
          shareMethod?: 'webrtc' | 'stream-push';
        }) => void,
      ) => {
        try {
          const roomRepo = AppDataSource.getRepository(Room);
          const sessionRepo = AppDataSource.getRepository(Session);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });

          if (!room) {
            return callback({ success: false, message: '房间不存在' });
          }
          if (room.status !== 'active') {
            return callback({ success: false, message: '房间已关闭' });
          }
          const role: UserRole = socket.data.role;
          if (
            role !== 'root' &&
            room.password &&
            room.password !== (payload.password ?? '')
          ) {
            return callback({ success: false, message: '密码错误' });
          }

          const viewerCount = await sessionRepo.count({
            where: {
              roomId: payload.roomId,
              role: 'viewer',
              endedAt: IsNull(),
            },
          });
          if (viewerCount >= room.maxViewers) {
            return callback({ success: false, message: '房间观看人数已达上限' });
          }

          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '分享端不在线' });
          }

          if (room.requireApproval === false) {
            // 免审批：直接加入房间
            socket.join(payload.roomId);

            const viewerSession = sessionRepo.create({
              roomId: payload.roomId,
              socketId: socket.id,
              role: 'viewer',
            });
            await sessionRepo.save(viewerSession);
            await roomRepo.update(
              { roomId: payload.roomId },
              { lastAccessedAt: new Date() },
            );

            io.to(socket.id).emit('join-approved', {
              roomId: payload.roomId,
              mode: room.mode,
              shareMethod: room.shareMethod,
              name: room.name,
            });

            const roomState = getRoomState(payload.roomId);
            io.to(socket.id).emit('movie-list', {
              movies: roomState.movies,
            });
            io.to(socket.id).emit('current-movie', {
              movieId: roomState.currentMovieId,
            });

            console.log(
              `[request-join] viewer=${socket.id} auto-joined room=${payload.roomId}`,
            );
            // 观众加入成功：广播给房间内所有成员（房主+其他观众），让每个客户端维护完整的在线列表。
            // 携带 userId/username/role 供房主端识别身份、执行踢人/禁言/转交房主等管理操作。
            io.to(payload.roomId).emit('viewer-joined', {
              viewerSocketId: socket.id,
              userId: socket.data.userId,
              username: socket.data.username,
              role: socket.data.role,
            });
            // 给新加入的观众发送当前已在线的其他观众列表，让其能正确显示在线人数。
            // 广播 viewer-joined 只能让其他人感知新观众，但新观众自己看不到已有的其他观众。
            const existingViewers = await sessionRepo.find({
              where: {
                roomId: payload.roomId,
                role: 'viewer',
                endedAt: IsNull(),
              },
            });
            for (const v of existingViewers) {
              if (v.socketId === socket.id) continue;
              const vSocket = io.sockets.sockets.get(v.socketId);
              io.to(socket.id).emit('viewer-joined', {
                viewerSocketId: v.socketId,
                userId: vSocket?.data?.userId,
                username: vSocket?.data?.username,
                role: vSocket?.data?.role ?? 'viewer',
              });
            }
            return callback({
              success: true,
              message: '已加入房间',
              mode: room.mode,
              shareMethod: room.shareMethod,
            });
          }

          // 需审批：转发加入请求给房主
          console.log(
            `[request-join] viewer=${socket.id} waiting approval room=${payload.roomId}`,
          );
          io.to(sharer.socketId).emit('join-request', {
            viewerSocketId: socket.id,
          });
          callback({
            success: true,
            message: '等待分享端确认',
            mode: room.mode,
            shareMethod: room.shareMethod,
          });
        } catch (err) {
          console.error('request-join error:', err);
          callback({ success: false, message: '加入房间失败' });
        }
      },
    );

    // --- 房主批准观众加入 ---
    socket.on(
      'approve-join',
      async (
        payload: { viewerSocketId: string },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = AppDataSource.getRepository(Session);
          const roomRepo = AppDataSource.getRepository(Room);
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '无权限确认' });
          }

          const viewerSocket = io.sockets.sockets.get(payload.viewerSocketId);
          if (!viewerSocket) {
            return callback({ success: false, message: '观看者已断开连接' });
          }

          const room = await roomRepo.findOneBy({ roomId: sharer.roomId });

          viewerSocket.join(sharer.roomId);

          const viewerSession = sessionRepo.create({
            roomId: sharer.roomId,
            socketId: payload.viewerSocketId,
            role: 'viewer',
          });
          await sessionRepo.save(viewerSession);
          await roomRepo.update(
            { roomId: sharer.roomId },
            { lastAccessedAt: new Date() },
          );

          io.to(payload.viewerSocketId).emit('join-approved', {
            roomId: sharer.roomId,
            mode: room?.mode ?? 'screen-share',
            shareMethod: room?.shareMethod ?? 'webrtc',
            name: room?.name ?? null,
          });

          const roomState = getRoomState(sharer.roomId);
          io.to(payload.viewerSocketId).emit('movie-list', {
            movies: roomState.movies,
          });
          io.to(payload.viewerSocketId).emit('current-movie', {
            movieId: roomState.currentMovieId,
          });

          console.log(
            `[approve-join] viewer=${payload.viewerSocketId} approved by sharer=${socket.id} room=${sharer.roomId}`,
          );
          // 观众加入成功：广播给房间内所有成员（房主+其他观众），让每个客户端维护完整的在线列表。
          // approve-join 路径下 socket 是房主，复用已查询的 viewerSocket 读取其 userId/username/role。
          io.to(sharer.roomId).emit('viewer-joined', {
            viewerSocketId: payload.viewerSocketId,
            userId: viewerSocket.data?.userId,
            username: viewerSocket.data?.username,
            role: viewerSocket.data?.role,
          });
          // 给新加入的观众发送当前已在线的其他观众列表，让其能正确显示在线人数。
          const existingViewers = await sessionRepo.find({
            where: {
              roomId: sharer.roomId,
              role: 'viewer',
              endedAt: IsNull(),
            },
          });
          for (const v of existingViewers) {
            if (v.socketId === payload.viewerSocketId) continue;
            const vSocket = io.sockets.sockets.get(v.socketId);
            io.to(payload.viewerSocketId).emit('viewer-joined', {
              viewerSocketId: v.socketId,
              userId: vSocket?.data?.userId,
              username: vSocket?.data?.username,
              role: vSocket?.data?.role ?? 'viewer',
            });
          }

          callback({ success: true });
        } catch (err) {
          console.error('approve-join error:', err);
          callback({ success: false, message: '确认失败' });
        }
      },
    );

    // --- 房主拒绝观众加入 ---
    socket.on(
      'reject-join',
      async (
        payload: { viewerSocketId: string },
        callback: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          const sessionRepo = AppDataSource.getRepository(Session);
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback({ success: false, message: '无权限拒绝' });
          }

          io.to(payload.viewerSocketId).emit('join-rejected', {
            roomId: sharer.roomId,
          });
          callback({ success: true });
        } catch (err) {
          console.error('reject-join error:', err);
          callback({ success: false, message: '拒绝失败' });
        }
      },
    );

    // --- 同步播放状态（watch-together 模式） ---
    socket.on(
      'watch-together-state',
      async (
        payload: Parameters<typeof handleWatchTogetherState>[2],
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        await handleWatchTogetherState(socket, io, payload, callback);
      },
    );

    // --- 同步播放控制（watch-together 模式） ---
    socket.on(
      'watch-together-control',
      async (
        payload: Parameters<typeof handleWatchTogetherControl>[2],
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        await handleWatchTogetherControl(socket, io, payload, callback);
      },
    );

    // --- 请求同步状态（watch-together 模式） ---
    socket.on(
      'watch-together-request-state',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        await handleWatchTogetherRequestState(socket, io, payload, callback);
      },
    );

    // --- 房主心跳（watch-together 模式） ---
    // 房主每 2s 广播心跳，后端转发给房间内观众。观众端 6s 未收到则判定房主离线。
    // 修复说明：旧版后端未注册此 handler，导致观众端必然误报"房主已离线"并暂停播放。
    socket.on(
      'host-heartbeat',
      async (
        payload: { roomId: string; currentTime: number; isPlaying: boolean },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        await handleHostHeartbeat(socket, io, payload, callback);
      },
    );

    // --- 轨道切换（watch-together 模式，合并弹幕/字幕） ---
    // 房主切换弹幕轨道或字幕轨道时广播，后端转发给房间内观众。
    // 修复说明：旧版 danmaku-track-change 与 subtitle-track-change 两个独立事件
    // 后端均未注册 handler，导致弹幕/字幕轨道同步失效。重构后合并为 track-change
    // 单事件（按 type 字段区分），此处统一转发。
    socket.on(
      'track-change',
      async (
        payload: {
          roomId: string;
          type: 'danmaku' | 'subtitle';
          value: string | number | null;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        await handleTrackChange(socket, io, payload, callback);
      },
    );

    // --- 观众申请跳转进度 ---
    // 观众拖动进度条后发送此事件，后端转发给当前房间的房主（sharer）。
    // 房主端弹确认框，接受则通过 watch-together-control/seek 广播给所有观众。
    socket.on(
      'seek-request',
      async (
        payload: { roomId: string; time: number },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }
          const sessionRepo = AppDataSource.getRepository(Session);
          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback?.({ success: false, message: '房主不在线' });
          }
          // 附加申请者信息，便于房主端显示
          io.to(sharer.socketId).emit('seek-request', {
            roomId: payload.roomId,
            viewerSocketId: socket.id,
            viewerUsername: socket.data.username,
            time: payload.time,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('[seek-request] error:', err);
          callback?.({ success: false, message: '申请跳转失败' });
        }
      },
    );

    // --- 房主回应观众的跳转申请 ---
    // accept=true 时房主端已自行 seek 并广播 state，这里仅把结果转发给申请者
    socket.on(
      'seek-response',
      async (
        payload: {
          roomId: string;
          viewerSocketId: string;
          accept: boolean;
          time?: number;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限' });
          }
          io.to(payload.viewerSocketId).emit('seek-response', {
            accept: payload.accept,
            time: payload.time,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('[seek-response] error:', err);
          callback?.({ success: false, message: '回应失败' });
        }
      },
    );

    // --- 观众申请暂停 ---
    // 观众点击「申请暂停」按钮后发送此事件，后端转发给当前房间的房主（sharer）。
    // 房主端弹确认框（或自动通过），接受则通过 watch-together-control/pause 广播给所有观众。
    socket.on(
      'pause-request',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }
          const sessionRepo = AppDataSource.getRepository(Session);
          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer) {
            return callback?.({ success: false, message: '房主不在线' });
          }
          io.to(sharer.socketId).emit('pause-request', {
            roomId: payload.roomId,
            viewerSocketId: socket.id,
            viewerUsername: socket.data.username,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('[pause-request] error:', err);
          callback?.({ success: false, message: '申请暂停失败' });
        }
      },
    );

    // --- 房主回应观众的暂停申请 ---
    // accept=true 时房主端已自行 pause 并广播 state，这里仅把结果转发给申请者
    socket.on(
      'pause-response',
      async (
        payload: {
          roomId: string;
          viewerSocketId: string;
          accept: boolean;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限' });
          }
          io.to(payload.viewerSocketId).emit('pause-response', {
            accept: payload.accept,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('[pause-response] error:', err);
          callback?.({ success: false, message: '回应失败' });
        }
      },
    );

    // --- 添加影片到房间播放列表 ---
    socket.on(
      'add-movie',
      async (
        payload: { roomId: string; movie: Movie },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (
            socket.data.role !== 'sharer' &&
            !(await isRoomHost(socket, payload.roomId))
          ) {
            return callback?.({ success: false, message: '无权限添加影片' });
          }

          const movie: Movie = {
            ...payload.movie,
            id:
              payload.movie.id ||
              `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            createdAt: payload.movie.createdAt || Date.now(),
          };

          const roomState = getRoomState(payload.roomId);
          if (!roomState.movies.some((m) => m.id === movie.id)) {
            roomState.movies.push(movie);
          }

          io.to(payload.roomId).emit('movie-list', {
            movies: roomState.movies,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('add-movie error:', err);
          callback?.({ success: false, message: '添加影片失败' });
        }
      },
    );

    // --- 从房间播放列表移除影片 ---
    socket.on(
      'remove-movie',
      async (
        payload: { roomId: string; movieId: number | string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (
            socket.data.role !== 'sharer' &&
            !(await isRoomHost(socket, payload.roomId))
          ) {
            return callback?.({ success: false, message: '无权限移除影片' });
          }

          const roomState = getRoomState(payload.roomId);
          roomState.movies = roomState.movies.filter(
            (m) =>
              m.id !== payload.movieId &&
              String(m.id) !== String(payload.movieId),
          );
          if (
            roomState.currentMovieId === payload.movieId ||
            String(roomState.currentMovieId) === String(payload.movieId)
          ) {
            roomState.currentMovieId = null;
          }

          io.to(payload.roomId).emit('movie-list', {
            movies: roomState.movies,
          });
          io.to(payload.roomId).emit('current-movie', {
            movieId: roomState.currentMovieId,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('remove-movie error:', err);
          callback?.({ success: false, message: '移除影片失败' });
        }
      },
    );

    // --- 切换当前播放的影片 ---
    socket.on(
      'play-movie',
      async (
        payload: { roomId: string; movieId: number | string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (
            socket.data.role !== 'sharer' &&
            !(await isRoomHost(socket, payload.roomId))
          ) {
            return callback?.({ success: false, message: '无权限播放影片' });
          }

          const roomState = getRoomState(payload.roomId);
          // 兼容 number/string 类型的 movieId（REST API 用 number，socket add-movie 可能用 string）
          const movie = roomState.movies.find(
            (m) =>
              m.id === payload.movieId ||
              String(m.id) === String(payload.movieId),
          );
          if (!movie) {
            return callback?.({ success: false, message: '影片不存在' });
          }

          roomState.currentMovieId = payload.movieId;
          io.to(payload.roomId).emit('current-movie', {
            movieId: roomState.currentMovieId,
          });
          callback?.({ success: true });
        } catch (err) {
          console.error('play-movie error:', err);
          callback?.({ success: false, message: '播放影片失败' });
        }
      },
    );

    // --- 请求房间播放列表 ---
    socket.on(
      'request-movie-list',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const roomState = getRoomState(payload.roomId);
          socket.emit('movie-list', { movies: roomState.movies });
          callback?.({ success: true });
        } catch (err) {
          console.error('request-movie-list error:', err);
          callback?.({ success: false, message: '获取影片列表失败' });
        }
      },
    );

    // --- 请求当前正在播放的影片 ---
    socket.on(
      'request-current-movie',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const roomState = getRoomState(payload.roomId);
          socket.emit('current-movie', { movieId: roomState.currentMovieId });
          callback?.({ success: true });
        } catch (err) {
          console.error('request-current-movie error:', err);
          callback?.({ success: false, message: '获取当前影片失败' });
        }
      },
    );

    // --- 切换房间模式（screen-share / watch-together） ---
    socket.on(
      'update-room-mode',
      async (
        payload: { roomId: string; mode: 'screen-share' | 'watch-together' },
        callback: (response: {
          success: boolean;
          message?: string;
          mode?: 'screen-share' | 'watch-together';
        }) => void,
      ) => {
        const respond = (response: {
          success: boolean;
          message?: string;
          mode?: 'screen-share' | 'watch-together';
        }) => {
          if (typeof callback === 'function') {
            callback(response);
          }
        };

        try {
          console.log(
            `[update-room-mode] start socketId=${socket.id} roomId=${payload.roomId} mode=${payload.mode}`,
          );

          const sessionRepo = AppDataSource.getRepository(Session);
          const roomRepo = AppDataSource.getRepository(Room);
          const sharer = await sessionRepo.findOneBy({
            socketId: socket.id,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (!sharer || sharer.roomId !== payload.roomId) {
            console.warn(
              `[update-room-mode] permission denied socketId=${socket.id} roomId=${payload.roomId} sharerRoomId=${sharer?.roomId}`,
            );
            return respond({ success: false, message: '无权限切换房间模式' });
          }

          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            console.warn(
              `[update-room-mode] room not found socketId=${socket.id} roomId=${payload.roomId}`,
            );
            return respond({ success: false, message: '房间不存在' });
          }

          await roomRepo.update(
            { roomId: payload.roomId },
            { mode: payload.mode },
          );

          respond({ success: true, mode: payload.mode });

          try {
            io.to(payload.roomId).emit('room-mode-changed', {
              mode: payload.mode,
            });
            console.log(
              `[update-room-mode] broadcasted roomId=${payload.roomId} mode=${payload.mode}`,
            );
          } catch (emitErr) {
            console.error(
              `[update-room-mode] broadcast failed socketId=${socket.id} roomId=${payload.roomId}`,
              emitErr,
            );
          }
        } catch (err) {
          console.error(
            `[update-room-mode] error socketId=${socket.id} roomId=${payload.roomId} mode=${payload.mode}`,
            err,
          );
          respond({ success: false, message: '切换房间模式失败' });
        }
      },
    );

    // --- 房主管理事件：踢人 / 禁言 / 解禁 / 转交房主 / 修改房间设置 ---
    // 所有事件均要求调用方为当前房间的活跃 sharer（房主）。

    // 踢出指定观众：服务端主动断开目标 socket 连接，并广播 viewer-kicked
    // 让被踢方前端提示「已被房主移出房间」并退出房间。
    socket.on(
      'kick-viewer',
      async (
        payload: { roomId: string; viewerSocketId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主可踢人' });
          }
          const targetSocket = io.sockets.sockets.get(payload.viewerSocketId);
          if (!targetSocket) {
            return callback?.({ success: false, message: '观众已不在房间' });
          }
          // 通知被踢方显示提示并主动断开
          io.to(payload.viewerSocketId).emit('viewer-kicked', {
            reason: '房主已将您移出房间',
          });
          // 结束其 session 记录
          const sessionRepo = AppDataSource.getRepository(Session);
          await sessionRepo.update(
            { socketId: payload.viewerSocketId, endedAt: IsNull() },
            { endedAt: new Date() },
          );
          targetSocket.leave(payload.roomId);
          targetSocket.disconnect(true);
          // 通知房间内所有成员移除该 viewer（房主+其他观众）
          io.to(payload.roomId).emit('viewer-left', { socketId: payload.viewerSocketId });
          console.log(
            `[kick-viewer] host=${socket.id} kicked viewer=${payload.viewerSocketId} room=${payload.roomId}`,
          );
          callback?.({ success: true });
        } catch (err) {
          console.error('[kick-viewer] error:', err);
          callback?.({ success: false, message: '踢人失败' });
        }
      },
    );

    // 禁言指定观众：将 userId 加入 Room.mutedViewers，被禁言方无法 send-comment / send-danmaku
    socket.on(
      'mute-viewer',
      async (
        payload: { roomId: string; userId: number },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主可禁言' });
          }
          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback?.({ success: false, message: '房间不存在' });
          }
          const muted: number[] = JSON.parse(room.mutedViewers || '[]');
          if (!muted.includes(payload.userId)) {
            muted.push(payload.userId);
            room.mutedViewers = JSON.stringify(muted);
            await roomRepo.save(room);
          }
          // 通知被禁言方前端立即禁用评论/弹幕输入
          io.to(payload.roomId).emit('viewer-muted', {
            userId: payload.userId,
            muted: true,
          });
          console.log(
            `[mute-viewer] host=${socket.id} muted userId=${payload.userId} room=${payload.roomId}`,
          );
          callback?.({ success: true });
        } catch (err) {
          console.error('[mute-viewer] error:', err);
          callback?.({ success: false, message: '禁言失败' });
        }
      },
    );

    // 解除禁言
    socket.on(
      'unmute-viewer',
      async (
        payload: { roomId: string; userId: number },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主可解禁' });
          }
          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback?.({ success: false, message: '房间不存在' });
          }
          const muted: number[] = JSON.parse(room.mutedViewers || '[]');
          const next = muted.filter((id) => id !== payload.userId);
          room.mutedViewers = JSON.stringify(next);
          await roomRepo.save(room);
          io.to(payload.roomId).emit('viewer-muted', {
            userId: payload.userId,
            muted: false,
          });
          console.log(
            `[unmute-viewer] host=${socket.id} unmuted userId=${payload.userId} room=${payload.roomId}`,
          );
          callback?.({ success: true });
        } catch (err) {
          console.error('[unmute-viewer] error:', err);
          callback?.({ success: false, message: '解禁失败' });
        }
      },
    );

    // 转交房主：将当前房主身份转交给指定观众。
    // 实现：更新 Room.ownerUserId，将目标观众的 session.role 改为 'sharer'，
    // 当前房主 session.role 改为 'viewer'，并广播 host-transferred 通知双方。
    socket.on(
      'transfer-host',
      async (
        payload: { roomId: string; viewerSocketId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主可转交' });
          }
          const sessionRepo = AppDataSource.getRepository(Session);
          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback?.({ success: false, message: '房间不存在' });
          }
          const targetSession = await sessionRepo.findOneBy({
            socketId: payload.viewerSocketId,
            roomId: payload.roomId,
            role: 'viewer',
            endedAt: IsNull(),
          });
          if (!targetSession) {
            return callback?.({ success: false, message: '目标观众不存在或已离开' });
          }
          const targetSocket = io.sockets.sockets.get(payload.viewerSocketId);
          if (!targetSocket) {
            return callback?.({ success: false, message: '目标观众已断开' });
          }
          // 拒绝转交给 guest 用户（房主必须为 root/admin/user）
          const targetRole: UserRole | undefined = targetSocket.data?.role;
          if (targetRole === 'guest') {
            return callback?.({ success: false, message: '不能转交给游客账户' });
          }
          // 切换 session 角色
          await sessionRepo.update(
            { socketId: payload.viewerSocketId, roomId: payload.roomId },
            { role: 'sharer' },
          );
          await sessionRepo.update(
            { socketId: socket.id, roomId: payload.roomId },
            { role: 'viewer' },
          );
          // 更新房间 owner
          const newOwnerId = targetSocket.data?.userId ?? null;
          room.ownerUserId = newOwnerId;
          await roomRepo.save(room);
          // 通知双方角色变化
          io.to(payload.roomId).emit('host-transferred', {
            newHostSocketId: payload.viewerSocketId,
            oldHostSocketId: socket.id,
            newOwnerUserId: newOwnerId,
          });
          console.log(
            `[transfer-host] oldHost=${socket.id} -> newHost=${payload.viewerSocketId} room=${payload.roomId}`,
          );
          callback?.({ success: true });
        } catch (err) {
          console.error('[transfer-host] error:', err);
          callback?.({ success: false, message: '转交房主失败' });
        }
      },
    );

    // 修改房间运行时设置：密码 / 观众上限 / 审批开关
    socket.on(
      'update-room-settings',
      async (
        payload: {
          roomId: string;
          password?: string | null;
          maxViewers?: number;
          requireApproval?: boolean;
        },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!(await isRoomHost(socket, payload.roomId))) {
            return callback?.({ success: false, message: '无权限：仅房主可修改房间设置' });
          }
          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return callback?.({ success: false, message: '房间不存在' });
          }
          if (typeof payload.password === 'string') {
            room.password = payload.password.trim() || null;
          }
          if (typeof payload.maxViewers === 'number') {
            if (payload.maxViewers < 1 || payload.maxViewers > 100) {
              return callback?.({ success: false, message: '观众上限必须在 1-100 之间' });
            }
            room.maxViewers = payload.maxViewers;
          }
          if (typeof payload.requireApproval === 'boolean') {
            room.requireApproval = payload.requireApproval;
          }
          await roomRepo.save(room);
          // 广播给房间内所有成员，前端 roomStore 同步
          io.to(payload.roomId).emit('room-settings-updated', {
            password: room.password,
            maxViewers: room.maxViewers,
            requireApproval: room.requireApproval,
          });
          console.log(
            `[update-room-settings] host=${socket.id} room=${payload.roomId}`,
          );
          callback?.({ success: true });
        } catch (err) {
          console.error('[update-room-settings] error:', err);
          callback?.({ success: false, message: '修改房间设置失败' });
        }
      },
    );

    // --- 断开连接处理 ---
    // 根据断开者角色分别处理：
    // - 房主断开：广播 host-disconnected，并在宽限期内未重连则关闭房间
    // - 观众断开：广播 viewer-left 给房主
    socket.on('disconnect', async () => {
      console.log(`[room] Socket disconnected: ${socket.id}`);
      try {
        const sessionRepo = AppDataSource.getRepository(Session);
        const session = await sessionRepo.findOneBy({
          socketId: socket.id,
          endedAt: IsNull(),
        });
        if (!session) return;

        if (session.role === 'sharer') {
          // 标记 sharer 会话结束并预留重连窗口，期间不直接关闭房间
          await sessionRepo.update(
            { id: session.id },
            { endedAt: new Date() },
          );
          // 房主断开：向房间内所有成员广播 host-disconnected
          io.to(session.roomId).emit('host-disconnected', {
            roomId: session.roomId,
          });
          const timer = setTimeout(() => {
            hostReconnectTimers.delete(session.roomId);
            void closeRoomAndNotify(io, session.roomId, socket.id);
          }, HOST_RECONNECT_GRACE_MS);
          hostReconnectTimers.set(session.roomId, timer);
        } else {
          // 观众断开：结束其会话并通知房主
          await sessionRepo.update(
            { socketId: socket.id, role: 'viewer', endedAt: IsNull() },
            { endedAt: new Date() },
          );
          const sharer = await sessionRepo.findOneBy({
            roomId: session.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          if (sharer) {
            // 观众离开：通知房间内所有成员（房主+其他观众）有观众离开
            io.to(session.roomId).emit('viewer-left', {
              viewerSocketId: socket.id,
            });
          }
        }
      } catch (err) {
        console.error('disconnect handler error:', err);
      }
    });
  });
}
