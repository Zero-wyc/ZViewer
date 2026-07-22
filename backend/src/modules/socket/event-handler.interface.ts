import type {
  Server as SocketIOServer,
  Socket,
  RemoteSocket,
  DefaultEventsMap,
} from 'socket.io';

/**
 * Socket 事件处理器接口。
 *
 * 每个业务模块实现此接口，在 `register` 中挂载自己的 socket 事件监听器。
 * SocketRegistry 会统一在 `io.on('connection')` 时调用所有模块的 `register`。
 *
 * 设计目的：
 * - 消除旧架构中 index.ts 与 room.ts 两个 io.on('connection') 注册点的分裂
 * - 每个模块自管理其事件，新增模块只需实现接口并注册到 SocketRegistry
 * - 模块间通过共享 Service 协作，不直接耦合
 */
export interface SocketEventHandler {
  /** 模块名，用于日志和调试 */
  readonly name: string;

  /**
   * 注册 socket 事件监听器。
   *
   * @param socket 新连接的 socket
   * @param io Socket.IO 服务实例（用于广播）
   */
  register(socket: Socket, io: SocketIOServer): void;
}

/**
 * Socket 注册中心。
 *
 * 统一管理所有 SocketEventHandler，在 io.on('connection') 时依次调用 register。
 * 消除旧架构中多个 io.on('connection') 注册点的分裂问题。
 */
export class SocketRegistry {
  private handlers: SocketEventHandler[] = [];

  /** 注册一个事件处理器 */
  add(handler: SocketEventHandler): this {
    this.handlers.push(handler);
    return this;
  }

  /** 批量注册 */
  addAll(handlers: SocketEventHandler[]): this {
    this.handlers.push(...handlers);
    return this;
  }

  /**
   * 在 io.on('connection') 回调中调用，将所有 handler 注册到新 socket。
   *
   * @param socket 新连接的 socket
   * @param io Socket.IO 服务实例
   */
  registerAll(socket: Socket, io: SocketIOServer): void {
    for (const handler of this.handlers) {
      try {
        handler.register(socket, io);
      } catch (err) {
        console.error(
          `[SocketRegistry] 模块 ${handler.name} 注册失败:`,
          err,
        );
      }
    }
  }
}

/**
 * Socket 广播工具：封装常用的广播模式。
 *
 * 提供类型安全的广播方法，避免各模块重复编写 io.to().emit() 代码。
 */
export class SocketBroadcaster {
  constructor(
    private readonly io: SocketIOServer,
    private readonly socket: Socket,
  ) {}

  /**
   * 广播给房间内所有成员（包括发送者）。
   */
  toRoom(roomId: string, event: string, ...args: unknown[]): void {
    this.io.to(roomId).emit(event, ...args);
  }

  /**
   * 广播给房间内其他成员（不包括发送者）。
   */
  toRoomOthers(roomId: string, event: string, ...args: unknown[]): void {
    this.socket.to(roomId).emit(event, ...args);
  }

  /**
   * 发送给指定 socket。
   */
  toSocket(socketId: string, event: string, ...args: unknown[]): void {
    this.io.to(socketId).emit(event, ...args);
  }

  /**
   * 广播给房间内除指定 socket 外的所有成员。
   */
  toRoomExcept(
    roomId: string,
    excludeSocketIds: string[],
    event: string,
    ...args: unknown[]
  ): void {
    this.io.to(roomId).except(excludeSocketIds).emit(event, ...args);
  }

  /**
   * 获取房间内所有 socket（包括发送者）。
   */
  async getRoomSockets(
    roomId: string,
  ): Promise<RemoteSocket<DefaultEventsMap, unknown>[]> {
    return this.io.in(roomId).fetchSockets();
  }
}

/** Ack 回调类型 */
export type AckResponse = { success: boolean; message?: string; data?: unknown };
export type AckCallback = (response: AckResponse) => void;

/** 安全执行 ack 回调 */
export function safeAck(
  callback: AckCallback | undefined,
  response: AckResponse,
): void {
  if (callback) {
    try {
      callback(response);
    } catch {
      // 客户端可能已断开
    }
  }
}
