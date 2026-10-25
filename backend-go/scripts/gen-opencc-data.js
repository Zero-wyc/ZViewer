#!/usr/bin/env node
/**
 * 从 opencc-js 导出 Go 侧用的简繁转换词典。
 *
 * Node 版的 `services/danmaku/chinese-convert.ts` 用的是 opencc-js：
 *   toTraditional = Converter({from:'cn', to:'tw'})
 *     = [STCharacters, STPhrases]  ← from/cn
 *       + [TWVariants]             ← to/tw
 *   toSimplified  = Converter({from:'tw', to:'cn'})
 *     = [TWVariantsRev, TWVariantsRevPhrases]  ← from/tw
 *       + [TSCharacters, TSPhrases]            ← to/cn
 *
 * opencc-js 的 `ConverterFactory` 把每个字典组编译成一棵 Trie，然后**依次**
 * 对结果跑一遍「最长匹配替换」。Go 侧照抄这个结构：同一份词典、同样的顺序，
 * 结果才可能逐字一致。
 *
 * 用法：node backend-go/scripts/gen-opencc-data.js
 * 产物：backend-go/internal/danmaku/chinese/data/<group>.tsv（key\tvalue）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DICT_DIR = path.join(ROOT, 'node_modules', 'opencc-js', 'dist', 'esm-lib', 'dict');
const OUT_DIR = path.join(ROOT, 'backend-go', 'internal', 'danmaku', 'chinese', 'data');

// 与 opencc-js 的 preset 一一对应，顺序不能变（顺序即「多趟转换」的先后）。
const GROUPS = {
  's2t-0-st-characters': 'STCharacters',
  's2t-1-st-phrases': 'STPhrases',
  's2t-2-tw-variants': 'TWVariants',
  't2s-0-tw-variants-rev': 'TWVariantsRev',
  't2s-1-tw-variants-rev-phrases': 'TWVariantsRevPhrases',
  't2s-2-ts-characters': 'TSCharacters',
  't2s-3-ts-phrases': 'TSPhrases',
};

async function loadDict(name) {
  const target = path.join(DICT_DIR, `${name}.js`);
  const module = await import(`file://${target.replace(/\\/g, '/')}`);
  return module.default;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;

  for (const [file, dictName] of Object.entries(GROUPS)) {
    const raw = await loadDict(dictName);
    // opencc-js 的数据是 "key value|key value|..."，用 split(' ') 取前两段。
    const pairs = raw.split('|').map((entry) => {
      const [left, right] = entry.split(' ');
      if (!left || right === undefined) {
        throw new Error(`${dictName} 里有格式异常的条目: ${entry}`);
      }
      return `${left}\t${right}`;
    });
    const body = `${pairs.join('\n')}\n`;
    fs.writeFileSync(path.join(OUT_DIR, `${file}.tsv`), body, 'utf8');
    total += Buffer.byteLength(body);
    console.log(`${file}.tsv  ${pairs.length} 条  ${(Buffer.byteLength(body) / 1024).toFixed(0)}KB`);
  }

  console.log(`合计 ${(total / 1024).toFixed(0)}KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
