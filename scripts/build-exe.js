/**
 * 后端编译为单文件 exe 的构建脚本。
 *
 * 使用 @yao-pkg/pkg 将 Node.js 后端 + 运行时打包为独立的可执行文件。
 * 静态资源（sql.js 的 wasm 文件）通过 root package.json 的
 * pkg.assets 配置包含到快照中。
 *
 * 用法：
 *   node scripts/build-exe.js                # 构建 + 打包
 *   node scripts/build-exe.js --skip-build    # 仅打包（跳过 tsc 编译）
 *
 * 输出：
 *   dist/zviewer-backend.exe  - 单文件可执行程序
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const DIST_EXE = path.join(ROOT, 'dist');
const OUTPUT_NAME = 'zviewer-backend.exe';
const OUTPUT_PATH = path.join(DIST_EXE, OUTPUT_NAME);

const skipBuild = process.argv.includes('--skip-build');

function log(msg) {
  console.log(`  ${msg}`);
}

/** 递归复制目录 */
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

function main() {
  console.log('========================================');
  console.log('  ZViewer 后端 exe 构建');
  console.log('========================================');

  // 确保输出目录存在
  fs.mkdirSync(DIST_EXE, { recursive: true });

  // Step 1: 编译 TypeScript
  if (!skipBuild) {
    log('编译 TypeScript...');
    execSync('npm run build', { cwd: BACKEND, stdio: 'inherit' });
    log('TypeScript 编译完成');
  } else {
    log('跳过编译（--skip-build）');
  }

  // Step 2: 确认编译产物存在
  const entry = path.join(BACKEND, 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    console.error(`  错误：编译产物不存在: ${entry}`);
    console.error('  请先运行 npm run build -w backend');
    process.exit(1);
  }

  // Step 3: 运行 pkg 打包
  log('打包为 exe（此过程可能耗时 1-3 分钟）...');
  log(`  入口: ${entry}`);
  log(`  输出: ${OUTPUT_PATH}`);

  // 静态资源（sql.js 的 wasm 文件）通过 --config 显式指定
  // root package.json 中的 pkg.assets 配置自动包含到快照中。
  const cmd = [
    'npx',
    'pkg',
    JSON.stringify(entry),
    `--targets`, `node26-win-x64`,
    `--output`, JSON.stringify(OUTPUT_PATH),
    // 禁用 v8 bytecode cache：保证 cross-compile 的产物在目标平台可运行
    '--public',
    '--public-packages', `"*"`,
    `-c`, JSON.stringify(path.join(ROOT, 'package.json')),
  ].join(' ');

  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });

  // Step 4: 验证
  if (!fs.existsSync(OUTPUT_PATH)) {
    console.error(`  错误：打包失败，未生成 ${OUTPUT_PATH}`);
    process.exit(1);
  }

  const stats = fs.statSync(OUTPUT_PATH);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);
  log(`构建完成！`);
  log(`  文件: ${OUTPUT_PATH}`);
  log(`  大小: ${sizeMB} MB`);
  console.log('========================================');
}

main();