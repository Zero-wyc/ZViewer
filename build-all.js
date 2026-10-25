#!/usr/bin/env node

/**
 * ZViewer 一键编译脚本。
 *
 * 交互式选择目标平台，自动完成前后端编译、pkg 打包、原生模块复制。
 *
 * 支持的目标平台：
 *   1) Windows  (win-x64)
 *   2) Linux    (linux-x64)
 *   3) 全平台   (以上全部)
 *   4) 自定义   (手动输入逗号分隔的 pkg target 列表)
 *
 * 用法：
 *   node build-all.js                # 交互式菜单
 *   node build-all.js --win          # 直接打包 Windows
 *   node build-all.js --linux        # 直接打包 Linux
 *   node build-all.js --all          # 直接打包全平台
 *   node build-all.js --skip-build   # 跳过 tsc/vite 编译
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ==================== 配置 ====================

const ROOT = path.resolve(__dirname);
const FRONTEND = path.join(ROOT, 'frontend');
const DIST_EXE = path.join(ROOT, 'dist');
const PKG_CONFIG = path.join(ROOT, 'package.json');
const PACKAGING_DIR = path.join(ROOT, 'packaging');

// pkg target 定义
const PLATFORM_TARGETS = {
  win: {
    label: 'Windows',
    folder: 'win',
    targets: ['node26-win-x64'],
  },
  linux: {
    label: 'Linux',
    folder: 'linux',
    targets: ['node26-linux-x64'],
  },
}

// 预定义平台组
const PLATFORM_PRESETS = [
  {
    key: 'win',
    label: 'Windows',
    description: 'node26-win-x64',
    platforms: ['win'],
  },
  {
    key: 'linux',
    label: 'Linux',
    description: 'node26-linux-x64',
    platforms: ['linux'],
  },
  {
    key: 'all',
    label: '全平台',
    description: 'Windows + Linux',
    platforms: ['win', 'linux'],
  },
]

const SKIP_BUILD = process.argv.includes('--skip-build');

// 后端只有 Go 实现（backend-go）。原来的 Node 后端（`backend/` + pkg 打包）
// 已在 2026-10 的收尾里删除，因此不再有 `--backend=node` 开关：
// 分发包里的 `zviewer-backend.exe` 一律由 `backend-go` 交叉编译产出，
// 桌面壳仍按**子进程**托管它（ZViewer.ProcessHost.exe + Job Object），
// 环境变量契约不变 —— 由 backend-go/scripts/desktop-env-smoke.sh 守着。

// 命令行快捷方式
const CLI_SHORTCUTS = {
  '--win': ['win'],
  '--linux': ['linux'],
  '--all': ['win', 'linux'],
}

// 解析 --custom 参数
let CUSTOM_TARGETS = null;
const customIdx = process.argv.indexOf('--custom');
if (customIdx !== -1 && customIdx + 1 < process.argv.length) {
  CUSTOM_TARGETS = process.argv[customIdx + 1];
}

// ==================== 工具函数 ====================

function log(msg) {
  console.log(`  ${msg}`);
}

function warn(msg) {
  console.log(`  ⚠ ${msg}`);
}

function success(msg) {
  console.log(`  ✔ ${msg}`);
}

function error(msg) {
  console.log(`  ✘ ${msg}`);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function getDirSize(dir) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // 使用 entry.parentPath（Node.js 20+）构建完整路径
      const fullPath = entry.parentPath
        ? path.join(entry.parentPath, entry.name)
        : path.join(dir, entry.name);
      size += fs.statSync(fullPath).size;
    }
  } catch { /* ignore */ }
  return size > 1024 * 1024
    ? `${(size / (1024 * 1024)).toFixed(1)} MB`
    : `${(size / 1024).toFixed(0)} KB`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ==================== 交互式菜单 ====================

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim().toLowerCase());
    });
  });
}

async function showInteractiveMenu() {
  const rl = createInterface();

  console.log('');
  console.log('========================================');
  console.log('  ZViewer 一键编译');
  console.log('========================================');
  console.log('');

  // 第一步：选择平台
  console.log('请选择目标平台：');
  PLATFORM_PRESETS.forEach((p, i) => {
    console.log(`  ${i + 1}) ${p.label.padEnd(10)} ${p.description}`);
  });
  console.log('  4) 自定义 (手动输入 pkg target)');
  console.log('');

  let platformKeys = [];
  let valid = false;

  while (!valid) {
    const answer = await askQuestion(rl, '请输入编号 (1-4) [默认: 1]: ');
    const choice = answer || '1';
    const num = parseInt(choice, 10);

    if (num >= 1 && num <= 3) {
      platformKeys = PLATFORM_PRESETS[num - 1].platforms;
      valid = true;
    } else if (num === 5) {
      const custom = await askQuestion(rl, '请输入 pkg target (逗号分隔，如 "node26-win-x64,node26-linux-x64"): ');
      if (custom) {
        // 将自定义 target 映射到 platformKeys
        const targets = custom.split(',').map(t => t.trim());
        // 尝试匹配已知平台
        for (const target of targets) {
          let matched = false;
          for (const [key, def] of Object.entries(PLATFORM_TARGETS)) {
            if (def.targets.includes(target)) {
              if (!platformKeys.includes(key)) platformKeys.push(key);
              matched = true;
              break;
            }
          }
          if (!matched) {
            // 未知 target，创建临时平台定义
            const folderName = target.replace(/[^a-z0-9]/g, '-');
            PLATFORM_TARGETS[`custom-${folderName}`] = {
              label: target,
              folder: `custom-${folderName}`,
              targets: [target],
            };
            platformKeys.push(`custom-${folderName}`);
          }
        }
        valid = true;
      }
    } else {
      console.log('  无效输入，请输入 1-4');
    }
  }

  // 第二步：确认是否构建后端
  // 前端始终需要构建（统一端口后由后端托管前端静态文件）
  const buildBackend = await askQuestion(rl, '是否构建后端 (y/n) [默认: y]: ');
  const shouldBuildBackend = buildBackend !== 'n' && buildBackend !== 'N';

  rl.close();

  return { platformKeys, shouldBuildBackend };
}

// ==================== 构建逻辑 ====================

function getPlatformDetails(platformKeys) {
  return platformKeys.map(key => {
    const def = PLATFORM_TARGETS[key];
    if (!def) throw new Error(`未知平台: ${key}`);
    return def;
  });
}

function buildFrontend() {
  console.log('');
  console.log('>>> 构建前端静态资源...');
  const frontendDist = path.join(FRONTEND, 'dist');
  if (!SKIP_BUILD) {
    log('运行 vite build...');
    // 从项目根 .env（或 .env.example）读取 NMS 端口并透传给前端构建，
    // 前端 OBS 推流/FLV 拉流地址据此生成（VITE_RTMP_PORT / VITE_HTTP_FLV_PORT）。
    // 两者都没有时保持前端默认值（3334 / 3335），与 Go 侧 nms 的默认一致。
    for (const candidate of [path.join(ROOT, '.env'), path.join(ROOT, '.env.example')]) {
      if (!fs.existsSync(candidate)) continue;
      const envContent = fs.readFileSync(candidate, 'utf8');
      const rtmpMatch = envContent.match(/^\s*RTMP_PORT\s*=\s*"?(\d+)"?/m);
      const flvMatch = envContent.match(/^\s*HTTP_FLV_PORT\s*=\s*"?(\d+)"?/m);
      if (rtmpMatch) process.env.VITE_RTMP_PORT = rtmpMatch[1];
      if (flvMatch) process.env.VITE_HTTP_FLV_PORT = flvMatch[1];
      break;
    }
    execSync('npm run build -w frontend', { cwd: ROOT, stdio: 'inherit' });
    success('前端构建完成');
  } else {
    if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, 'index.html'))) {
      error('前端构建产物不存在，无法跳过构建');
      process.exit(1);
    }
    log('跳过前端构建 (--skip-build)');
  }

  // 确认产物存在
  if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, 'index.html'))) {
    error('前端构建失败：未生成 index.html');
    process.exit(1);
  }
  return frontendDist;
}

function buildBackend() {
  console.log('');
  console.log('>>> 后端实现: Go（backend-go），无需额外的编译步骤');
  // Go 侧由 packageBackend 里的 `go build` 交叉编译，这里不产出中间产物。
  return null;
}

// 交叉编译 Go 后端到指定产物。
//
// CGO_ENABLED=0 是硬要求：SQLite 驱动用纯 Go 的 modernc.org/sqlite，
// 开了 cgo 就没法在 Windows 宿主上直接产出 linux 二进制。
function buildGoBackend(target, outputPath) {
  const isWin = target.includes('win');
  const isArm = target.includes('arm64');
  const env = {
    ...process.env,
    GOOS: isWin ? 'windows' : 'linux',
    GOARCH: isArm ? 'arm64' : 'amd64',
    CGO_ENABLED: '0',
  };
  // GOPROXY 走国内镜像：proxy.golang.org 在本机不通（见 NOTES-GO）
  if (!env.GOPROXY) env.GOPROXY = 'https://goproxy.cn,direct';

  execFileSync(
    'go',
    ['build', '-trimpath', '-ldflags', '-s -w', '-o', outputPath, './cmd/zviewer-server'],
    { cwd: path.join(ROOT, 'backend-go'), env, stdio: 'inherit' },
  );
}

function packageBackend(targetPlatforms, frontendDist) {
  console.log('');
  console.log('>>> 打包后端 (go build)...');

  const results = [];

  for (const platform of targetPlatforms) {
    for (const target of platform.targets) {
      const outputFolder = path.join(DIST_EXE, platform.folder);
      const outputName = `zviewer-backend${target.includes('win') ? '.exe' : ''}`;
      const outputPath = path.join(outputFolder, outputName);

      fs.mkdirSync(outputFolder, { recursive: true });

      log(`打包后端 → ${target} (${platform.label})...`);

      try {
        buildGoBackend(target, outputPath);
      } catch (e) {
        error(`Go 后端编译失败 (${target}): ${e.message}`);
        process.exit(1);
      }
      if (!fs.existsSync(outputPath)) {
        warn(`后端打包失败：未生成 ${outputPath}`);
        continue;
      }

      // 语音聊天（LiveKit）：伴生二进制随产物分发，后端启动时自动拉起
      // （见 backend-go/internal/livekit）。
      //
      // **优先用仓库内的那份**（backend-go/dev-bin/），不联网：
      // 它和 dev 环境跑的是同一个文件，构建结果可复现，也不受 GitHub
      // Releases 可达性影响（国内网络下这条下载经常卡住）。
      // 仓库里没有对应平台的二进制时才回落到下载。
      const LIVEKIT_VERSION = 'v1.13.7';
      const isWin = target.includes('win');
      const lkAsset = isWin
        ? `livekit_${LIVEKIT_VERSION.slice(1)}_windows_amd64.zip`
        : `livekit_${LIVEKIT_VERSION.slice(1)}_linux_amd64.tar.gz`;
      const lkUrl = `https://github.com/livekit/livekit-server/releases/download/${LIVEKIT_VERSION}/${lkAsset}`;
      const lkDest = path.join(outputFolder, isWin ? 'livekit-server.exe' : 'livekit-server');
      const lkDevBin = path.join(ROOT, 'backend-go', 'dev-bin', isWin ? 'livekit-server.exe' : 'livekit-server');
      if (fs.existsSync(lkDest)) {
        success(`livekit-server 已存在: ${platform.folder}/`);
      } else if (fs.existsSync(lkDevBin)) {
        fs.copyFileSync(lkDevBin, lkDest);
        if (!isWin) {
          try { fs.chmodSync(lkDest, 0o755); } catch { /* non-Unix host */ }
        }
        // 产物里一直跟着一份 livekit 的 LICENSE（原先来自 zip 解压），
        // 改成直接复制二进制后要显式带上，否则分发包少了第三方许可。
        const lkLicense = path.join(path.dirname(lkDevBin), 'LICENSE');
        if (fs.existsSync(lkLicense)) {
          fs.copyFileSync(lkLicense, path.join(outputFolder, 'LICENSE'));
        }
        success(`livekit-server: 用仓库内二进制 backend-go/dev-bin/${path.basename(lkDevBin)} → ${platform.folder}/`);
      } else {
        const tmpArchive = path.join(outputFolder, lkAsset);
        try {
          log(`下载 livekit-server ${LIVEKIT_VERSION} (${platform.label})...`);
          execSync(
            `curl -L --fail --retry 3 -o ${JSON.stringify(tmpArchive)} ${lkUrl}`,
            { cwd: ROOT, stdio: 'pipe' }
          );
          // zip 用 PowerShell 解压（Git Bash 的 GNU tar 不支持 zip），
          // tar.gz 用 bsdtar/GNU tar 均可
          if (isWin) {
            execSync(
              `powershell -NoProfile -Command "Expand-Archive -Force -Path ${JSON.stringify(tmpArchive)} -DestinationPath ${JSON.stringify(outputFolder)}"`,
              { stdio: 'pipe' }
            );
          } else {
            // Windows 宿主上 PATH 里的 Git Bash MSYS tar 会把盘符冒号
            // 当远程主机（"Cannot connect to f: resolve failed"），
            // 显式用系统自带的 bsdtar（支持 Windows 路径）；用原生双引号
            // 包裹而非 JSON.stringify（后者会把反斜杠转义成 \\）。
            const tarBin = process.platform === 'win32'
              ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
              : 'tar';
            execSync(`"${tarBin}" -xzf "${tmpArchive}" -C "${outputFolder}"`, {
              stdio: 'pipe',
            });
          }
          if (!fs.existsSync(lkDest)) {
            throw new Error(`解压后未找到 ${lkDest}`);
          }
          if (!isWin) {
            try { fs.chmodSync(lkDest, 0o755); } catch { /* non-Unix host */ }
          }
          success(`livekit-server: ${platform.folder}/${path.basename(lkDest)}`);
        } catch (e) {
          // CI 下下载失败必须硬失败：缺伴生二进制的产物部署后语音全断
          // 且启动日志不易察觉；本地构建降级为警告（可手动放置）
          const msg = `livekit-server 下载/解压失败: ${e.message}——语音功能将不可用；可手动从 ${lkUrl} 放置到 ${outputFolder}`;
          if (process.env.CI) {
            error(msg);
            process.exit(1);
          }
          warn(msg);
        } finally {
          try { fs.rmSync(tmpArchive, { force: true }); } catch { /* ignore */ }
        }
      }

      // 复制项目根的 .env；保留 PORT 等端口配置，
      // 由启动脚本（start.sh / start-win.ps1）读取并按需覆盖 exe 的环境变量。
      // CI 环境中 .env 被 .gitignore 排除，回退到 .env.example。
      const envDest = path.join(outputFolder, '.env');
      if (!fs.existsSync(envDest)) {
        const envCandidates = [
          path.join(ROOT, '.env'),
          path.join(ROOT, '.env.example'),
        ];
        const envSrc = envCandidates.find((p) => fs.existsSync(p));
        if (envSrc) {
          const envContent = fs.readFileSync(envSrc, 'utf8');
          fs.writeFileSync(envDest, envContent, 'utf8');
          log(`已复制 .env 配置（来源: ${path.basename(envSrc)}）`);
        } else {
          // 兜底：创建空文件，避免后续 Docker COPY 失败
          fs.writeFileSync(envDest, '', 'utf8');
          log('已创建空 .env（未找到 .env / .env.example）');
        }
      }

      // 复制前端静态文件到产物目录（统一端口：后端 exe 托管 frontend/dist）
      const outputFrontendDist = path.join(outputFolder, 'frontend', 'dist');
      if (fs.existsSync(outputFrontendDist)) {
        fs.rmSync(outputFrontendDist, { recursive: true, force: true });
      }
      copyDirSync(frontendDist, outputFrontendDist);
      log(`已复制前端静态文件: frontend/dist/ (${getDirSize(outputFrontendDist)})`);

      const stats = fs.statSync(outputPath);
      results.push({
        type: '后端',
        platform: platform.label,
        target,
        path: outputPath,
        size: stats.size,
      });
      success(`后端 ${target}: ${outputPath} (${formatBytes(stats.size)})`);
    }
  }

  return results;
}

// Copy per-platform one-click start scripts into the output folders.
function copyStartScripts(targetPlatforms) {
  // 每个平台可复制多个文件（Windows: bat 转发器 + ps1 主逻辑）
  const scriptMap = {
    win: [
      { src: 'start-win.bat', dest: 'start.bat' },
      { src: 'start-win.ps1', dest: 'start.ps1' },
    ],
    linux: [{ src: 'start-linux.sh', dest: 'start.sh' }],
  };

  const folders = [];
  for (const p of targetPlatforms) {
    if (!folders.includes(p.folder)) folders.push(p.folder);
  }

  for (const folder of folders) {
    const files = scriptMap[folder];
    if (!files) {
      warn(`skip start script: unknown folder ${folder}`);
      continue;
    }
    const outputFolder = path.join(DIST_EXE, folder);
    fs.mkdirSync(outputFolder, { recursive: true });

    for (const mapping of files) {
      const srcPath = path.join(PACKAGING_DIR, mapping.src);
      if (!fs.existsSync(srcPath)) {
        warn(`start script template not found: ${srcPath}`);
        continue;
      }
      const destPath = path.join(outputFolder, mapping.dest);
      fs.copyFileSync(srcPath, destPath);
      // Set executable permission on Unix-like build hosts (no-op on Windows)
      if (mapping.dest.endsWith('.sh') || mapping.dest.endsWith('.command')) {
        try { fs.chmodSync(destPath, 0o755); } catch { /* ignore on non-Unix hosts */ }
      }
      success(`start script: ${folder}/${mapping.dest}`);
    }
  }
}

// Copy package.json into each output folder so the updater can read the version.
function copyPackageJson(targetPlatforms) {
  const folders = [];
  for (const p of targetPlatforms) {
    if (!folders.includes(p.folder)) folders.push(p.folder);
  }

  for (const folder of folders) {
    const outputFolder = path.join(DIST_EXE, folder);
    const destPath = path.join(outputFolder, 'package.json');
    try {
      fs.copyFileSync(PKG_CONFIG, destPath);
      success(`package.json: ${folder}/package.json`);
    } catch (e) {
      warn(`failed to copy package.json to ${folder}: ${e.message}`);
    }
  }
}

function printSummary(allResults) {
  console.log('');
  console.log('========================================');
  console.log('  编译完成');
  console.log('========================================');

  // 按文件夹分组
  const grouped = {};
  for (const r of allResults) {
    const folder = path.dirname(r.path);
    if (!grouped[folder]) grouped[folder] = { files: [], folder };
    grouped[folder].files.push(r);
  }

  for (const [folderPath, group] of Object.entries(grouped)) {
    const folderName = path.relative(DIST_EXE, folderPath);
    const totalSize = group.files.reduce((sum, f) => sum + f.size, 0);
    console.log('');
    console.log(`  📁 ${folderName}/`);
    console.log(`     大小: ${formatBytes(totalSize)}`);

    for (const f of group.files) {
      const filename = path.basename(f.path);
      console.log(`      ${f.type.padEnd(6)} ${filename.padEnd(30)} ${formatBytes(f.size)}`);
    }
  }

  console.log('');
  console.log('  输出目录: ' + DIST_EXE);
  console.log('========================================');
}

// ==================== 主入口 ====================

async function main() {
  console.log('========================================');
  console.log('  ZViewer 一键编译工具');
  console.log('========================================');
  console.log(`  工作目录: ${ROOT}`);
  console.log(`  编译模式: ${SKIP_BUILD ? '跳过编译 (--skip-build)' : '完整编译'}`);
  console.log('========================================');

  // 解析命令行参数或交互式选择
  let platformKeys = null;
  let shouldBuildBackend = true;
  let isCustom = false;

  // 优先处理 --custom 自定义 target
  if (CUSTOM_TARGETS) {
    isCustom = true;
    platformKeys = [];
    const targets = CUSTOM_TARGETS.split(',').map(t => t.trim());
    for (const target of targets) {
      let matched = false;
      for (const [key, def] of Object.entries(PLATFORM_TARGETS)) {
        if (def.targets.includes(target)) {
          if (!platformKeys.includes(key)) platformKeys.push(key);
          matched = true;
          break;
        }
      }
      if (!matched) {
        const folderName = target.replace(/[^a-z0-9]/g, '-');
        PLATFORM_TARGETS[`custom-${folderName}`] = {
          label: target,
          folder: `custom-${folderName}`,
          targets: [target],
        };
        platformKeys.push(`custom-${folderName}`);
      }
    }
    console.log(`  命令行模式: --custom ${CUSTOM_TARGETS}`);
    console.log(`  目标平台: ${targets.join(', ')}`);
    console.log('');
  }

  if (!platformKeys) {
    for (const [flag, keys] of Object.entries(CLI_SHORTCUTS)) {
      if (process.argv.includes(flag)) {
        platformKeys = keys;
        break;
      }
    }
  }

  if (platformKeys && !isCustom) {
    console.log(`  命令行模式: ${process.argv.find(a => a.startsWith('--') && a !== '--skip-build')}`);
    console.log(`  目标平台: ${platformKeys.map(k => PLATFORM_TARGETS[k]?.label || k).join(', ')}`);
    console.log('');
  } else if (!platformKeys) {
    const menu = await showInteractiveMenu();
    platformKeys = menu.platformKeys;
    shouldBuildBackend = menu.shouldBuildBackend;
  }

  const targetPlatforms = getPlatformDetails(platformKeys);
  console.log('');
  console.log(`目标平台: ${targetPlatforms.map(p => p.label).join(', ')}`);
  console.log(`pkg targets: ${targetPlatforms.flatMap(p => p.targets).join(', ')}`);
  console.log('');

  const allResults = [];

  // 1. 构建前端（统一端口后由后端托管前端静态文件，前端始终需要构建）
  const frontendDist = buildFrontend();

  // 2. 构建后端
  if (shouldBuildBackend) {
    buildBackend();
  } else {
    log('跳过后端编译 (--skip-build)：沿用产物目录里已有的 zviewer-backend');
  }

  // 3. 打包后端 exe（含复制 frontend/dist 到产物目录）
  if (shouldBuildBackend) {
    const backendResults = packageBackend(targetPlatforms, frontendDist);
    allResults.push(...backendResults);
  }

  // 4. 输出汇总

  // 复制各平台一键启动脚本到产物目录
  copyStartScripts(targetPlatforms);

  // 复制 package.json 到产物目录（供更新功能读取版本号）
  copyPackageJson(targetPlatforms);

  if (allResults.length > 0) {
    printSummary(allResults);
  } else {
    warn('没有生成任何文件');
  }
}

main().catch((err) => {
  console.error('');
  console.error('  错误:', err.message);
  process.exit(1);
});
