/** 解析 pkg --debug 日志，统计快照体积构成（按顶层包聚合） */
const fs = require('fs');
const log = fs.readFileSync(process.argv[2] || '/tmp/pkg-log.txt', 'utf8');
const lines = log.split(/\r?\n/);
const seen = new Set();
for (const line of lines) {
  // "Content of <path> is added to queue." / "Bytecode of <path> is added to queue."
  let m = line.match(/(?:Content|Bytecode|Stat info) of (.+?) is added to queue/);
  if (m) seen.add(m[1].replace(/\\/g, '/'));
  // "It was required from <path>"（行尾路径）
  m = line.match(/It was required from (.+?)\s*$/);
  if (m) seen.add(m[1].replace(/\\/g, '/'));
}
const agg = new Map();
const detail = new Map();
let total = 0;
let missing = 0;
for (const p of seen) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    missing++;
    continue;
  }
  if (!st.isFile()) continue;
  total += st.size;
  const norm = p.toLowerCase();
  const idx = norm.indexOf('/node_modules/');
  let key = '(backend/scripts)';
  if (idx >= 0) {
    const rest = norm.slice(idx + '/node_modules/'.length);
    key = rest.startsWith('@') ? rest.split('/').slice(0, 2).join('/') : rest.split('/')[0];
  } else if (norm.includes('/backend/dist')) key = '(backend dist)';
  else if (norm.includes('/frontend/')) key = '(frontend)';
  agg.set(key, (agg.get(key) || 0) + st.size);
  if (!detail.has(key)) detail.set(key, []);
  detail.get(key).push([st.size, p]);
}
const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(
  `=== 快照体积构成 top30（唯一路径 ${seen.size}，磁盘合计 ${(total / 1048576).toFixed(1)} MB，stat 失败 ${missing}）===`
);
for (const [k, v] of top) {
  console.log(`${((v / 1048576).toFixed(1) + ' MB').padStart(10)}  ${k}`);
  if (v > 3000000) {
    const files = detail.get(k).sort((a, b) => b[0] - a[0]).slice(0, 3);
    for (const [sz, p] of files) console.log(`             - ${(sz / 1024).toFixed(0)} KB  ${p}`);
  }
}
