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
 * LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_API_HOST / LIVEKIT_BIND
 * （客户端地址不在此配置——由 voice.routes 按请求头推导，跟随页面域名）。
 */
import { spawn, ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import net from 'net';
import path from 'path';

const DEFAULT_API_KEY = 'devkey';
const DEFAULT_API_SECRET = 'zviewer-dev-secret';
const HTTP_PORT = 3336;
/**
 * 媒体传输 UDP 端口：项目 TCP 侧未使用 3333/udp，故媒体与信令反代
 * 共用 3333 端口号（tcp=页面/API/信令反代，udp=RTP 媒体），防火墙
 * 只需放行一条 3333。
 */
const UDP_PORT = 3333;
/**
 * 监听地址：默认 `::`（Go dual-stack，同时收 IPv4/IPv6——IPv4 连接以
 * v4-mapped 形式进入，127.0.0.1 回环依然可达）。绑 0.0.0.0 会只收
 * IPv4，公网 IPv6 用户的媒体流无法建立。特殊环境可用 LIVEKIT_BIND 覆盖。
 */
const BIND_ADDRESS = process.env.LIVEKIT_BIND?.trim() || '::';
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
/** 拉起 livekit 子进程并等待 HTTP 端口就绪；超时/退出返回 false */
async function spawnAndAwait(bin: string, bind: string): Promise<boolean> {
  const args = [
    '--dev',
    // dual-stack 监听（IPv4+IPv6），见 BIND_ADDRESS 注释
    '--bind',
    bind,
    // HTTP/信令端口：默认 7880，统一改为 3336 避开常见端口占用
    '--port',
    String(HTTP_PORT),
    '--udp-port',
    String(UDP_PORT),
    // --keys 格式硬性要求 "key: secret"（冒号后必须带空格），缺空格
    // livekit 会直接退出（冒烟实测踩坑）
    '--keys',
    `${process.env.LIVEKIT_API_KEY}: ${process.env.LIVEKIT_API_SECRET}`,
  ];
  // Docker 单容器部署：容器内探测到的是 bridge 内网 IP（172.x），浏览器
  // 不可达——必须显式指定广播给客户端的 ICE 地址（宿主公网 IP），否则
  // 信令能通而媒体连不上。裸机/公网直连部署无需设置（自动枚举网卡）。
  const nodeIp = process.env.LIVEKIT_NODE_IP?.trim();
  if (nodeIp) args.push('--node-ip', nodeIp);

  child = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
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
    console.log(`[voice] 嵌入式 LiveKit 已就绪 (bind ${bind})`);
    return true;
  } catch {
    // 等待失败时若进程仍在（如启动过慢）先终止，避免残留占端口
    killChild();
    return false;
  }
}

export async function startEmbeddedLivekit(): Promise<void> {
  if (child) return;
  if (process.env.LIVEKIT_EXTERNAL === '1') return;

  // 环境变量缺省值先注入（显式配置 ??= 不覆盖），下载期间路由即可用
  process.env.LIVEKIT_API_KEY ??= DEFAULT_API_KEY;
  process.env.LIVEKIT_API_SECRET ??= DEFAULT_API_SECRET;
  process.env.LIVEKIT_API_HOST ??= `http://127.0.0.1:${HTTP_PORT}`;
  // 注意：此处不设置 LIVEKIT_URL——客户端地址由 voice.routes 按请求头
  // 推导（跟随页面域名与协议）。在容器/多网卡环境探测本机 IP 会得到
  // 内部地址（如 Docker bridge 172.24.x.x），浏览器不可达。

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

  console.log(
    `[voice] 启动嵌入式 LiveKit: ${bin} (bind ${BIND_ADDRESS}, HTTP ${HTTP_PORT}, UDP ${UDP_PORT}, URL=${process.env.LIVEKIT_URL})`
  );

  let ok = await spawnAndAwait(bin, BIND_ADDRESS);
  // 无 IPv6 协议栈的环境绑 :: 会直接退出（缺少 IPv6 支持时）——回退纯
  // IPv4 重试一次，代价是 IPv6 媒体不可用，但语音整体可用
  if (!ok && BIND_ADDRESS === '::') {
    console.warn('[voice] bind :: 启动失败，回退 0.0.0.0 (仅 IPv4) 重试');
    ok = await spawnAndAwait(bin, '0.0.0.0');
  }
  if (!ok) {
    console.error(
      '[voice] 嵌入式 LiveKit 启动失败——语音将不可用，请检查端口占用与二进制完整性'
    );
  }
}
