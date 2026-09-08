/**
 * NCM API 内部服务（一起听音乐模块的后端依赖）。
 *
 * 通过 @neteasecloudmusicapienhanced/api 在 127.0.0.1 上启动内部 HTTP 服务，
 * REST 层 /api/music/* 统一转发到该服务，浏览器不直连网易云。
 *
 * 启动方式参考 F:\Code\Hydrogen-Music\src\electron\services.js：
 * - 端口默认 36530（与 Hydrogen 保持一致），被占用时自动 +1 重试，最多 5 次
 * - 启动后轮询探测就绪（waitForApiReachable），供 bootstrap 串行等待
 *
 * 注意：serveNcmApi 必须显式传 host/port——其内部 fallback 会读取
 * process.env.PORT / HOST，与后端主服务的环境变量冲突（PORT=3333），
 * 或导致监听所有接口（绑定 127.0.0.1 是安全底线，公网不可直达）。
 */
import * as http from 'node:http';

/** serveNcmApi 选项（以包内 server.js 的 JSDoc 为准） */
interface ServeNcmApiOptions {
  port?: number;
  host?: string;
  checkVersion?: boolean;
  moduleDefs?: unknown[];
}

/** serveNcmApi 返回值：Express 实例 + 附带的 http.Server */
interface NcmApiApp {
  server?: http.Server;
}

// 包的 interface.d.ts 仅声明函数式 API（cloudsearch / song_url_v1 等）；
// serveNcmApi 通过 Object.assign(main.js 导出, require('./server')) 挂载，
// 对 TS 类型系统不可见，因此用 require 引入并手动断言实际签名。
const enhancedApi = require('@neteasecloudmusicapienhanced/api') as {
  serveNcmApi?: (options: ServeNcmApiOptions) => Promise<NcmApiApp>;
};

/** 内部服务起始端口（与 Hydrogen-Music 一致） */
const NCM_API_BASE_PORT = 36530;
/** 端口被占用时的重试次数（共尝试 BASE_PORT ~ BASE_PORT+5） */
const NCM_API_PORT_RETRIES = 5;
/** app.listen 完成监听的等待上限 */
const NCM_API_LISTEN_TIMEOUT_MS = 8000;
/** HTTP 探测就绪的总上限（内部服务冷启动可能较慢） */
const NCM_API_READY_TIMEOUT_MS = 15000;
/** 探测轮询间隔 */
const NCM_API_READY_POLL_INTERVAL_MS = 150;

let ncmApiServer: http.Server | null = null;
let ncmApiBase = '';
let startPromise: Promise<string> | null = null;

/** 获取内部 NCM API 服务基地址（未启动时为空字符串，调用方需自行降级） */
export function getNcmApiBase(): string {
  return ncmApiBase;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等待 server 完成监听；失败（EADDRINUSE 等）或超时 reject */
function waitForListening(
  server: http.Server,
  timeoutMs: number,
): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('ncm-api-listen-timeout'));
    }, timeoutMs);

    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      server.off('listening', onListening);
      server.off('error', onError);
    };

    server.once('listening', onListening);
    server.once('error', onError);
  });
}

/** 探测内部服务是否已能响应任意 HTTP 请求（含静态首页） */
function probeReachable(url: string, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve();
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('ncm-api-probe-timeout'));
    });
    req.on('error', reject);
  });
}

/** 轮询探测内部服务就绪（参考 Hydrogen waitForApiReachable） */
async function waitForReady(base: string): Promise<void> {
  const deadline = Date.now() + NCM_API_READY_TIMEOUT_MS;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      await probeReachable(`${base}/`);
      return;
    } catch (err) {
      lastError = err;
      await delay(NCM_API_READY_POLL_INTERVAL_MS);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('ncm-api-unreachable');
}

/** 在指定端口启动 NCM API 服务并等待就绪；失败时抛错由调用方决定重试 */
async function startOnPort(port: number): Promise<string> {
  if (typeof enhancedApi.serveNcmApi !== 'function') {
    throw new Error('NCM API 模块不可用（serveNcmApi 缺失）');
  }
  const app = await enhancedApi.serveNcmApi({
    port,
    host: '127.0.0.1',
    // 关闭版本检查（exec npm info 依赖外网且无意义）
    checkVersion: false,
  });
  const server = app.server;
  if (!server) {
    throw new Error('NCM API 未返回 server 实例');
  }
  try {
    await waitForListening(server, NCM_API_LISTEN_TIMEOUT_MS);
  } catch (err) {
    server.close();
    throw err;
  }
  const base = `http://127.0.0.1:${port}`;
  await waitForReady(base);
  ncmApiServer = server;
  return base;
}

/**
 * 启动 NCM API 内部服务（幂等，可并发调用，重复调用返回同一 Promise）。
 * 默认端口 36530 起被占用时自动 +1 重试，最多 5 次；全部失败时抛错。
 */
export async function startNcmApiService(): Promise<string> {
  if (ncmApiServer) return ncmApiBase;
  if (startPromise) return startPromise;

  startPromise = (async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= NCM_API_PORT_RETRIES; attempt++) {
      const port = NCM_API_BASE_PORT + attempt;
      try {
        ncmApiBase = await startOnPort(port);
        console.log(`[music] NCM API 内部服务已启动: ${ncmApiBase}`);
        return ncmApiBase;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[music] NCM API 端口 ${port} 启动失败: ${message}`);
      }
    }
    // 全部端口失败：重置启动状态，允许下次调用重试
    startPromise = null;
    throw lastError instanceof Error
      ? lastError
      : new Error('ncm-api-start-failed');
  })();
  return startPromise;
}

/** 停止 NCM API 内部服务（幂等），进程退出时调用 */
export function stopNcmApiService(): void {
  const server = ncmApiServer;
  ncmApiServer = null;
  ncmApiBase = '';
  startPromise = null;
  if (server) {
    server.close();
    console.log('[music] NCM API 内部服务已停止');
  }
}
