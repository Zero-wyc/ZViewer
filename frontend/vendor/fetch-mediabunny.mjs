/**
 * 抓取 kzahel/mediabunny 的 integration 分支（playsvideo 0.4.x 依赖的 fork）
 * 到本目录 mediabunny/，作为本地 vendored 副本。
 *
 * 背景：上游 npm mediabunny 1.55.x 重写了 Input API（移除了字幕轨、
 * 部分 playsvideo 依赖的方法），导致 playsvideo 0.4.7 崩溃
 * （input.getSubtitleTracks is not a function → 整个 DemuxResult 丢失 → 无声）。
 * kzahel fork 的 integration 分支同时具备 DTS demux（A_DTS）与字幕轨 API，
 * 是 playsvideo 的设计目标版本。该 fork 无法从 npm 安装（npm 上的 1.38.1
 * 是旧发布版，与 integration 分支源码不一致），因此抓取分支源码。
 *
 * 与参考实现（dts-video-player/fetch_mediabunny.mjs）的差异：
 * - 额外抓取 .d.ts——ZViewer 是 TypeScript 项目，playsvideo 的声明文件
 *   import 了 mediabunny 的类型，tsc 需要它们。
 * - 路径解析不依赖 node:path（Windows 下 presolve('/x') 会解析成
 *   当前盘符绝对路径），手写 POSIX 相对路径拼接。
 * - jsDelivr 会限流（偶发 403），带重试并回退 raw.githubusercontent.com。
 *
 * 用法：node fetch-mediabunny.mjs
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'kzahel/mediabunny';
const BRANCH = 'integration';
const BASES = [
  `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/`,
  `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`,
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

// 预清理：尽力而为（部分环境下 fs.rm 被回收站 shim 拦截会失败，可忽略，
// 抓取过程会原样覆盖已有文件）
try {
  await rm(presolve(SCRIPT_DIR, 'mediabunny'), { recursive: true, force: true });
} catch (e) {
  console.warn('预清理失败（忽略，将覆盖写入）：', e.message);
}
await crawl();
console.log('Downloaded files:', done.size);
