/**
 * 安装后清理误发布/未使用的包内容，缩小 pkg 单文件产物体积。
 *
 * pkg 打包 zviewer-backend 时把 require 闭包内包的整棵目录（含嵌套
 * node_modules 与非运行时文件）打进快照，以下内容均为纯冗余：
 *
 * 1. webdav-client@1.4.3 发布事故：typescript@3.5.3（53MB）被错列进
 *    dependencies（应为 devDependencies）。运行时代码（lib/）不 require
 *    typescript（已验证）。同时编辑其 package.json 删掉该依赖声明——
 *    pkg 会按声明解析到 hoisted 的 root typescript@5.9（22.5MB），
 *    只删嵌套目录不够。browserify 保留：lib/browserified.js 的
 *    browserify-aes 等子包挂在它下面。
 * 2. better-sqlite3：typeorm 的 optional peer dependency（npm 自动安装），
 *    本项目用 sql.js 驱动，typeorm 的 BetterSqlite3Driver 不会被加载。
 * 3. @neteasecloudmusicapienhanced/api/public 的 docs/static 演示资源
 *    （~13MB 图片/网页）。运行时仅 express.static 挂载，目录缺失只会
 *    404，API 功能不受影响。
 * 4. xml2js/lib/xml2js.bc.js：发布时遗留的 browserify bundle（3.3MB），
 *    main 入口是 parser.js，运行时不引用。
 * 5. @livekit/protocol 的 .d.ts 三份副本（2.3MB）：类型声明文件，
 *    运行时不读取。
 *
 * npm overrides 在 workspaces 场景对子包依赖不生效（npm/cli 已知限制），
 * 故用 postinstall 确定性处理；npm ci / npm install 均会触发。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 直接删除的目标（目录或文件，存在才删） */
const PRUNE_TARGETS = [
  'node_modules/webdav-client/node_modules/typescript',
  'node_modules/better-sqlite3',
  'node_modules/@neteasecloudmusicapienhanced/api/public/static',
  'node_modules/@neteasecloudmusicapienhanced/api/public/docs',
  'node_modules/@neteasecloudmusicapienhanced/api/public/audio_match_demo',
  'node_modules/xml2js/lib/xml2js.bc.js',
  'node_modules/@livekit/protocol/dist/index.d.ts',
  'node_modules/@livekit/protocol/dist/index.d.cts',
  'node_modules/@livekit/protocol/dist/index.d.mts',
];

/** 需要编辑 package.json 剔除的依赖声明（pkg 按声明解析，删目录不够） */
const DECLARATION_FIXES = [
  {
    pkgJson: 'node_modules/webdav-client/package.json',
    remove: ['typescript'],
  },
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

for (const fix of DECLARATION_FIXES) {
  const abs = path.join(ROOT, fix.pkgJson);
  if (!fs.existsSync(abs)) continue;
  const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = json[field];
    if (!deps) continue;
    for (const name of fix.remove) {
      if (name in deps) {
        delete deps[name];
        changed = true;
        console.log(`[prune-pkg-bloat] ${fix.pkgJson}: removed ${field}.${name}`);
      }
    }
  }
  if (changed) {
    fs.writeFileSync(abs, JSON.stringify(json, null, 2) + '\n');
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
