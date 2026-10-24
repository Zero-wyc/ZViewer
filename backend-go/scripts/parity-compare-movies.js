#!/usr/bin/env node
/**
 * 影片列表的逐字段比对器（movie-parity.sh 使用）。
 *
 * 与 bilibili 那份比对器的差别：影片列表是**数组**，顺序与 id 都可能不同，
 * 所以先按 title 配对再比字段；id / createdAt / updatedAt 单独处理：
 *   - id 天然不同（各自插入），不参与比较；
 *   - createdAt/updatedAt 只比「两端是否一致」，不比绝对值。
 *
 * 用法：node parity-compare-movies.js <node.json> <go.json> [--skip-time]
 */
const fs = require('fs');

function load(p) {
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) throw new Error(`${p} 为空`);
  const parsed = JSON.parse(raw);
  // 一侧可能是单条（create 的响应 {movie}），另一侧是列表 {movies}。
  if (Array.isArray(parsed.movies)) return parsed.movies;
  if (parsed.movie) return [parsed.movie];
  return [];
}

const [, , nodePath, goPath, ...flags] = process.argv;
if (!nodePath || !goPath) {
  console.error('用法: node parity-compare-movies.js <node.json> <go.json>');
  process.exit(2);
}
const skipTime = flags.includes('--skip-time');

const nodeList = load(nodePath);
const goList = load(goPath);

// 比对这些字段：DTO 的全部可观察字段（username/password 恒为 null，也一并比，
// 因为它们**不该**出现明文）。
const FIELDS = [
  'roomId', 'title', 'cover', 'source', 'audioUrl', 'format', 'videoCodec',
  'audioCodec', 'duration', 'cid', 'currentQn', 'acceptQuality', 'pages',
  'currentPage', 'serverUrl', 'sourceMountId', 'path', 'username', 'password',
  'directLink', 'serverProxy', 'wasmEngine', 'playsvideoEnabled', 'cliOnly',
  'multiVersion', 'sourceMeta', 'order',
];

function byTitle(list) {
  const map = new Map();
  for (const m of list) map.set(String(m.title), m);
  return map;
}

const nodeMap = byTitle(nodeList);
const goMap = byTitle(goList);

let diffs = 0;
const titles = [...new Set([...nodeMap.keys(), ...goMap.keys()])].sort();

for (const title of titles) {
  const a = nodeMap.get(title);
  const b = goMap.get(title);
  if (!a || !b) {
    console.log(`  ✗ [${title}] 只在一侧存在: Node=${!!a} Go=${!!b}`);
    diffs++;
    continue;
  }
  const local = [];
  for (const f of FIELDS) {
    const av = JSON.stringify(a[f]);
    const bv = JSON.stringify(b[f]);
    if (av !== bv) local.push(`${f}: Node=${av} | Go=${bv}`);
  }
  // 时间只在两端都给值时才比「是否相同」——这里比的正是时区解释语义，
  // 真正的偏移已经在 movie-parity.sh 里用固定种子时间单独断言过。
  if (!skipTime) {
    for (const f of ['createdAt', 'updatedAt']) {
      if (a[f] !== b[f]) local.push(`${f}: Node=${a[f]} | Go=${b[f]}`);
    }
  }
  if (local.length === 0) {
    console.log(`  ✓ [${title}] 全字段一致`);
  } else {
    console.log(`  ✗ [${title}]`);
    for (const d of local) console.log(`      ${d}`);
    diffs += local.length;
  }
}

console.log(`\n================ 差异总数: ${diffs} ================`);
process.exit(diffs === 0 ? 0 : 1);
