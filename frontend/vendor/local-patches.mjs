/**
 * mediabunny vendored 副本的本地补丁（程序化，可自动重放）。
 *
 * fetch-mediabunny.mjs 抓取的是 pristine 上游源码（固定 commit SHA），
 * 抓取完成后自动调用本文件的 applyLocalPatches() 重放全部本地补丁，
 * 因此「重新抓取」是一条完全可复现的命令：
 *
 *   node fetch-mediabunny.mjs   （抓取 + 自动打补丁）
 *   node local-patches.mjs      （单独重打补丁）
 *   node local-patches.mjs --check （只校验补丁是否在位，不改文件）
 *
 * 匹配逻辑行尾无关：读入时统一 \r\n → \n，替换后写回 LF
 * （git 侧 autocrlf 负责 index 归一化，无需关心工作区行尾）。
 *
 * 每个补丁 = { file, find, replace }：find 必须在目标文件中恰好出现一次
 * （已应用的文件包含 replace，直接跳过，幂等）。find/replace 都不存在
 * 视为上游漂移，报错退出 —— 这是刻意的：fetch 固定了 SHA，出现这种情况
 * 说明有人改了 REF，必须人工重估补丁。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve as presolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = presolve(SCRIPT_DIR, 'mediabunny', 'dist', 'modules', 'src');

export const LOCAL_PATCHES = [
  // ── 已退休（mediabunny 1.66.2 全部内建，无需再打）────────────────────
  //
  // 1-4. DTS 支持（5 hunk：codec.js ×3 + matroska/ebml.js + matroska-demuxer.js）
  //      上游现已登记 'dts': 'A_DTS'（matroska/ebml.js:742）、给出 codec
  //      frame size 512（codec.js:800）、MSE codec string 'dtsc'（codec.js:617/667）。
  // 5.   FLAC 24-bit 位深（isobmff/isobmff-boxes.js）
  //      上游现按 STREAMINFO 读真实位深（isobmff-boxes.js:699 `readBits(5)+1`）。
  //
  // 逐条历史与验证方式见同目录 LOCAL-PATCHES.md。保留本数组与 applyLocalPatches()
  // 机制：上游若再次回归（例如 DTS 映射被删），在此加回补丁即可，fetch 流程不变。
];

function normalize(content) {
  return content.replace(/\r\n/g, '\n');
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

/** 对单个补丁求状态：'applied'（replace 在位）| 'pristine'（find 在位）| 'drifted' */
function patchState(content, patch) {
  if (countOccurrences(content, patch.replace) === 1) return 'applied';
  if (countOccurrences(content, patch.find) === 1) return 'pristine';
  return 'drifted';
}

/**
 * 重放全部本地补丁。返回应用/跳过的补丁数。
 * @param {{ write?: boolean }} opts  write=false 时只校验不改文件（--check）
 */
export async function applyLocalPatches({ write = true } = {}) {
  let applied = 0;
  let skipped = 0;
  const errors = [];

  // 按 file 分组缓存，减少重复读写
  const cache = new Map();
  const readOnce = async (rel) => {
    if (!cache.has(rel)) {
      cache.set(rel, {
        content: normalize(await readFile(presolve(ROOT, rel), 'utf8')),
        dirty: false,
      });
    }
    return cache.get(rel);
  };

  for (const patch of LOCAL_PATCHES) {
    const entry = await readOnce(patch.file);
    const state = patchState(entry.content, patch);
    if (state === 'applied') {
      skipped++;
      continue;
    }
    if (state === 'pristine') {
      if (write) {
        entry.content = entry.content.replace(patch.find, patch.replace);
        entry.dirty = true;
        applied++;
        console.log(`applied: [${patch.file}] ${patch.title}`);
      } else {
        errors.push(`missing: [${patch.file}] ${patch.title}（补丁未在位）`);
      }
      continue;
    }
    errors.push(
      `drifted: [${patch.file}] ${patch.title} —— find/replace 均未唯一匹配，` +
        '上游内容已变化（或文件被手工改动），请人工重估此补丁'
    );
  }

  if (write) {
    for (const [rel, entry] of cache) {
      if (entry.dirty) await writeFile(presolve(ROOT, rel), entry.content, 'utf8');
    }
  }

  if (errors.length) {
    throw new Error(
      `本地补丁校验失败（${errors.length}/${LOCAL_PATCHES.length} 项异常）:\n` +
        errors.map((e) => `  - ${e}`).join('\n')
    );
  }
  return { applied, skipped, total: LOCAL_PATCHES.length };
}

// CLI 入口
if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const check = process.argv.includes('--check');
  try {
    const { applied, skipped, total } = await applyLocalPatches({ write: !check });
    console.log(
      check
        ? `check OK: ${total}/${total} 补丁在位`
        : `done: applied=${applied} skipped(已在位)=${skipped} / ${total}`
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
