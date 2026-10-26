// 组装可分发目录：原生壳 + 进程监管宿主 + 运行包 + CLI / frpc（仅客户端）与许可证。
// 产物默认 desktop/dist-gui/zviewer-windows-x64-GUI，可用 ZVIEWER_OUT_DIR 改写。
// 目录名与命令行包一致，仅追加 GUI 后缀，使同一次发布里两个包一眼可辨。
//
// 用法：
//   node scripts/build-dist.mjs               完整打包
//   node scripts/build-dist.mjs --skip-tools  跳过 FRP 下载（缓存已就绪时）
// CLI 固定从运行包的网页目录取（dist/win/frontend/dist），缺了直接报错——运行包必然带它。
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_EXE_NAME } from './shell-entry.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const desktop = root;
const repo = dirname(desktop);
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const flags = new Set(process.argv.slice(2));
const tools = join(desktop, '.runtime', 'tools');
const frpDir = join(tools, 'frp_0.71.1_windows_amd64');
const meshDir = join(tools, 'easytier');
const cliDir = join(tools, 'zviewer-cli');
const runtimeSource = process.env.ZVIEWER_RUNTIME_ROOT || join(repo, 'dist', 'win');
// CLI 固定从运行包的网页目录取：build-all 会把 frontend/public 的
// zviewer-cli-windows-amd64.exe 原样复制到 dist/win/frontend/dist，网页「下载 CLI」
// 用的也是这份。这里只判断存在性，不校验摘要——运行包里必然带它，缺了说明运行包
// 没打全，直接报错而不是去源码重建（壳从 runtime/<名字> 拉起代理，所以再复制过去）。
const cliSource = join(runtimeSource, 'frontend', 'dist', 'zviewer-cli-windows-amd64.exe');
const outRoot = process.env.ZVIEWER_OUT_DIR || join(desktop, 'dist-gui');
const distribution = join(outRoot, 'zviewer-windows-x64-GUI');

function requireFile(file, hint) {
  if (!existsSync(file)) throw new Error(`缺少 ${file}${hint ? '：' + hint : ''}`);
  return file;
}

requireFile(join(runtimeSource, 'zviewer-backend.exe'), '先用 node build-all.js --win 生成运行包，或设置 ZVIEWER_RUNTIME_ROOT');
requireFile(join(runtimeSource, 'livekit-server.exe'));

if (!flags.has('--skip-tools')) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(desktop, 'scripts', 'prepare-tools.ps1')], { stdio: 'inherit', windowsHide: true });
}
requireFile(cliSource, '运行包的网页目录应带 CLI（node build-all.js --win 会从 frontend/public 复制过去）');

if (existsSync(distribution)) throw new Error(`拒绝覆盖已存在的分发包：${distribution}`);
mkdirSync(distribution, { recursive: true });

const shell = join(distribution, SHELL_EXE_NAME);
execFileSync(process.execPath, [join(desktop, 'scripts', 'build-shell.mjs'), '--release'], {
  cwd: desktop, stdio: 'inherit', env: { ...process.env, ZVIEWER_OUT_DIR: distribution }
});
statSync(shell);

// 壳在 runtime/ 里找后端与网页，在 exe 同级的 assets/ 里找进程监管宿主。
const runtime = join(distribution, 'runtime');
mkdirSync(runtime, { recursive: true });
mkdirSync(join(distribution, 'assets'), { recursive: true });
for (const name of ['zviewer-backend.exe', 'livekit-server.exe']) {
  copyFileSync(join(runtimeSource, name), join(runtime, name));
}
cpSync(join(runtimeSource, 'frontend', 'dist'), join(runtime, 'frontend', 'dist'), { recursive: true });
// Music is external to Go: include a pinned service and Node in every GUI package.
execFileSync(process.execPath, [join(desktop, 'scripts', 'prepare-music.mjs'), join(runtime, 'ncm')], { stdio: 'inherit', windowsHide: true });
for (const name of ['frpc.exe']) {
  if (existsSync(join(frpDir, name))) copyFileSync(join(frpDir, name), join(runtime, name));
}
// EasyTier 虚拟组网：壳在 runtime/mesh 里找 easytier-core / easytier-cli，缺 core 包直接报错。
requireFile(join(meshDir, 'easytier-core.exe'), '缺少组网组件，先跑 scripts/prepare-tools.ps1 或去掉 --skip-tools');
const meshTarget = join(runtime, 'mesh');
mkdirSync(meshTarget, { recursive: true });
for (const name of ['easytier-core.exe', 'easytier-cli.exe', 'Packet.dll', 'WinDivert64.sys', 'wintun.dll']) {
  if (existsSync(join(meshDir, name))) copyFileSync(join(meshDir, name), join(meshTarget, name));
}
copyFileSync(join(desktop, 'assets', 'ZViewer.ProcessHost.exe'), join(distribution, 'assets', 'ZViewer.ProcessHost.exe'));

// CLI 固定放进 runtime/：壳只从运行包里找它，缺了就等于没有高画质代理。
// 运行包网页目录那份已经是同一个文件，无需再覆盖一遍。
copyFileSync(cliSource, join(runtime, 'zviewer-cli-windows-amd64.exe'));
// 顺手带上 CLI 的 MIT 许可证（本地有源码仓库或 prepare-cli 产物时才有）。
const cliLicense = [join(cliDir, 'LICENSE'), join(repo, '..', 'ZViewerCLI', 'LICENSE')].find((file) => existsSync(file));
if (cliLicense) copyFileSync(cliLicense, join(distribution, 'LICENSE-ZViewerCLI.txt'));
// 分发包不附使用说明：操作引导在 GUI 内的教程里，README 只留在源码仓库。
for (const [source, target] of [['LICENSE', 'LICENSE-ZViewer.txt']]) {
  const file = join(repo, source);
  if (existsSync(file)) copyFileSync(file, join(distribution, target));
}
if (existsSync(join(frpDir, 'LICENSE'))) copyFileSync(join(frpDir, 'LICENSE'), join(distribution, 'LICENSE-FRP.txt'));
// EasyTier 是 LGPL-3.0，聚合分发未修改的二进制必须带上许可证全文。
const meshLicense = join(meshDir, 'LICENSE-EasyTier.txt');
if (existsSync(meshLicense)) copyFileSync(meshLicense, join(distribution, 'LICENSE-EasyTier.txt'));
// 首次启动由壳自己生成独立 JWT 密钥，分发包里只放样例，绝不带真实 .env。
rmSync(join(runtime, '.env'), { force: true });
writeFileSync(join(runtime, '.env.example'), '# 不含任何真实凭据。桌面端首次启动时生成独立密钥。\nPORT=3333\nHOST=127.0.0.1\nNODE_ENV=production\n');

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
// CLI 只登记来源，不算也不校验摘要（运行包里必然有它，存在性已在上方 requireFile 卡过）。
function cliMeta(source) {
  return { source: relative(repo, source) };
}
function walk(dir) {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
const tracked = [
  SHELL_EXE_NAME,
  'assets/ZViewer.ProcessHost.exe',
  'runtime/zviewer-backend.exe',
  'runtime/livekit-server.exe',
  'runtime/frpc.exe',
  'runtime/mesh/easytier-core.exe',
  'runtime/mesh/easytier-cli.exe',
  'runtime/zviewer-cli-windows-amd64.exe'
];
const CLI_ENTRY = 'runtime/zviewer-cli-windows-amd64.exe';
const files = tracked.filter(name => existsSync(join(distribution, name))).map(name => {
  const full = join(distribution, name);
  const entry = { file: name, bytes: statSync(full).size };
  // CLI 只确认存在，不算摘要。
  if (name !== CLI_ENTRY) entry.sha256 = sha256(full);
  return entry;
});
const manifest = {
  version: pkg.version,
  format: 'directory',
  entry: SHELL_EXE_NAME,
  shell: 'wails-v2 / go',
  runtime: 'runtime',
  installation: false,
  selfExtracting: false,
  singleInstance: true,
  signed: false,
  iconEmbedded: true,
  frp: '0.71.1',
  mesh: '2.6.4',
  cli: cliMeta(cliSource),
  fileCount: walk(distribution).length,
  files
};
const manifestPath = join(distribution, 'BUILD-MANIFEST.json');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

console.log(`分发包：${distribution}`);
console.log(`  入口：${relative(outRoot, shell)}  文件数：${manifest.fileCount}`);
