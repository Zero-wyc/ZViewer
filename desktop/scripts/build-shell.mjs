// 构建原生壳：编译进程监管宿主（C#），再编译 Wails/Go 主程序。
// 产物默认 desktop/build/bin/<SHELL_EXE_NAME>，可用 ZVIEWER_OUT_DIR 改写目录。
//
// 用法：
//   node scripts/build-shell.mjs                开发构建（带符号，隐藏控制台窗口）
//   node scripts/build-shell.mjs --dev          调试构建（不含 production，启用 WebView2 DevTools）
//   node scripts/build-shell.mjs --release      发布构建（-s -w 去符号）
//   node scripts/build-shell.mjs --console      保留控制台窗口，便于观察 panic
//   node scripts/build-shell.mjs --rebuild-host 强制重新编译 ProcessHost.exe
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, basename, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_EXE_NAME } from './shell-entry.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const flags = new Set(process.argv.slice(2));
const outDir = process.env.ZVIEWER_OUT_DIR || join(root, 'build', 'bin');
const out = join(outDir, SHELL_EXE_NAME);
const hostSource = join(root, 'native', 'ProcessHost.cs');
const hostExe = join(root, 'assets', 'ZViewer.ProcessHost.exe');
const iconSource = join(root, 'assets', 'app.ico');
// Go 链接器会自动合并主包目录下的 *.syso，EXE 的图标与版本资源都来自它。
const iconResource = join(root, 'rsrc_windows_amd64.syso');
// 规则文档：构建时把最新 crawler/docs/engine.md 同步成 EXE 内置副本（分享包可能不带 docs）。
const crawlerDocs = join(root, '..', 'crawler', 'docs', 'engine.md');
if (existsSync(crawlerDocs)) copyFileSync(crawlerDocs, join(root, 'assets', 'crawler-engine.md'));

function hostUpToDate() {
  if (!existsSync(hostExe)) return false;
  return statSync(hostExe).mtimeMs >= statSync(hostSource).mtimeMs;
}

// ProcessHost 是受管子进程的父进程，负责 Job Object 回收；缺失时壳仍能启动，
// 但子进程会变成孤儿，所以构建阶段尽力编译，失败只告警。
function buildHost() {
  if (!flags.has('--rebuild-host') && hostUpToDate()) {
    console.log('ProcessHost: 已是最新');
    return;
  }
  const windowsDir = process.env.WINDIR || 'C:\\Windows';
  const compiler = join(windowsDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!existsSync(compiler)) {
    console.warn('ProcessHost: 找不到 .NET Framework 4.x 编译器，沿用现有 assets/ZViewer.ProcessHost.exe');
    return;
  }
  mkdirSync(dirname(hostExe), { recursive: true });
  execFileSync(compiler, [
    '/nologo', '/target:exe', '/platform:x64', '/optimize+', '/debug-',
    `/out:${hostExe}`,
    `/win32icon:${join(root, 'assets', 'app.ico')}`,
    hostSource
  ], { stdio: 'inherit', windowsHide: true });
  console.log('ProcessHost: 已编译');
}

buildHost();

// 图标资源：目标是仓库内固化的 .syso，正常情况直接命中；换图标后靠 mtime 触发重建。
// rsrc 只是生成期工具，不属于运行时依赖，找得到就用，找不到就明确报错而不是静默出个无图标 EXE。
function findRsrc() {
  if (process.env.RSRC && existsSync(process.env.RSRC)) return process.env.RSRC;
  try {
    const gopath = execFileSync('go', ['env', 'GOPATH'], { encoding: 'utf8' }).trim();
    for (const base of gopath.split(delimiter)) {
      for (const name of ['rsrc.exe', 'rsrc']) {
        const candidate = join(base, 'bin', name);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // go 不在 PATH 时留给后面的 go build 报错
  }
  try {
    execFileSync('rsrc', ['-h'], { stdio: 'ignore' });
    return 'rsrc';
  } catch {
    return null;
  }
}

function ensureIconResource() {
  if (!existsSync(iconSource)) throw new Error(`图标源缺失：${iconSource}`);
  if (existsSync(iconResource) && statSync(iconResource).mtimeMs >= statSync(iconSource).mtimeMs) {
    console.log(`图标资源: ${basename(iconResource)} 已是最新`);
    return;
  }
  const rsrc = findRsrc();
  if (!rsrc) {
    throw new Error(
      `${basename(iconResource)} 缺失或过期，且找不到 rsrc 工具，EXE 会没有图标。\n` +
      '  安装：go install github.com/akavel/rsrc@latest\n' +
      `  生成：rsrc -ico ${iconSource} -o ${iconResource} -arch amd64`
    );
  }
  execFileSync(rsrc, ['-ico', iconSource, '-o', iconResource, '-arch', 'amd64'], { cwd: root, stdio: 'inherit' });
  console.log('图标资源: 已重新生成');
}

ensureIconResource();

mkdirSync(outDir, { recursive: true });
const linker = [`-X main.appVersion=${pkg.version}`];
// 没有 -H windowsgui 会带出控制台窗口，用户看到的就是一个黑框加窗口。
if (!flags.has('--console')) linker.push('-H', 'windowsgui');
if (flags.has('--release')) linker.push('-s', '-w');

// Wails 必须带 production 或 dev 标签才会生成真正的应用（缺了会弹「build tags」提示后空转），
// devtools 标签独立于此，单独打开 WebView2 的 DevTools（F12 / 右键检查）。
const dev = flags.has('--dev');
const tags = dev ? 'desktop,production,devtools' : 'desktop,production';
const goArgs = ['build', '-tags', tags, '-trimpath', '-ldflags', linker.join(' '), '-o', out, '.'];
console.log(`go ${goArgs.join(' ')}`);
execFileSync('go', goArgs, { cwd: root, stdio: 'inherit' });

console.log(`built ${out} (${pkg.version}, ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
