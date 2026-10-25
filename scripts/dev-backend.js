/**
 * Go 后端开发模式：改 .go 文件就自动重编译并重启。
 *
 * 为什么不装 `air`：这个仓库的开发链已经全在 Node 上（concurrently / vite），
 * `air` 要额外 `go install`（走代理、本机编译一遍），而它做的事就是
 * 「fs 监听 → go build → 换进程」。自己写 120 行，零安装，`npm run dev` 直接可用。
 *
 * 为什么不用 `go run`：
 *   1. `go run` 会 fork 出真正的服务进程，父进程被 kill 时子进程可能残留在端口上
 *      （Windows 上表现为「端口被占用、新版本起不来」）。这里 `go build` 到临时文件
 *      再直接 spawn，pid 就是我们启动的那个，能确定地杀掉。
 *   2. `go run` 每次都把产物丢进临时目录，产物名不可控；这里自己管产物与清理。
 *
 * 编译失败不会杀掉正在跑的旧进程：先编译到新文件，成功后才换进程。
 * 所以改到一半按保存（语法错误）时，正在用的服务不会挂，修好保存即自动恢复。
 *
 * 用法：
 *   node scripts/dev-backend.js            # 监听并自动重启
 *   node scripts/dev-backend.js --no-watch # 只编译运行一次（等价于旧的 go run）
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GO_DIR = path.join(ROOT, 'backend-go');
const TMP_DIR = path.join(os.tmpdir(), 'zviewer-dev-backend');
const EXT = process.platform === 'win32' ? '.exe' : '';

// 只关心这些后缀：改脚本、文档、测试数据不该触发重启
const WATCH_RE = /\.(go|mod|sum)$/;
// 监听根是 backend-go，但里面有几类目录与运行无关，逐条排除
const IGNORED_DIRS = ['.git', 'tmp', 'testdata', 'scripts', 'node_modules', 'dist'];
// 编辑器保存常常一次触发多个事件（写入、属性、临时文件改名），攒一下再编译
const DEBOUNCE_MS = 250;

const noWatch = process.argv.includes('--no-watch');

let child = null;
let building = false;
let pending = false;
let shuttingDown = false;
let seq = 0;
let debounceTimer = null;

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`\u001b[36m[dev ${t}]\u001b[0m ${msg}`);
}

function warn(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`\u001b[33m[dev ${t}]\u001b[0m ${msg}`);
}

/** 编译到指定路径；返回是否成功。stdout/stderr 直接透传，goroutine 的编译错误原样可读。 */
function build(outFile) {
  return new Promise((resolve) => {
    const proc = spawn(
      'go',
      // dev 构建不 strip（-s -w 会让链接慢一点），也不 -trimpath（要看到真实路径的报错）
      ['build', '-o', outFile, './cmd/zviewer-server'],
      {
        cwd: GO_DIR,
        stdio: 'inherit',
        env: {
          ...process.env,
          CGO_ENABLED: '0',
          GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,direct',
        },
      },
    );
    proc.on('error', (err) => {
      warn(`无法执行 go（确认 Go 工具链在 PATH 里）: ${err.message}`);
      resolve(false);
    });
    proc.on('exit', (code) => resolve(code === 0));
  });
}

function startChild(bin) {
  const proc = spawn(bin, [], {
    // 与 start-prod 一致：cwd 是仓库根，Go 版据此向上探测 projectRoot
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  child = proc;

  proc.on('error', (err) => warn(`后端启动失败: ${err.message}`));
  proc.on('exit', (code, signal) => {
    // 主动重启时 child 已经换成新进程（或已置空），这时不报「意外退出」
    if (child !== proc) return;
    child = null;
    if (shuttingDown) return;
    // 最常见的两种意外退出：端口被占用（上一次的服务没停干净）、配置文件缺失。
    // 这两种在新版 Go 输出里都是 fatal 一行，但补一句「怎么办」能省一次排查。
    const hint = code !== 0 ? '（若是端口被占用，先停掉仍在运行的旧后端）' : '';
    warn(
      `后端进程退出（code=${code}${signal ? `, signal=${signal}` : ''}），` +
        `等待文件改动后自动重启${hint}`,
    );
  });
  return proc;
}

/** 停掉当前进程并等它真退出（否则 Windows 上临时 exe 还被占用，删不掉）。 */
function stopChild() {
  return new Promise((resolve) => {
    const proc = child;
    if (!proc) return resolve();
    child = null;

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    proc.once('exit', finish);
    try {
      proc.kill();
    } catch {
      finish();
    }
    // Windows 上 kill() 是 TerminateProcess，通常瞬间完成；这里只是兜底防挂住
    const timer = setTimeout(() => {
      try {
        if (proc.pid) process.kill(proc.pid, 'SIGKILL');
      } catch {
        /* 已经死了 */
      }
      finish();
    }, 2500);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** 清掉本目录里除当前产物外的旧 exe，避免临时目录越积越多。 */
function cleanupBins(keep) {
  let files = [];
  try {
    files = fs.readdirSync(TMP_DIR);
  } catch {
    return;
  }
  for (const name of files) {
    if (!name.startsWith('zviewer-server-')) continue;
    const full = path.join(TMP_DIR, name);
    if (full === keep) continue;
    try {
      fs.unlinkSync(full);
    } catch {
      // 旧进程刚退出时句柄可能还没释放，下次再清，忽略
    }
  }
}

async function rebuildAndRestart(reason) {
  if (shuttingDown) return;
  if (building) {
    pending = true;
    return;
  }
  building = true;

  const bin = path.join(TMP_DIR, `zviewer-server-${++seq}${EXT}`);
  const startedAt = Date.now();
  log(`编译中…（${reason}）`);

  const ok = await build(bin);
  building = false;

  if (shuttingDown) {
    try {
      fs.unlinkSync(bin);
    } catch {
      /* ignore */
    }
    return;
  }

  if (!ok) {
    warn('编译失败：保留当前正在运行的进程，修好保存后会自动重试');
    if (pending) {
      pending = false;
      schedule('排队中的改动');
    }
    return;
  }

  await stopChild();
  if (shuttingDown) return;
  const proc = startChild(bin);
  cleanupBins(bin);
  log(`已启动（PID ${proc.pid}），用时 ${Date.now() - startedAt}ms`);

  if (pending) {
    pending = false;
    schedule('排队中的改动');
  }
}

function schedule(reason) {
  if (shuttingDown || noWatch) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void rebuildAndRestart(reason);
  }, DEBOUNCE_MS);
}

function isIgnored(relPath) {
  const norm = relPath.split(path.sep).join('/');
  if (norm.startsWith('../')) return true;
  const first = norm.split('/')[0];
  return IGNORED_DIRS.includes(first);
}

function watch() {
  let watcher;
  try {
    watcher = fs.watch(GO_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (isIgnored(rel)) return;
      if (!WATCH_RE.test(rel)) return;
      schedule(rel.split(path.sep).join('/'));
    });
  } catch (err) {
    warn(`目录监听启动失败: ${err.message}`);
    warn('后端已启动，但改代码不会自动重启（可改用 --no-watch 语义手动重跑）');
    return null;
  }
  watcher.on('error', (err) => warn(`监听出错: ${err.message}`));
  log(`监听 backend-go/**/*.{go,mod,sum}，保存即重启（Ctrl+C 退出）`);
  return watcher;
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (debounceTimer) clearTimeout(debounceTimer);
  log(`收到 ${signal}，正在停止…`);
  // 不 await：进程退出钩子里不能用异步，直接同步杀并立刻走人
  const proc = child;
  child = null;
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* 已经退出 */
    }
  }
}

function main() {
  if (!fs.existsSync(path.join(GO_DIR, 'go.mod'))) {
    console.error(`✗ 找不到 Go 模块: ${GO_DIR}/go.mod`);
    process.exit(1);
  }
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // 上一次可能被强杀，留下占用中的 exe，能删就删
  cleanupBins('');

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      shutdown(sig);
      // 给子进程一个事件循环周期发 TerminateProcess，再退出
      setTimeout(() => process.exit(0), 120);
    });
  }
  // 兜底：父进程被别的机制杀掉时也带走子进程
  process.on('exit', () => {
    if (child) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  });

  void rebuildAndRestart('首次启动').then(() => {
    if (!noWatch) watch();
  });
}

main();
