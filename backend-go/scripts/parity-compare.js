/**
 * 对拍比对器：读两个目录下的 {node,go}-<case>.json，逐字段比对。
 *
 * 单独成文件而不是 heredoc：脚本里的 heredoc 一旦有引号/缩进问题，
 * 排查成本远高于一个真文件；而且比对规则本身值得被 review。
 *
 * 用法：node parity-compare.js <采集目录>
 * 退出码：0 = 完全一致；1 = 存在差异（便于 CI 直接用）。
 */
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) {
  console.error('用法: node parity-compare.js <采集目录>');
  process.exit(2);
}
const cases = [
  'ugc-default',
  'ugc-qn16',
  'ugc-mp4',
  'pgc-free',
  'pgc-paid',
  'pgc-ep2',
];

// 这些字段是「前端 + 播放器」真正消费的契约，少一个就播不出来。
const FIELDS = [
  'success',
  'status',
  'format',
  'currentQn',
  'loggedIn',
  'vipStatus',
  'title',
  'duration',
  'cid',
  'videoCodec',
  'audioCodec',
  'isHdr',
  'hdrType',
  'videoCodecid',
  'currentPage',
  'epId',
  'seasonId',
  'seasonTitle',
  'preview',
  'code',
];

let totalDiff = 0;

/**
 * 从媒体 URL 里提取清晰度轨道号（_da2-1-30032.m4s / -16.mp4）。
 * URL 带签名且每次不同，逐字符比没意义；轨道号相同才说明选中的是同一档流。
 */
function trackNo(url) {
  if (!url) return '';
  const m = String(url).match(/[-_](\d{2,5})\.(?:m4s|mp4)/g);
  if (!m) return '';
  const last = m[m.length - 1].match(/(\d{2,5})/);
  return last ? last[1] : '';
}

function readJSON(file) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  return JSON.parse(raw);
}

for (const name of cases) {
  let n;
  let g;
  try {
    n = readJSON(path.join(dir, `node-${name}.json`));
  } catch (err) {
    console.log(`\n[${name}] Node 输出不可解析: ${err.message}`);
    totalDiff++;
    continue;
  }
  try {
    g = readJSON(path.join(dir, `go-${name}.json`));
  } catch (err) {
    console.log(`\n[${name}] Go 输出不可解析: ${err.message}`);
    totalDiff++;
    continue;
  }

  console.log(`\n--- ${name} ---`);
  const before = totalDiff;

  for (const f of FIELDS) {
    const nv = n[f] === undefined ? '<缺>' : n[f];
    const gv = g[f] === undefined ? '<缺>' : g[f];
    if (String(nv) !== String(gv)) {
      console.log(`  ✗ ${f}: Node=${nv} | Go=${gv}`);
      totalDiff++;
    }
  }

  const na = (n.acceptQuality || []).map((q) => `${q.id}:${q.label}`);
  const ga = (g.acceptQuality || []).map((q) => `${q.id}:${q.label}`);
  if (JSON.stringify(na) !== JSON.stringify(ga)) {
    console.log(
      `  ✗ acceptQuality: Node=${JSON.stringify(na)} | Go=${JSON.stringify(ga)}`,
    );
    totalDiff++;
  }

  // pages 只比前 3 条（番剧有 1280 集，全量比没意义），数量单独比。
  const np = (n.pages || []).slice(0, 3);
  const gp = (g.pages || []).slice(0, 3);
  if (JSON.stringify(np) !== JSON.stringify(gp)) {
    console.log(
      `  ✗ pages[0..2]: Node=${JSON.stringify(np)} | Go=${JSON.stringify(gp)}`,
    );
    totalDiff++;
  }
  if ((n.pages || []).length !== (g.pages || []).length) {
    console.log(
      `  ✗ pages 数量: Node=${(n.pages || []).length} | Go=${(g.pages || []).length}`,
    );
    totalDiff++;
  }

  // 媒体 URL 只比轨道号与是否有值。
  const nv = trackNo(n.videoUrl);
  const gv = trackNo(g.videoUrl);
  if (nv !== gv) {
    console.log(`  ✗ videoUrl 轨道号: Node=${nv} | Go=${gv}`);
    totalDiff++;
  }
  const naudio = trackNo(n.audioUrl);
  const gaudio = trackNo(g.audioUrl);
  if (naudio !== gaudio) {
    console.log(`  ✗ audioUrl 轨道号: Node=${naudio} | Go=${gaudio}`);
    totalDiff++;
  }
  if (!!n.videoUrl !== !!g.videoUrl) {
    console.log(`  ✗ videoUrl 有无: Node=${!!n.videoUrl} | Go=${!!g.videoUrl}`);
    totalDiff++;
  }

  if (totalDiff === before) console.log('  ✓ 全部字段一致');
}

console.log(`\n================ 差异总数: ${totalDiff} ================`);
process.exit(totalDiff === 0 ? 0 : 1);
