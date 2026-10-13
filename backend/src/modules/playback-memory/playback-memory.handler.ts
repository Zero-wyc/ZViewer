/**
 * 播放记忆 Socket 事件处理器。
 *
 * 处理事件：
 * - watch-together-state：房主更新播放状态（写入持久化 + 广播给观众）
 * - watch-together-request-state：观众/房主重连请求当前状态（从持久化读取）
 * - watch-together-control：房主控制指令（立即广播 + 更新持久化状态）
 *
 * 与旧 SyncStateHandler 的区别：
 * - 状态写入 playbackMemoryService 持久化（而非仅内存 roomStateService）
 * - 房主断开期间，服务器定时广播接管，观众端继续播放
 * - 请求状态时返回推算后的实际进度（基于时间差）
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { playbackMemoryService } from './playback-memory.service';
import { compensateTransportDelay } from './transport-delay';
import { needsProgressSync } from './check-status';
import type {
  SyncStatePayload,
  SyncControlPayload,
  CheckStatusPayload,
} from '../shared/dto';

export class PlaybackMemoryHandler implements SocketEventHandler {
  readonly name = 'PlaybackMemoryHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 房主更新播放状态 ---
    // 仅活跃 sharer 可调用，持久化后广播给房间内其他成员
    socket.on(
      'watch-together-state',
      async (payload: SyncStatePayload, callback?: AckCallback) => {
        try {
          // 校验是否为指定房间的活跃 sharer
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限同步' });
          }
          // 校验房间为 watch-together 模式
          if (
            !(await roomPermissionService.isWatchTogetherRoom(payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '当前房间模式不支持同步播放',
            });
          }

          // 持久化到 playbackMemoryService（内存 + DB）
          // clientTs：服务端补偿传输延迟（clamp 0~1.5s × rate，仅播放中），
          // 使持久化基线锚定在服务器时间轴上（Step 1：服务器权威化写入）
          await playbackMemoryService.setPlayback(
            payload.roomId,
            payload.state,
            socket.id,
            payload.clientTs,
          );

          // 广播给房间内其他成员（不含 roomId，接收端按 socket 所在房间处理）
          // seq 为房主侧递增序号，透传给观众用于跳号检测（错失广播时拉全量自愈）
          socket.to(payload.roomId).emit('watch-together-state', {
            state: payload.state,
            diff: payload.diff,
            seq: payload.seq,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[watch-together-state] error:', err);
          safeAck(callback, { success: false, message: '同步失败' });
        }
      },
    );

    // --- 请求当前播放状态 ---
    // 观众加入、房主重连、观众刷新时调用
    // 返回推算后的实际播放状态
    socket.on(
      'watch-together-request-state',
      async (payload: { roomId: string }, callback?: AckCallback) => {
        try {
          // 校验在房间内
          if (
            !(await roomPermissionService.isInRoom(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }

          // 从持久化读取推算后的状态
          const state = await playbackMemoryService.getAdvancedPlayback(
            payload.roomId,
          );

          if (state) {
            // 直接通过 ack 返回状态（用于房主重连/观众初始加载）
            // serverTs：服务器应答时刻，客户端可据此估算时钟偏移（时钟校准铺路）
            safeAck(callback, {
              success: true,
              data: { state, serverTs: Date.now() },
            });
          } else {
            // 房间无播放状态，广播给其他成员让房主主动同步
            socket.to(payload.roomId).emit('watch-together-request-state');
            safeAck(callback, { success: true, data: null });
          }
        } catch (err) {
          console.error('[watch-together-request-state] error:', err);
          safeAck(callback, { success: false, message: '请求失败' });
        }
      },
    );

    // --- 房主控制指令 ---
    // 立即广播给观众（亚 500ms 响应），同时更新持久化状态
    socket.on(
      'watch-together-control',
      async (payload: SyncControlPayload, callback?: AckCallback) => {
        try {
          if (
            !(await roomPermissionService.isRoomHost(socket, payload.roomId))
          ) {
            return safeAck(callback, { success: false, message: '无权限控制' });
          }
          if (
            !(await roomPermissionService.isWatchTogetherRoom(payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '当前房间模式不支持同步播放',
            });
          }

          // 立即广播给观众（低延迟）
          socket.to(payload.roomId).emit('watch-together-control', {
            action: payload.action,
            value: payload.value,
          });

          // 更新持久化状态（控制指令影响状态，内部按动作做传输延迟补偿）
          await this.applyControlToPlayback(
            payload.roomId,
            payload.action,
            payload.value,
            socket.id,
            payload.clientTs,
          );

          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[watch-together-control] error:', err);
          safeAck(callback, { success: false, message: '控制失败' });
        }
      },
    );
    // --- 观众主动自检（CHECK_STATUS，Step 3）---
    // 观众每 10s 上报本地播放状态，服务端与权威推算状态比对（±10s 容差），
    // 分歧超限才通过 ack 下发权威推算状态——服务器周期心跳丢失
    // （socket 重连窗口 / 网络抖动）时的自愈通道，参考 synctv CHECK_STATUS。
    socket.on(
      'watch-together-check-status',
      async (payload: CheckStatusPayload, callback?: AckCallback) => {
        try {
          // 校验在房间内（观众自检，房主无需参与）
          if (
            !(await roomPermissionService.isInRoom(socket, payload.roomId))
          ) {
            return safeAck(callback, {
              success: false,
              message: '不在该房间中',
            });
          }

          const serverTs = Date.now();
          const serverState =
            await playbackMemoryService.getAdvancedPlayback(payload.roomId);
          if (!serverState) {
            return safeAck(callback, {
              success: true,
              data: { needsSync: false, serverTs },
            });
          }

          const needsSync = needsProgressSync({
            clientCurrentTime: payload.currentTime,
            clientIsPlaying: payload.isPlaying,
            clientPlaybackRate: payload.playbackRate,
            clientTs: payload.clientTs,
            serverCurrentTime: serverState.currentTime,
            serverIsPlaying: serverState.isPlaying,
          });

          safeAck(callback, {
            success: true,
            data: needsSync
              ? { needsSync: true, state: serverState, serverTs }
              : { needsSync: false, serverTs },
          });
        } catch (err) {
          console.error('[watch-together-check-status] error:', err);
          safeAck(callback, { success: false, message: '自检失败' });
        }
      },
    );
  }

  /**
   * 将控制指令应用到持久化播放状态。
   *
   * - play：更新 isPlaying，并补偿在途推进（播放瞬间房主已前进 delay × rate）
   * - pause：更新 isPlaying，进度凝固不补偿
   * - seek：更新 currentTime，仅当 seek 后仍处于播放态时补偿在途推进
   * - rate：先推算当前进度再更新倍速，不额外补偿
   *
   * 这些更新会重置 lastUpdatedAt，确保下次推算从正确的时间点开始。
   */
  private async applyControlToPlayback(
    roomId: string,
    action: string,
    value: number | undefined,
    hostSocketId: string,
    clientTs?: number,
  ): Promise<void> {
    const current = await playbackMemoryService.getRawPlayback(roomId);
    if (!current) return;

    let newState = { ...current };

    switch (action) {
      case 'play': {
        newState.isPlaying = true;
        // 暂停凝固的基线进度 + 在途推进（播放已按下 delay × rate）
        const advanced = await playbackMemoryService.getAdvancedPlayback(roomId);
        newState.currentTime = compensateTransportDelay({
          currentTime: advanced?.currentTime ?? newState.currentTime,
          clientTs,
          playbackRate: newState.playbackRate,
          isPlaying: true,
        });
        break;
      }
      case 'pause':
        newState.isPlaying = false;
        // 暂停时更新 currentTime 为当前推算值（凝固进度）
        const advanced = await playbackMemoryService.getAdvancedPlayback(roomId);
        if (advanced) {
          newState.currentTime = advanced.currentTime;
        }
        break;
      case 'seek':
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          // seek 后仍播放中：房主 seek 到目标点后在途已推进 delay × rate；
          // seek 后暂停态进度凝固，不补偿。
          newState.currentTime = compensateTransportDelay({
            currentTime: value,
            clientTs,
            playbackRate: newState.playbackRate,
            isPlaying: newState.isPlaying,
          });
          // 不改变 isPlaying——seek 后房主仍可播放/暂停，实际状态由下一个心跳同步；
          // 旧实现强制设为 false 导致观众端在 seek 后暂停、收到心跳后才恢复，造成抖动
        }
        break;
      case 'rate':
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          // 先推算当前进度，再更新倍速
          const adv = await playbackMemoryService.getAdvancedPlayback(roomId);
          if (adv) {
            newState.currentTime = adv.currentTime;
          }
          newState.playbackRate = value;
        }
        break;
    }

    // 移除 hostSocketId（不在 SyncStateDto 中），单独更新。
    // 此处已完成显式补偿，setPlayback 不再传 clientTs，避免二次补偿。
    const { hostSocketId: _omit, ...stateOnly } = newState as typeof newState & {
      hostSocketId?: string | null;
    };
    void _omit;
    await playbackMemoryService.setPlayback(roomId, stateOnly, hostSocketId);
  }
}
