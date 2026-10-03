/**
 * 安装后清理误发布的构建期依赖，缩小 pkg 单文件产物体积。
 *
 * 背景：webdav-client@1.4.3 发布时把 typescript@3.5.3（53MB）与 browserify
 * 错误地列进了 dependencies（应为 devDependencies）。pkg 打包 zviewer-backend
 * 时会把被引用包的整棵目录（含嵌套 node_modules）打进快照，这 53MB 的
 * typescript 会被原样塞进 zviewer-backend / zviewer-cert。
 *
 * webdav-client 的运行时代码（lib/）不 require typescript，删除安全（已验证
 * lib/ 下全部 require：request / lodash.uniqby / xml-js-builder / xml-js /
 * ajv / jsbn 等，无 typescript）。browserify 本体保留——lib/browserified.js
 * 的 browserify-aes 等子包挂在 browserify 依赖树下，删除会断解析。
 *
 * npm overrides 在 workspaces 场景对子包依赖不生效（npm/cli 已知限制），
 * 故用 postinstall 确定性删除；npm ci / npm install 均会触发。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** pkg 打包时要排除的包内垃圾（存在才删） */
const PRUNE_TARGETS = [
  'node_modules/webdav-client/node_modules/typescript',
];

let freed = 0;
for (const rel of PRUNE_TARGETS) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) {
    const size = getDirSize(abs);
    fs.rmSync(abs, { recursive: true, force: true });
    freed += size;
    console.log(`[prune-pkg-bloat] removed ${rel} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}
if (freed > 0) {
  console.log(`[prune-pkg-bloat] freed ${(freed / 1024 / 1024).toFixed(1)} MB`);
}

function getDirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += getDirSize(p);
      else total += fs.statSync(p).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}
