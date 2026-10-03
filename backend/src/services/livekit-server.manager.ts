/**
 * 嵌入式 LiveKit 服务管理器（单文件部署专用）。
 *
 * livekit-server 是独立 Go 二进制，无法内嵌进 pkg 产物；本管理器把它
 * 作为「伴生进程」随 exe 一并启动/停止，实现单文件部署开箱即用：
 *
 * - 启动：在 exe 同目录（或 backend/dev-bin，开发环境）找到
 *   livekit-server(.exe) 后拉起子进程，参数固定为开发模式
 *   （--dev --bind 0.0.0.0 --udp-port 7882），密钥取自环境变量或
 *   内置默认值（devkey / zviewer-dev-secret）
 * - 就绪：轮询 7880 端口 TCP 可连即视为就绪（最多 15s）
 * - 退出：随主进程退出而终止子进程（SIGINT/SIGTERM/exit 三挂钩）
 *
 * 配置优先级：
 * - LIVEKIT_EXTERNAL=1：完全跳过嵌入式启动（外置 LiveKit 部署）
 * - LIVEKIT_API_KEY/SECRET/URL：未设置时使用内置默认；URL 缺省自动
 *   探测本机私有 IPv4 生成 ws://<LAN_IP>:7880（局域网成员可直连）
 * - docker-compose 部署走独立 livekit 容器，环境变量显式注入，
 *   容器内无伴生二进制 → 本管理器自动跳过
 */
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const DEFAULT_API_KEY = 'devkey';
const DEFAULT_API_SECRET = 'zviewer-dev-secret';
const HTTP_PORT = 7880;
const UDP_PORT = 7882;
const READY_TIMEOUT_MS = 15_000;

let child: ChildProcess | null = null;

function binName(): string {
  return process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
}

function candidatePaths(): string[] {
  const name = binName();
  return [
    // pkg 产物：exe 同目录（build-all 打包时随产物分发）
    path.join(path.dirname(process.execPath), name),
    // 开发环境：backend/dev-bin 手动放置
    path.join(process.cwd(), 'dev-bin', name),
    path.join(process.cwd(), 'backend', 'dev-bin', name),
  ];
}

/** 探测本机第一个私有 IPv4（192.168/10./172.16-31），供缺省 LIVEKIT_URL */
function detectPrivateIPv4(): string | undefined {
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const info of os.networkInterfaces()[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const ip = info.address;
      if (
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
      ) {
        return ip;
      }
    }
  }
  return undefined;
}

/** 是否具备嵌入式启动条件（二进制存在且未声明使用外置 LiveKit） */
export function isEmbeddedLivekitAvailable(): boolean {
  if (process.env.LIVEKIT_EXTERNAL === '1') return false;
  return candidatePaths().some((p) => fs.existsSync(p));
}

/** 轮询等待 LiveKit HTTP 端口可连接 */
function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`LiveKit 端口 ${port} 等待超时`));
        } else {
          setTimeout(tryOnce, 300);
        }
      });
    };
    tryOnce();
  });
}

function killChild(): void {
  if (!child) return;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  child = null;
}

let exitHooksInstalled = false;
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.once('exit', killChild);
  process.once('SIGINT', () => {
    killChild();
    process.exit(0);
  });
  process.once('SIGTERM', () => {
    killChild();
    process.exit(0);
  });
}

/**
 * 启动嵌入式 LiveKit 服务（幂等；不具备条件时静默跳过）。
 * 在应用启动早期调用，等待就绪后再继续（最多 15s）。
 */
export async function startEmbeddedLivekit(): Promise<void> {
  if (child) return;
  const bin = candidatePaths().find((p) => fs.existsSync(p));
  if (!bin) return;

  // 环境变量缺省值：嵌入式部署开箱即用；.env 显式配置优先
  process.env.LIVEKIT_API_KEY ??= DEFAULT_API_KEY;
  process.env.LIVEKIT_API_SECRET ??= DEFAULT_API_SECRET;
  process.env.LIVEKIT_API_HOST ??= `http://127.0.0.1:${HTTP_PORT}`;
  const lanIp = detectPrivateIPv4();
  process.env.LIVEKIT_URL ??= `ws://${lanIp ?? 'localhost'}:${HTTP_PORT}`;

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  console.log(
    `[voice] 启动嵌入式 LiveKit: ${bin} (HTTP ${HTTP_PORT}, UDP ${UDP_PORT}, URL=${process.env.LIVEKIT_URL})`
  );

  child = spawn(
    bin,
    [
      '--dev',
      '--bind',
      '0.0.0.0',
      '--udp-port',
      String(UDP_PORT),
      '--keys',
      `${apiKey}:${apiSecret}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(`[livekit] ${chunk}`);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(`[livekit] ${chunk}`);
  });
  child.once('exit', (code) => {
    console.warn(`[voice] 嵌入式 LiveKit 进程退出 (code=${code})`);
    child = null;
  });

  installExitHooks();

  try {
    await waitForPort(HTTP_PORT, READY_TIMEOUT_MS);
    console.log('[voice] 嵌入式 LiveKit 已就绪');
  } catch (err) {
    console.error(
      '[voice] 嵌入式 LiveKit 启动超时——语音将不可用，请检查端口占用',
      err instanceof Error ? err.message : err
    );
  }
}
