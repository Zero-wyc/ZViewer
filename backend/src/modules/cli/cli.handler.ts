/**
 * CLI 代理 Socket 事件处理器。
 *
 * 处理本地 zcontrol-cli 客户端的注册、列表查询与断开通知：
 * - cli-register：CLI 代理注册到服务器（全局，不再绑定房间），广播 cli-agent-available
 * - cli-list-agents：前端查询全局 CLI 代理列表
 * - disconnect：CLI 断开时广播 cli-agent-unavailable
 *
 * 设计要点（2026-09-23 去房间化重构）：
 * - CLI 只配置服务器地址即可注册，一个 CLI 实例对服务器上所有房间可用；
 *   房间内「CLI 高画质代理」开关开启时前端自动使用已注册的代理（自动连接）
 * - 代理信息存储在 socket.data.cliAgent，统一加入专用房间 __cli-agents__
 *   聚合管理（替代旧的按用户房间 join）；查询走 io.in(__cli-agents__)
 * - agent.user 记录注册时归属的用户名（网页端打开配置页时经 ?user= 传入），
 *   前端按用户名过滤——多人共用服务器时只看到自己的代理（旧版 CLI 无 user
 *   字段，视为公共代理全员可见）
 * - available/unavailable 事件全局广播：代理列表与房间无关
 * - CLI 代理无需 access_token，由 io.use 中间件按 agent='zcontrol-cli' 放行
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../socket';

/** CLI 代理专用聚合房间（仅用于 fetchSockets 高效聚合，不涉及用户房间） */
const CLI_AGENTS_ROOM = '__cli-agents__';

/** CLI 代理信息（下发到前端 cliAgentStore） */
export interface CliAgentInfo {
  socketId: string;
  proxyUrl: string;
  agent?: string;
  version?: string;
  /** 注册时归属的用户名（网页端配置页经 ?user= 传入；旧版 CLI 无此字段） */
  user?: string;
}

/** cli-register 事件 payload（roomId 仅兼容旧版 CLI，忽略不校验） */
interface CliRegisterPayload {
  roomId?: string;
  proxyUrl: string;
  agent?: string;
  version?: string;
  user?: string;
}

/**
 * 将 CLI 上报的 proxyUrl 归一化为本地 127.0.0.1 地址。
 *
 * 本地 CLI 的 HTTP 代理服务始终运行在当前机器上，浏览器应直接请求 127.0.0.1。
 * 某些旧版 CLI 会误将页面 host 或后端 host 作为 proxyUrl 上报，导致前端跨域失败，
 * 因此在此处统一把 hostname 替换为 127.0.0.1 并保留端口与路径。
 */
function normalizeLocalCliProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return proxyUrl;
  }
}

/**
 * CLI 代理事件处理器。
 */
export class CliHandler implements SocketEventHandler {
  readonly name = 'CliHandler';

  register(socket: Socket, io: SocketIOServer): void {
    // 1. CLI 代理注册（全局：不再绑定房间，一个 CLI 对所有房间可用）
    socket.on(
      'cli-register',
      (payload: CliRegisterPayload) => {
        // 校验是否为 CLI 代理（由 io.use 中间件设置 socket.data.isCliAgent）
        if (!socket.data.isCliAgent) {
          io.to(socket.id).emit('cli-error', {
            message: '未授权的 CLI 代理连接',
          });
          return;
        }

        const { proxyUrl, agent, version, user } = payload ?? {};
        if (!proxyUrl) {
          io.to(socket.id).emit('cli-error', {
            message: '缺少 proxyUrl',
          });
          return;
        }

        // 本地 CLI 代理必须指向 127.0.0.1，避免 CLI 上报公网/内网 host 导致前端 CORS 失败
        const normalizedProxyUrl = normalizeLocalCliProxyUrl(proxyUrl);

        // 存储代理信息到 socket.data，供 cli-list-agents 聚合查询
        const agentInfo: CliAgentInfo = {
          socketId: socket.id,
          proxyUrl: normalizedProxyUrl,
          agent,
          version,
          user: typeof user === 'string' && user.trim() ? user.trim() : undefined,
        };
        socket.data.cliAgent = agentInfo;

        // 加入 CLI 专用聚合房间（替代旧的用户房间 join，供列表查询聚合）
        const joinResult = socket.join(CLI_AGENTS_ROOM);
        if (joinResult instanceof Promise) {
          joinResult.catch((err: unknown) => {
            console.error('[CLI] 加入代理聚合房间失败:', err);
          });
        }

        // 通知 CLI 注册成功
        io.to(socket.id).emit('cli-registered', {});

        // 全局广播（所有房间的前端都可见，配合前端按用户名过滤）
        io.emit('cli-agent-available', agentInfo);

        console.log(
          `[CLI] 代理注册: socketId=${socket.id} user=${agentInfo.user ?? '-'} proxyUrl=${normalizedProxyUrl}`,
        );
      },
    );

    // 2. 前端查询全局 CLI 代理列表（参数兼容旧前端的 roomId，忽略仅回显）
    socket.on('cli-list-agents', async (roomId?: unknown) => {
      try {
        const agents = await this.getAllAgents(io);
        const payload =
          typeof roomId === 'string' && roomId
            ? { roomId, agents }
            : { agents };
        io.to(socket.id).emit('cli-agents', payload);
      } catch (err) {
        // fetchSockets() 偶发失败（adapter 异常、长轮询断开等）时捕获，
        // 避免 unhandled rejection 导致后端进程崩溃（Node 15+ 默认 throw）
        console.error('[CLI] cli-list-agents 查询失败:', err);
        io.to(socket.id).emit('cli-agents', { agents: [] });
      }
    });

    // 3. 断开连接时全局广播下线
    socket.on('disconnect', () => {
      const agent = socket.data.cliAgent as CliAgentInfo | undefined;
      if (!agent) return;

      io.emit('cli-agent-unavailable', { socketId: agent.socketId });
      console.log(`[CLI] 代理下线: socketId=${socket.id}`);
    });
  }

  /**
   * 获取服务器上所有已注册的 CLI 代理。
   *
   * 通过 io.in(CLI_AGENTS_ROOM).fetchSockets() 遍历聚合房间内所有 socket，
   * 筛选出 socket.data.cliAgent 存在的（即已注册的 CLI 代理）。
   */
  private async getAllAgents(io: SocketIOServer): Promise<CliAgentInfo[]> {
    const sockets = await io.in(CLI_AGENTS_ROOM).fetchSockets();
    const agents: CliAgentInfo[] = [];
    for (const sock of sockets) {
      const agent = sock.data.cliAgent as CliAgentInfo | undefined;
      if (agent) {
        agents.push(agent);
      }
    }
    return agents;
  }
}
