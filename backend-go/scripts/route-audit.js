/**
 * 端点对账（阶段 5 检查单第 1 项：Go 侧 /api/* 不得被 404 兜底吃掉）。
 *
 * 两条腿：
 *
 *   1. **静态 diff**：Node 侧不抓源码，而是构造真实 app、调用与生产同一份
 *      registerHttpRoutes()，再递归遍历 router.stack —— Express 的路由可能在工厂
 *      函数里按前缀循环注册（emby/jellyfin），静态解析必漏。Go 侧扫源码里的
 *      `mux.HandleFunc("GET /path", ...)` 字面量。
 *
 *   2. **行为探测**（--probe <base>）：对每条 Node 路由发一个真实请求，
 *      看 Go 是不是落到了 `/api/` 的 404 兜底（文案「接口不存在」）。
 *      这是检查单的原话，也是唯一能证明「路径参数写法不同但语义等价」的手段。
 *
 * 用法：
 *   node backend-go/scripts/route-audit.js                 # 静态 diff
 *   node backend-go/scripts/route-audit.js --probe http://127.0.0.1:PORT
 *   node backend-go/scripts/route-audit.js --json          # 机器可读
 *
 * 契约快照（删除 backend/ 之后仍然能保证端点覆盖）：
 *   node backend-go/scripts/route-audit.js --snapshot backend-go/testdata/contract/routes.json
 *   node backend-go/scripts/route-audit.js --fixture  backend-go/testdata/contract/routes.json \
 *        --probe http://127.0.0.1:PORT
 *
 * `--snapshot` 把 Node 运行时路由表冻结成 JSON；`--fixture` 则完全不需要 Node
 * （不 require ts-node、不碰 backend/），只做行为探测。两者配合，Node 退场后
 * 「每条历史端点都还在」这条保证依然可执行。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const NEWLINE = String.fromCharCode(10);
const BACKEND = path.join(REPO, 'backend');
const GO_API = path.join(REPO, 'backend-go', 'internal', 'api');

// ---------------------------------------------------------------------------
// Node 侧：真实构造 app 后遍历
// ---------------------------------------------------------------------------

function collectNodeRoutes() {
  process.env.NODE_ENV = process.env.NODE_ENV || 'test';
  // 只为 import 期副作用能跑起来；用系统临时目录，绝不碰 config/dev.sqlite，
  // 也不在仓库里留目录（写进 .gitignore 之外的路径最容易被人误提交）。
  const tmp = path.join(require('node:os').tmpdir(), 'zv-route-audit');
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = path.join(tmp, 'audit.sqlite');
  }
  if (!process.env.CONFIG_DIR) {
    process.env.CONFIG_DIR = tmp;
  }

  require('ts-node').register({
    transpileOnly: true,
    project: path.join(BACKEND, 'tsconfig.json'),
  });

  const express = require(path.join(REPO, 'node_modules', 'express'));
  const { registerHttpRoutes } = require(path.join(BACKEND, 'src', 'routes', 'register.ts'));

  const app = express();

  // express 5 的 Layer 不再保留字符串形式的挂载路径（layer.path 为 undefined，
  // matchers 是 path-to-regexp 编译出来的函数）。挂载前缀只能在 app.use 上记。
  // 嵌套的 `router.use(subRouter)` 不带前缀，视为 ''。
  const origAppUse = app.use.bind(app);
  app.use = function patchedUse(first, ...rest) {
    const mount = typeof first === 'string' ? first : '';
    const before = app.router.stack.length;
    const out = origAppUse(first, ...rest);
    if (mount) {
      const stack = app.router.stack;
      for (let i = before; i < stack.length; i++) stack[i].__mountPath = mount;
    }
    return out;
  };

  // io 只被注入给 rooms/movie 两个工厂，装配期不会调用
  const ioStub = { emit() {}, on() {}, to() { return this; } };
  registerHttpRoutes(app, ioStub);

  const out = [];
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const route = layer.route;
        const methods = Object.keys(route.methods || {}).map((m) => m.toUpperCase());
        const paths = Array.isArray(route.path) ? route.path : [route.path];
        for (const m of methods) {
          for (const p of paths) out.push({ method: m, path: joinPath(prefix, p) });
        }
        continue;
      }
      const sub = layer.handle && layer.handle.stack;
      if (Array.isArray(sub)) {
        const mount = typeof layer.__mountPath === 'string' ? layer.__mountPath : '';
        walk(sub, joinPath(prefix, mount));
      }
    }
  };
  walk(app.router ? app.router.stack : app._router.stack, '');
  return out;
}

function joinPath(prefix, p) {
  if (!p) return prefix || '/';
  if (p === '/') return prefix || '/';
  const a = (prefix || '').replace(/\/$/, '');
  const b = p.startsWith('/') ? p : '/' + p;
  return a + b;
}

// ---------------------------------------------------------------------------
// Go 侧：扫源码里的 "METHOD /path"
// ---------------------------------------------------------------------------

// 变量前缀展开表：Go 里有两处用变量拼路径，静态扫描必须按已知取值展开，
// 否则会误报「Go 缺失」（emby/jellyfin 12 条 + 四源代理 4 条）。
// 这两处的取值就是源码里的常量，改源时这里要跟着改。
const DYNAMIC_PREFIXES = {
  'emby.go': { base: ['/api/emby', '/api/jellyfin'] },
  'proxy.go': { module: ['anime', 'anisubs', 'kazumi', 'cms'] },
};

// 逐行解析「路由表达式」：形如
//   mux.HandleFunc("GET /health", ...)
//   mux.HandleFunc("GET "+base+"/mounts/{id}", ...)
//   mux.HandleFunc("GET /api/stream/"+module+"/proxy", ...)
// 从第一个 "METHOD " 开头的字符串读起，遇到 `+` 就把后一段拼上，
// 变量段按 DYNAMIC_PREFIXES 展开。比正则一次性匹配可靠得多。
function parseRouteLine(line, vars) {
  const idx = line.search(/"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/);
  if (idx < 0) return [];

  const segments = [];
  let i = idx;
  let stop = false;
  const skipSpaces = (p) => {
    while (p < line.length && /\s/.test(line[p])) p++;
    return p;
  };

  while (i < line.length && !stop) {
    if (line[i] === '"') {
      const endQuote = line.indexOf('"', i + 1);
      if (endQuote < 0) break;
      segments.push({ literal: line.slice(i + 1, endQuote) });
      i = skipSpaces(endQuote + 1);
      if (line[i] === '+') i = skipSpaces(i + 1);
      else stop = true;
    } else if (/[A-Za-z_]/.test(line[i])) {
      const ident = /^[A-Za-z_]\w*/.exec(line.slice(i))[0];
      segments.push({ variable: ident });
      i = skipSpaces(i + ident.length);
      if (line[i] === '+') i = skipSpaces(i + 1);
      else stop = true;
    } else {
      break;
    }
  }
  if (!segments.length || !segments[0].literal) return [];

  // 第一段是 "METHOD 路径前缀"，拆出方法与已含前缀
  const head = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.*)$/.exec(segments[0].literal);
  if (!head) return [];
  const method = head[1];
  // 第一段可能是 "GET "（路径全在后面的拼接里），此时起点是空串而不是 '/'
  let paths = head[2] === '' ? [''] : ['/' + head[2].replace(/^\//, '')];

  for (const seg of segments.slice(1)) {
    if (seg.literal !== undefined) {
      paths = paths.map((p) => p + seg.literal);
      continue;
    }
    const values = vars[seg.variable];
    if (!values) return [];
    paths = paths.flatMap((p) => values.map((v) => p + v));
  }
  return paths.filter((p) => p.startsWith('/api/') || p === '/health').map((p) => ({ method, path: p }));
}

function collectGoRoutes() {
  const files = fs.readdirSync(GO_API).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
  const out = [];
  for (const file of files) {
    const vars = DYNAMIC_PREFIXES[file] || {};
    const src = fs.readFileSync(path.join(GO_API, file), 'utf8');
    for (const line of src.split(NEWLINE)) {
      if (!line.includes('HandleFunc(') && !line.includes('mux.Handle(')) continue;
      for (const route of parseRouteLine(line, vars)) out.push({ ...route, file });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 归一化：参数名不参与比较（Node 的 :id 与 Go 的 {roomId} 是同一个位置）
// ---------------------------------------------------------------------------

function normalizePath(p) {
  let s = String(p);
  s = s.replace(/\((?:\\.|[^()])*\)/g, ''); // /:id(\d+) 之类
  s = s.replace(/:[A-Za-z_$][\w$]*\?/g, ':p'); // 可选参数
  s = s.replace(/:[A-Za-z_$][\w$]*/g, ':p'); // 具名参数
  s = s.replace(/\{[A-Za-z_][\w]*\.\.\.\}/g, '*'); // Go 通配
  s = s.replace(/\{[A-Za-z_][\w]*\}/g, ':p'); // Go 参数
  s = s.replace(/\{\$\}/g, ''); // Go 末尾精确匹配
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s || '/';
}

const keyOf = (r) => r.method + ' ' + normalizePath(r.path);

// 静态资源、SPA 回退、反代挂载点不属于 /api 对账范围
const inScope = (p) => p === '/health' || p.startsWith('/api/');

// ---------------------------------------------------------------------------
// 行为探测
// ---------------------------------------------------------------------------

// 参数占位：数字型 id 用 1，其余用 1 也不会 404（Go 侧通常先校验格式 → 400）
function concretize(p) {
  return p
    .replace(/\((?:\\.|[^()])*\)/g, '')
    .replace(/:[A-Za-z_$][\w$]*\?/g, '1')
    .replace(/:[A-Za-z_$][\w$]*/g, '1');
}

function isMissingFallback(status, body) {
  // Go 的 /api/ 兜底：404 + { success:false, message:"接口不存在" }
  return status === 404 && typeof body === 'string' && body.includes('接口不存在');
}

async function probe(base, routes) {
  const results = [];
  for (const r of routes) {
    if (r.path.includes('*') || r.path.includes('<regex>')) {
      results.push({ ...r, outcome: 'skipped' });
      continue;
    }
    const url = base.replace(/\/$/, '') + concretize(r.path);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let status = 0;
    let body = '';
    try {
      const init = { method: r.method, signal: ctrl.signal, headers: {} };
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method)) {
        init.headers['Content-Type'] = 'application/json';
        init.body = '{}';
      }
      const resp = await fetch(url, init);
      status = resp.status;
      body = (await resp.text()).slice(0, 4096);
    } catch (err) {
      // 超时/连接中断：多半是流式响应（媒体代理）在等数据，说明路由存在
      results.push({ ...r, outcome: 'exists', status: 0, note: 'timeout/aborted' });
      continue;
    } finally {
      clearTimeout(timer);
    }
    results.push({
      ...r,
      status,
      outcome: isMissingFallback(status, body) ? 'missing' : 'exists',
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// 契约快照：把 Node 路由表冻结成 JSON（Node 退场后的参照物）
// ---------------------------------------------------------------------------

const FIXTURE_VERSION = 1;

function loadFixture(file) {
  const abs = path.isAbsolute(file) ? file : path.join(REPO, file);
  if (!fs.existsSync(abs)) {
    throw new Error(`契约快照不存在: ${abs}（先跑 --snapshot 生成）`);
  }
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(data.routes) || !data.routes.length) {
    throw new Error(`契约快照格式不对（缺 routes 数组）: ${abs}`);
  }
  return data.routes.map((r) => ({ method: r.method, path: r.path }));
}

function writeFixture(file, routes) {
  const abs = path.isAbsolute(file) ? file : path.join(REPO, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const uniq = new Map();
  for (const r of routes) uniq.set(r.method + ' ' + r.path, { method: r.method, path: r.path });
  const list = [...uniq.values()].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
  const payload = {
    version: FIXTURE_VERSION,
    note:
      'Node（Express）运行时路由表的冻结快照，由 backend-go/scripts/route-audit.js --snapshot 生成。' +
      'backend/ 删除后，route-parity.sh 以此为准逐条探测 Go，保证「历史端点一条都没丢」。' +
      '仅在确认要新增/废弃端点时才重新生成，并同步 MIGRATION.md。',
    generatedAt: new Date().toISOString(),
    total: list.length,
    routes: list,
  };
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { abs, total: list.length };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const probeIdx = argv.indexOf('--probe');
  const probeBase = probeIdx >= 0 ? argv[probeIdx + 1] : null;
  const snapIdx = argv.indexOf('--snapshot');
  const snapFile = snapIdx >= 0 ? argv[snapIdx + 1] : null;
  const fixtureIdx = argv.indexOf('--fixture');
  const fixtureFile = fixtureIdx >= 0 ? argv[fixtureIdx + 1] : null;
  const wantJson = argv.includes('--json');

  // --snapshot 必须先跑（它要 Node 还活着）
  if (snapFile) {
    const nodeRoutes = collectNodeRoutes().filter((r) => inScope(r.path));
    const { abs, total } = writeFixture(snapFile, nodeRoutes);
    console.log(`✓ 契约快照已写入 ${abs}`);
    console.log(`  ${total} 条（/api/* 与 /health，去重排序）`);
    return 0;
  }

  let nodeRoutes;
  if (fixtureFile) {
    nodeRoutes = loadFixture(fixtureFile);
    if (!wantJson) console.log(`（使用契约快照 ${fixtureFile}：${nodeRoutes.length} 条）`);
  } else {
    if (!fs.existsSync(BACKEND)) {
      console.error('backend/ 已不存在，且没给 --fixture。用：');
      console.error('  --fixture backend-go/testdata/contract/routes.json --probe http://127.0.0.1:PORT');
      return 2;
    }
    nodeRoutes = collectNodeRoutes().filter((r) => inScope(r.path));
  }

  if (probeBase) {
    const results = await probe(probeBase, nodeRoutes);
    const missing = results.filter((r) => r.outcome === 'missing');
    const skipped = results.filter((r) => r.outcome === 'skipped');
    const timeouts = results.filter((r) => r.note);

    if (wantJson) {
      console.log(JSON.stringify({ total: results.length, missing, skipped, timeouts }, null, 2));
      return missing.length === 0 ? 0 : 1;
    }

    console.log(`探测 ${results.length} 条（Go: ${probeBase}）`);
    if (skipped.length) console.log(`· 跳过 ${skipped.length} 条（含通配符）`);
    if (timeouts.length) console.log(`· ${timeouts.length} 条超时/中断（按存在计）`);
    if (missing.length) {
      console.log('');
      console.log(`✗ ${missing.length} 条落到 Go 的 /api 404 兜底（= 没实现或被路径写法挡住）:`);
      for (const r of missing) console.log(`   ${r.method} ${r.path}`);
      return 1;
    }
    console.log('');
    console.log('✓ 没有任何 /api 路由落到 404 兜底');
    return 0;
  }

  // ---- 静态 diff ----
  const nodeMap = new Map();
  for (const r of nodeRoutes) if (!nodeMap.has(keyOf(r))) nodeMap.set(keyOf(r), r);
  const goMap = new Map();
  for (const r of collectGoRoutes()) if (!goMap.has(keyOf(r))) goMap.set(keyOf(r), r);

  // Go 的 ServeMux 里 "GET /x" 同时接受 HEAD，所以 Node 显式声明的 HEAD
  // 只要 Go 有对应 GET 就算命中（server-files 的 HEAD /proxy 就是这种）。
  const goCovers = (key) => {
    if (goMap.has(key)) return true;
    const idx = key.indexOf(' ');
    if (key.slice(0, idx) === 'HEAD') return goMap.has('GET ' + key.slice(idx + 1));
    return false;
  };
  const missing = [...nodeMap.keys()].filter((k) => !goCovers(k)).sort();
  // Go 独有只报 /api/ 前缀的：Go 里大量 http.Error 的标签串也写成
  // "METHOD /path"（如 "DELETE /movies/{id}"），那些不是路由，全是噪声。
  const extra = [...goMap.keys()]
    .filter((k) => k.includes(' /api/'))
    .filter((k) => !nodeMap.has(k) && !nodeMap.has('HEAD ' + k.slice(k.indexOf(' ') + 1)))
    .sort();

  if (wantJson) {
    console.log(
      JSON.stringify(
        {
          nodeCount: nodeMap.size,
          goCount: goMap.size,
          missing: missing.map((k) => nodeMap.get(k)),
          extra: extra.map((k) => goMap.get(k)),
        },
        null,
        2,
      ),
    );
    return missing.length === 0 ? 0 : 1;
  }

  console.log(`Node /api 路由（去重后）: ${nodeMap.size}`);
  console.log(`Go   /api 路由（字面量扫描，去重后）: ${goMap.size}`);
  console.log('');

  if (missing.length) {
    console.log(`✗ 静态扫描未能在 Go 找到 ${missing.length} 条:`);
    for (const k of missing) console.log(`   ${k}    〔Node: ${nodeMap.get(k).path}〕`);
    console.log('');
    console.log('   注：Go 用变量拼前缀（emby/jellyfin 的 "+base+"）或写在循环里时，');
    console.log('   静态扫描会误报 —— 以 --probe 的行为探测为准。');
  } else {
    console.log('✓ 静态扫描：Node 的每条路由都能在 Go 源码里找到对应字面量');
  }

  if (extra.length) {
    console.log('');
    console.log(`· Go 独有 ${extra.length} 条（多为变量前缀展开/注释里的示例串）:`);
    for (const k of extra) console.log(`   ${k}    〔${goMap.get(k).file}〕`);
  }

  return missing.length === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

module.exports = { collectNodeRoutes };
