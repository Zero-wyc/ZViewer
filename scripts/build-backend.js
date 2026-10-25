/**
 * 把 Go 后端编译到 dist/（源码运行与分发包共用的唯一入口）。
 *
 * 为什么单独一个脚本，而不是在 package.json / start-prod.* 里各写一条 `go build`：
 * 产物名带平台后缀（Windows 是 zviewer-backend.exe，其它是 zviewer-backend），
 * 三个调用方（npm script、start-prod.sh、start-prod.ps1）如果各抄一份，总有一处会忘。
 *
 * 用法：
 *   node scripts/build-backend.js              # 编译到 dist/zviewer-backend[.exe]
 *   node scripts/build-backend.js --out <path> # 指定输出（分发包构建用）
 *
 * 约定：
 *   - CGO_ENABLED=0：驱动是纯 Go 的 modernc.org/sqlite，关掉 cgo 才能交叉编译；
 *   - -trimpath：去掉本机绝对路径，产物可复现；
 *   - -s -w：去掉符号表与调试信息（19MB 而不是 26MB）。
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const GO_DIR = path.join(ROOT, 'backend-go');
const DIST = path.join(ROOT, 'dist');
const EXT = process.platform === 'win32' ? '.exe' : '';

function argValue(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

function main() {
  const out = path.resolve(argValue('--out', path.join(DIST, `zviewer-backend${EXT}`)));

  if (!fs.existsSync(path.join(GO_DIR, 'go.mod'))) {
    console.error(`  ✗ 找不到 Go 模块: ${GO_DIR}/go.mod`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });

  console.log(`  编译 Go 后端 → ${path.relative(ROOT, out)}`);
  try {
    execFileSync(
      'go',
      ['build', '-trimpath', '-ldflags', '-s -w', '-o', out, './cmd/zviewer-server'],
      {
        cwd: GO_DIR,
        stdio: 'inherit',
        env: {
          ...process.env,
          CGO_ENABLED: '0',
          // 国内直连 proxy.golang.org 不通；已有依赖时不影响构建。
          GOFLAGS: process.env.GOFLAGS || '',
          GOPROXY: process.env.GOPROXY || 'https://goproxy.cn,direct',
        },
      },
    );
  } catch (err) {
    console.error('  ✗ go build 失败（确认已安装 Go 工具链，且在 PATH 里）');
    console.error(`    ${err.message}`);
    process.exit(1);
  }

  const stat = fs.statSync(out);
  console.log(`  ✓ ${path.relative(ROOT, out)}  ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  return out;
}

if (require.main === module) {
  main();
}

module.exports = { main };
