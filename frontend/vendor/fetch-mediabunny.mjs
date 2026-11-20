/**
 * 抓取上游 npm 版 mediabunny 到本目录 mediabunny/，作为本地 vendored 副本。
 *
 * 当前锁定 1.66.2（2026-11-19 发布），直接取官方发布产物 dist/modules/src。
 *
 * 历史（2026-11-20 之前）：曾抓 kzahel/mediabunny 的 integration 分支
 * @cd3cd2be（fork，基于 v1.38.1）。当时只有该 fork 同时具备 DTS demux
 * （A_DTS）与内嵌字幕轨 API（getSubtitleTracks / formatCuesToWebVTT），
 * 而上游 1.5x 重写 Input API 后两者皆无 —— playsvideo 0.4.7 撞上
 * `input.getSubtitleTracks is not a function` 会丢掉整个 DemuxResult。
 *
 * 升级 1.66.2 后的变化：
 * - DTS（A_DTS）与 FLAC 24-bit 位深修复均已进入上游 → 本地补丁全部退休；
 * - 内嵌字幕轨 API 上游仍无。ZViewer 侧不依赖它：playsvideo 的
 *   <track> 桥接（playsvideo-subtitle-bridge）无订阅方，内嵌字幕实际
 *   全部走 modules/subtitles/mkv-embedded.ts 的自研 MKV 解析器；
 *   且 playsvideo 的 demux 已用 try/catch 兜底字幕探测，缺 API 只让
 *   subtitleTracks 恒为空，不影响主链路。
 * - TrueHD 被上游识别为 codec `truehd` / config `mlpa`，playsvideo 会误判
 *   为「可转码」，见 vendor/playsvideo/dist/pipeline/demux.js 的
 *   NON_TRANSCODABLE_AUDIO 守卫。
 *
 * 逐条历史与验证方式见同级 MEDIABUNNY-LOCAL-PATCHES.md（放在 vendor/ 根，
 * 避免被本脚本的目录清理连带删除）。
 *
 * 与参考实现（dts-video-player/fetch_mediabunny.mjs）的差异：
 * - 额外抓取 .d.ts——ZViewer 是 TypeScript 项目，playsvideo 的声明文件
 *   import 了 mediabunny 的类型，tsc 需要它们。
 * - 路径解析不依赖 node:path（Windows 下 presolve('/x') 会解析成
 *   当前盘符绝对路径），手写 POSIX 相对路径拼接。
 * - jsDelivr 会限流（偶发 403），带重试并回退 unpkg。
 *
 * 用法：node fetch-mediabunny.mjs（抓取 pristine 源码 + 自动重放本地补丁）
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyLocalPatches } from './local-patches.mjs';

// npm 版本号固定，不用 ^/latest —— 重新抓取必须得到与入库副本一致的字节。
// 升级时改这一行 + 重跑 local-patches.mjs --check（当前补丁列表应为空）。
const PKG = 'mediabunny@1.66.2';
const BASES = [
  `https://cdn.jsdelivr.net/npm/${PKG}/`,
  `https://unpkg.com/${PKG}/`,
];
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = presolve(SCRIPT_DIR, 'mediabunny') + '/';
const START = 'dist/modules/src/index.js';
const ALLOW_PREFIX = 'dist/modules/';

const done = new Set();
const queue = [START];

/** POSIX 风格的相对路径解析（'a/b/c.js' + '../d/e.js' → 'a/d/e.js'） */
function resolveRel(fromFile, spec) {
  const parts = fromFile.split('/');
  parts.pop(); // 去掉文件名，留下目录
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

async function fetchOnce(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchText(rel) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const base = BASES[attempt % BASES.length];
    try {
      return await fetchOnce(base + rel);
    } catch (e) {
      lastErr = e;
      // 限流/偶发失败：等待后换源重试
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new Error(`${lastErr.message} for ${rel}`);
}

function findImports(src) {
  const specs = [];
  const re = /(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[1]);
  // bare `import 'x'` side-effect imports
  const re2 = /import\s*['"]([^'"]+)['"]/g;
  while ((m = re2.exec(src))) specs.push(m[1]);
  return specs;
}

/**
 * 从 jsDelivr 的文件清单取「该版本 dist/modules 下全部 .js + .d.ts」。
 *
 * 为什么不全靠 import 图递归：递归只能抓到被引用的文件，包内存在
 * 无人 import 的独立模块（例 1.66.2 的 dist/modules/shared/dts-misc.js），
 * 漏抓会让 vendored 副本与官方包产生无声差异。清单驱动能保证逐字节一致。
 *
 * @returns 相对路径列表（'dist/modules/...'）；接口不可用时返回 null，
 *          调用方回退到 import 图递归。
 */
async function fetchManifest() {
  const url = `https://data.jsdelivr.com/v1/packages/npm/${PKG}?structure=flat`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const files = (data.files || [])
      .map((f) => String(f.name || '').replace(/^\//, ''))
      .filter(
        (name) =>
          name.startsWith(ALLOW_PREFIX) &&
          (name.endsWith('.js') || name.endsWith('.d.ts'))
      );
    return files.length ? files : null;
  } catch (e) {
    console.warn('清单获取失败，回退 import 图递归：', e.message);
    return null;
  }
}

function isRelative(s) {
  return s.startsWith('./') || s.startsWith('../');
}

async function crawl() {
  while (queue.length) {
    const rel = queue.shift();
    if (done.has(rel)) continue;
    done.add(rel);
    if (!rel.startsWith(ALLOW_PREFIX)) {
      console.log('skip (outside dist/modules/src):', rel);
      continue;
    }
    let src;
    try {
      src = await fetchText(rel);
    } catch (e) {
      console.error('FAIL', rel, e.message);
      process.exitCode = 1;
      continue;
    }
    const outPath = ROOT + rel;
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, src);

    // .js 顺带抓同名 .d.ts（供 tsc）；相对导入继续入队
    if (rel.endsWith('.js')) {
      const dts = rel.replace(/\.js$/, '.d.ts');
      if (!done.has(dts) && !queue.includes(dts)) queue.push(dts);
    }
    for (const s of findImports(src)) {
      if (!isRelative(s)) {
        // bare/absolute specifier（如类型-only 导入）— 跳过下载
        continue;
      }
      const r = resolveRel(rel, s);
      const withExt = r.endsWith('.js') || r.endsWith('.d.ts') ? r : r + '.js';
      if (!done.has(withExt) && !queue.includes(withExt)) queue.push(withExt);
    }
  }
}

/** 按清单逐文件抓取（首选路径：与官方发布包逐字节一致）。 */
async function fetchByManifest(files) {
  let failed = 0;
  for (const rel of files) {
    let src;
    try {
      src = await fetchText(rel);
    } catch (e) {
      console.error('FAIL', rel, e.message);
      failed++;
      continue;
    }
    const outPath = ROOT + rel;
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, src);
    done.add(rel);
  }
  if (failed) process.exitCode = 1;
}

// 预清理：尽力而为（部分环境下 fs.rm 被回收站 shim 拦截会失败，可忽略，
// 抓取过程会原样覆盖已有文件）
try {
  await rm(presolve(SCRIPT_DIR, 'mediabunny'), { recursive: true, force: true });
} catch (e) {
  console.warn('预清理失败（忽略，将覆盖写入）：', e.message);
}
const manifest = await fetchManifest();
if (manifest) {
  console.log(`清单模式：${manifest.length} 个文件`);
  await fetchByManifest(manifest);
} else {
  console.log('递归模式：按 import 图抓取');
  await crawl();
}
console.log('Downloaded files:', done.size);

// 官方包的 package.json 不能原样用：它的 `main` 指向 dist/bundles/*.cjs（未抓取，
// 只 vendored 了 ESM 产物 dist/modules），且 exports 的 browser 条件指向同一处。
// 这里写一份最小的本地清单，把入口钉在 dist/modules/src/index.js，保证
// `import 'mediabunny'`（Node 测试 / Vite / tsc）都解析到同一份代码。
const pkgVersion = PKG.split('@')[1];
await writeFile(
  presolve(SCRIPT_DIR, 'mediabunny', 'package.json'),
  JSON.stringify(
    {
      name: 'mediabunny',
      version: pkgVersion,
      type: 'module',
      description:
        `本地 vendored 副本：官方 npm mediabunny@${pkgVersion} 的 dist/modules ` +
        '逐字节拷贝（jsDelivr 清单驱动抓取）。补丁状态与升级说明见 ' +
        '../MEDIABUNNY-LOCAL-PATCHES.md；重新抓取：node ../fetch-mediabunny.mjs',
      main: 'dist/modules/src/index.js',
      module: 'dist/modules/src/index.js',
      exports: {
        '.': {
          import: './dist/modules/src/index.js',
        },
      },
      browser: {
        './dist/modules/src/node.js': false,
      },
      sideEffects: false,
    },
    null,
    2
  ) + '\n'
);

// 抓取完成后自动重放本地补丁。1.66.2 起补丁列表为空（上游已内建 DTS 与
// FLAC 位深修复），机制保留：若上游回归，在 local-patches.mjs 加回条目即可，
// 缺补丁/上游漂移时此处会抛错退出，绝不静默产出残缺的 vendor 副本。
const { applied, skipped, total } = await applyLocalPatches();
console.log(`Local patches: applied=${applied} skipped=${skipped} / ${total}`);
