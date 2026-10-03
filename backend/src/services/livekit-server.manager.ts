/**
 * 嵌入式 LiveKit 服务管理器。
 *
 * livekit-server 是独立 Go 二进制，无法内嵌进 pkg 产物；本管理器把它
 * 作为「伴生进程」随主进程启动/停止：
 *
 * - 单文件部署：build-all 打包时已把二进制分发到 exe 旁，启动时自动拉起
 * - 开发模式（npm run dev）：二进制缺失时自动从 GitHub Releases 下载到
 *   backend/dev-bin/ 再启动（仅开发模式；生产包不会静默联网下载）
 * - 外置部署：LIVEKIT_EXTERNAL=1 或 .env 显式配置 LiveKit 地址时跳过
 *
 * 生命周期：随主进程退出而终止子进程（SIGINT/SIGTERM/exit 三挂钩）。
 * 环境变量缺省值在启动早期注入，.env 显式配置优先：
 * LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_API_HOST / LIVEKIT_URL
 * （URL 缺省自动探测本机私有 IPv4，局域网成员可直连）。
 */
import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';

const DEFAULT_API_KEY = 'devkey';
const DEFAULT_API_SECRET = 'zviewer-dev-secret';
const HTTP_PORT = 3336;
/** 媒体传输 UDP 端口：与 HTTP 同号（tcp/udp 协议不同不冲突） */
const UDP_PORT = 3336;
const READY_TIMEOUT_MS = 15_000;
/** 开发模式自动下载的 pinned 版本（与 build-all 打包版本保持一致） */
const LIVEKIT_VERSION = 'v1.13.7';

let child: ChildProcess | null = null;

function binName(): string {
  return process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server';
}

/** 是否为 pkg 单文件运行（生产包不自动联网下载） */
function isPkgRuntime(): boolean {
  return Boolean((process as { pkg?: unknown }).pkg);
}

function isDevMode(): boolean {
  return !isPkgRuntime();
}

function candidatePaths(): string[] {
  const name = binName();
  return [
    // pkg 产物：exe 同目录（build-all 打包时随产物分发）
    path.join(path.dirname(process.execPath), name),
    // 开发环境：backend/dev-bin（自动下载/手动放置均可）
    path.join(process.cwd(), 'dev-bin', name),
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

function isEmbeddedLivekitAvailable(): boolean {
  return candidatePaths().some((p) => fs.existsSync(p));
}

// ==================== 开发模式自动下载 ====================

/** https 下载（跟随重定向；GitHub releases 会 302 到对象存储） */
function httpsDownload(url: string, dest: string, depth = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('重定向次数过多'));
    https
      .get(url, { headers: { 'User-Agent': 'zviewer-dev-setup' } }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          httpsDownload(
            new URL(res.headers.location, url).toString(),
            dest,
            depth + 1
          ).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

/** 解压到 dev-bin（win: zip→Expand-Archive；nix: tar.gz→tar） */
function extractLivekit(archive: string, destDir: string): void {
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Force -Path ${JSON.stringify(
        archive
      )} -DestinationPath ${JSON.stringify(destDir)}"`,
      { stdio: 'pipe' }
    );
  } else {
    execSync(`tar -xzf ${JSON.stringify(archive)} -C ${JSON.stringify(destDir)}`, {
      stdio: 'pipe',
    });
  }
}

/**
 * 开发模式：二进制缺失时自动下载到 backend/dev-bin/。
 * 成功返回二进制路径；失败（网络不通等）返回 null 并给出手动放置指引。
 */
async function downloadDevBinary(): Promise<string | null> {
  const destDir = path.join(process.cwd(), 'dev-bin');
  const isWin = process.platform === 'win32';
  const asset = isWin
    ? `livekit_${LIVEKIT_VERSION.slice(1)}_windows_amd64.zip`
    : `livekit_${LIVEKIT_VERSION.slice(1)}_linux_amd64.tar.gz`;
  const url = `https://github.com/livekit/livekit-server/releases/download/${LIVEKIT_VERSION}/${asset}`;
  const archive = path.join(destDir, asset);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    console.log(`[voice] 开发模式：自动下载 livekit-server ${LIVEKIT_VERSION} ...`);
    await httpsDownload(url, archive);
    extractLivekit(archive, destDir);
    const bin = path.join(destDir, binName());
    if (!fs.existsSync(bin)) throw new Error(`解压后未找到 ${bin}`);
    if (!isWin) {
      try {
        fs.chmodSync(bin, 0o755);
      } catch {
        /* ignore */
      }
    }
    console.log('[voice] livekit-server 下载完成');
    return bin;
  } catch (err) {
    console.warn(
      `[voice] livekit-server 自动下载失败（${err instanceof Error ? err.message : err}）。` +
        `可手动下载 ${url} 放置到 ${destDir} 后重启`
    );
    return null;
  } finally {
    try {
      fs.rmSync(archive, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// ==================== 启动 / 就绪 / 停止 ====================

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
 *
 * 调用时机：bootstrap 早期 fire-and-forget（不阻塞主服务启动；
 * 下载期间 /api/voice/token 会 503，前端提示「语音服务未就绪」）。
 */
export async function startEmbeddedLivekit(): Promise<void> {
  if (child) return;
  if (process.env.LIVEKIT_EXTERNAL === '1') return;

  // 环境变量缺省值先注入（显式配置 ??= 不覆盖），下载期间路由即可用
  process.env.LIVEKIT_API_KEY ??= DEFAULT_API_KEY;
  process.env.LIVEKIT_API_SECRET ??= DEFAULT_API_SECRET;
  process.env.LIVEKIT_API_HOST ??= `http://127.0.0.1:${HTTP_PORT}`;
  const lanIp = detectPrivateIPv4();
  // 缺省走统一端口 3333 的信令反代（后端 /rtc 隧道），浏览器无需放行
  // 3336/tcp；HTTPS 部署自动用 wss（TLS 由后端统一端口的证书处理）。
  // 媒体 RTP 仍为 UDP 3336 直连（防火墙需放行该条 UDP）。
  const unifiedPort = process.env.PORT || 3333;
  const scheme = process.env.HTTPS === 'true' ? 'wss' : 'ws';
  process.env.LIVEKIT_URL ??= `${scheme}://${lanIp ?? 'localhost'}:${unifiedPort}`;

  let bin = candidatePaths().find((p) => fs.existsSync(p));
  if (!bin) {
    if (!isDevMode()) {
      console.warn(
        '[voice] 未找到 livekit-server 伴生二进制且未配置外置 LiveKit——语音功能不可用'
      );
      return;
    }
    const downloaded = await downloadDevBinary();
    if (!downloaded) return;
    bin = downloaded;
  }

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
      // HTTP/信令端口：默认 7880，统一改为 3336 避开常见端口占用
      '--port',
      String(HTTP_PORT),
      '--udp-port',
      String(UDP_PORT),
      // --keys 格式硬性要求 "key: secret"（冒号后必须带空格），缺空格
      // livekit 会直接退出（冒烟实测踩坑）
      '--keys',
      `${apiKey}: ${apiSecret}`,
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
