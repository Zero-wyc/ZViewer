// 对壳外的 JS 做语法检查：预览服务器、构建脚本、界面脚本与 CLI 补丁。
// Go 侧用 `go vet ./...`，不在这里重复。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
function check(dir) {
  for (const item of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) check(file);
    else if (/\.(?:cjs|mjs|js)$/.test(item.name)) execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  }
}
for (const name of ['preview-server.cjs']) execFileSync(process.execPath, ['--check', path.join(root, name)], { stdio: 'inherit' });
for (const dir of ['scripts', 'ui', 'patches']) if (fs.existsSync(path.join(root, dir))) check(dir);
console.log('JavaScript syntax checks passed');
execFileSync(process.execPath, ['--test', path.join(__dirname, 'live-actions.test.cjs')], { stdio: 'inherit' });

// 桌面端的默认端口必须与主项目一致：两边各写一份常量，只改一边就会出现
// 「面板显示 3336、后端却在别处监听」，这里在 check 阶段直接拦下来。
function readPort(file, pattern, label) {
  const text = fs.readFileSync(path.join(root, '..', file), 'utf8');
  const match = text.match(pattern);
  if (!match) throw new Error(`${label}：在 ${file} 里找不到端口定义`);
  return Number(match[1]);
}
// 端口默认值的唯一事实源：Go 包 internal/livekit（Node 版已随 backend/ 删除）
const MANAGER = 'backend-go/internal/livekit/livekit.go';
const CONFIG = 'desktop/controller/config.go';
const pairs = [
  {
    label: '语音 UDP / 网页端口',
    backend: readPort(MANAGER, /defaultUDPPort\s*=\s*(\d+)/, '主项目语音 UDP'),
    desktop: readPort(CONFIG, /Port: (\d+), RtmpPort/, '桌面端网页端口')
  },
  {
    label: 'LiveKit 信令',
    backend: readPort(MANAGER, /defaultHTTPPort\s*=\s*(\d+)/, '主项目 LiveKit 信令'),
    desktop: readPort(CONFIG, /LivekitPort: (\d+), LivekitTcpPort/, '桌面端 LiveKit 信令')
  },
  {
    label: '语音 RTC TCP',
    backend: readPort(MANAGER, /defaultTCPPort\s*=\s*(\d+)/, '主项目 RTC TCP'),
    desktop: readPort(CONFIG, /LivekitTcpPort: (\d+),/, '桌面端 RTC TCP')
  }
];
const drifted = pairs.filter((pair) => pair.backend !== pair.desktop);
if (drifted.length) {
  for (const pair of drifted) console.error(`端口不一致（${pair.label}）：主项目 ${pair.backend}，桌面端 ${pair.desktop}`);
  process.exitCode = 1;
} else {
  console.log(`Port defaults aligned with backend: ${pairs.map((pair) => `${pair.label} ${pair.backend}`).join(', ')}`);
}
