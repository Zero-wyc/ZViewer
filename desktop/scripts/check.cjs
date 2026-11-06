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
// 端口默认值的唯一事实源：backend-go/internal/config（语音改内置 SFU 后
// 端口不再由 livekit 包管理，那个包已随语音重写删除）
const BACKEND = 'backend-go/internal/config/config.go';
const CONFIG = 'desktop/controller/config.go';
const pairs = [
  {
    label: '网页端口 / 媒体 UDP',
    backend: readPort(BACKEND, /^\s*Port:\s+(\d+),/m, '主项目网页端口'),
    desktop: readPort(CONFIG, /Port: (\d+), RtmpPort/, '桌面端网页端口')
  },
  {
    label: '媒体 TCP',
    backend: readPort(BACKEND, /mediaTCPFallbackPort = (\d+)/, '主项目媒体 TCP'),
    desktop: readPort(CONFIG, /MediaTCPPort: (\d+),/, '桌面端媒体 TCP')
  }
];
const drifted = pairs.filter((pair) => pair.backend !== pair.desktop);
if (drifted.length) {
  for (const pair of drifted) console.error(`端口不一致（${pair.label}）：主项目 ${pair.backend}，桌面端 ${pair.desktop}`);
  process.exitCode = 1;
} else {
  console.log(`Port defaults aligned with backend: ${pairs.map((pair) => `${pair.label} ${pair.backend}`).join(', ')}`);
}
