#!/usr/bin/env node
/**
 * FTP 端点对拍驱动器。
 *
 * 对某个 base URL 跑一条固定请求序列，输出规范化 JSON（key 递归排序），
 * Node 侧（最小 express 应用）与 Go 侧（真实 zviewer-server）各跑一遍后
 * 逐步骤比较。
 *
 * 二进制响应只记录「状态码 + 关键头 + 声明长度内的字节指纹」，因为
 * Node 侧 FTP 代理有个已知缺陷：REST 只能定起点、服务端一直发到文件尾，
 * 但 Content-Length 只声明请求的区间长度，于是实际写出的字节**多于**声明。
 * Go 侧按声明长度截断（修的是 HTTP 协议违规），所以这里比的是
 * 「声明长度内的内容」，而不是裸字节数——两边在这一点上的差异
 * 在 MIGRATION.md 里单独记录。
 *
 * 用法：
 *   node parity-ftp-run.js --base http://127.0.0.1:PORT --host 127.0.0.1 \
 *     --ftpPort 2121 --user ftp-owner --ftpUser ftp-user --ftpPass ftp-secret \
 *     --movieId 3
 */
const results = [];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

/** 挂载 DTO 的时间列两端各写各的 now，票据是随机 UUID，比对时都要抹平。 */
function stripNoise(payload) {
  if (typeof payload === 'string') return payload.replace(/ticket=[0-9a-f-]{8,}/g, 'ticket=<UUID>');
  if (Array.isArray(payload)) return payload.map(stripNoise);
  if (!payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    out[key] = stripNoise(value);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.base;
  if (!base) {
    process.stderr.write('缺少 --base\n');
    process.exit(2);
  }
  const host = args.host || '127.0.0.1';
  const ftpPort = args.ftpPort;
  const ftpUser = args.ftpUser || 'ftp-user';
  const ftpPass = args.ftpPass || 'ftp-secret';
  const ftpURL = args.ftpUrl || `ftp://${host}`;

  const username = args.user || 'ftp-owner';
  const login = async () => {
    const probe = await fetch(base + '/__parity/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const body = await probe.json().catch(() => ({}));
    if (body.accessToken) return body.accessToken;
    // Go 侧没有 __parity/login，走真实登录（口令由 shell 侧写进种子库）
    const real = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: args.password || 'ftp-pass-1234' }),
    });
    const realBody = await real.json().catch(() => ({}));
    if (!realBody.accessToken) throw new Error('登录失败: ' + JSON.stringify(realBody));
    return realBody.accessToken;
  };
  const token = await login();

  const call = async (step, method, url, body, opts) => {
    const headers = { Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts && opts.range) headers.Range = opts.range;
    const res = await fetch(base + url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const parsed = await res.json().catch(() => ({}));
      results.push({ step, status: res.status, body: canonical(stripNoise(parsed)) });
      return parsed;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const declared = Number(res.headers.get('content-length') || 0);
    const usable = declared > 0 ? Math.min(declared, buf.length) : buf.length;
    results.push({
      step,
      status: res.status,
      body: {
        contentRange: res.headers.get('content-range'),
        contentLength: declared || null,
        acceptRanges: res.headers.get('accept-ranges'),
        contentType: contentType || null,
        // 声明长度内的字节数（忽略 Node 侧多写出来的尾巴）
        payloadLength: usable,
        head: buf.subarray(0, 8).toString('hex'),
      },
    });
    return buf;
  };

  // 1. 初始挂载列表
  await call('1.空挂载列表', 'GET', '/api/ftp/mounts');

  // 2. 连接测试：列 /videos（6 项：5 个文件 + 1 个子目录）
  await call('2.连接测试', 'POST', '/api/ftp/mounts/test', {
    serverUrl: host,
    port: Number(ftpPort),
    path: '/videos',
    username: ftpUser,
    password: ftpPass,
  });

  // 3. 错密码 → 400，文案是服务器原文（两端必然一致）
  await call('3.连接测试错密码', 'POST', '/api/ftp/mounts/test', {
    serverUrl: host,
    port: Number(ftpPort),
    path: '/videos',
    username: ftpUser,
    password: 'wrong-pass',
  });

  // 4. 缺 serverUrl
  await call('4.连接测试缺地址', 'POST', '/api/ftp/mounts/test', { path: '/videos' });

  // 5. 端口越界
  await call('5.连接测试非法端口', 'POST', '/api/ftp/mounts/test', {
    serverUrl: host,
    port: 70000,
    path: '/videos',
  });

  // 6. ftp:// URL 形态（另一条 serverUrl 解析分支）
  await call('6.连接测试URL形态', 'POST', '/api/ftp/mounts/test', {
    serverUrl: ftpURL,
    port: String(ftpPort),
    path: '/videos',
    username: ftpUser,
    password: ftpPass,
  });

  // 7. 创建挂载（port 用字符串形态）
  const created = await call('7.创建挂载', 'POST', '/api/ftp/mounts', {
    name: 'FTP 对拍挂载',
    serverUrl: host,
    port: String(ftpPort),
    path: '/videos',
    username: ftpUser,
    password: ftpPass,
  });
  const mountId = created && created.mount ? created.mount.id : 0;

  await call('8.挂载列表', 'GET', '/api/ftp/mounts');

  // 9~11. 浏览
  await call('9.浏览根目录', 'GET', `/api/ftp/mounts/${mountId}/browse`);
  await call('10.浏览子目录', 'GET', `/api/ftp/mounts/${mountId}/browse?path=${encodeURIComponent('/videos/sub')}`);
  await call('11.浏览空path', 'GET', `/api/ftp/mounts/${mountId}/browse?path=`);

  // 12~14. 解析（含 SIZE 不可用时的 LIST 回退、中文+空格名）
  await call('12.解析文件', 'GET', `/api/ftp/resolve?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`);
  await call(
    '13.解析中文名',
    'GET',
    `/api/ftp/resolve?mountId=${mountId}&path=${encodeURIComponent('/videos/中文 名.mp4')}`,
  );
  await call(
    '14.解析无SIZE文件',
    'GET',
    `/api/ftp/resolve?mountId=${mountId}&path=${encodeURIComponent('/videos/nosize.mkv')}`,
  );

  // 15~19. 代理流的四种 Range 形态
  const proxyPath = encodeURIComponent('/videos/a.mkv');
  await call('15.代理Range', 'GET', `/api/ftp/proxy?mountId=${mountId}&path=${proxyPath}`, undefined, {
    range: 'bytes=0-99',
  });
  await call('16.代理全量', 'GET', `/api/ftp/proxy?mountId=${mountId}&path=${proxyPath}`);
  await call('17.代理开放式Range', 'GET', `/api/ftp/proxy?mountId=${mountId}&path=${proxyPath}`, undefined, {
    range: 'bytes=0-',
  });
  await call('18.代理越界Range', 'GET', `/api/ftp/proxy?mountId=${mountId}&path=${proxyPath}`, undefined, {
    range: 'bytes=99999999-',
  });
  await call(
    '19.代理中段Range',
    'GET',
    `/api/ftp/proxy?mountId=${mountId}&path=${proxyPath}`,
    undefined,
    { range: 'bytes=100000-500000' },
  );

  // 20~22. 影片流（播放器实际入口；凭证靠 serverUrl + type + 房主回退）
  if (args.movieId) {
    await call('20.影片流Range', 'GET', `/api/ftp/stream?movieId=${args.movieId}`, undefined, {
      range: 'bytes=0-99',
    });
    await call('21.影片流全量', 'GET', `/api/ftp/stream?movieId=${args.movieId}`);
    await call('22.影片流不存在', 'GET', '/api/ftp/stream?movieId=999999');
  }

  // 23~26. 挂载维护
  await call('23.非法挂载ID', 'GET', '/api/ftp/mounts/abc/browse');
  await call('24.不存在挂载', 'GET', '/api/ftp/mounts/999999/browse');
  await call('25.更新挂载', 'PUT', `/api/ftp/mounts/${mountId}`, {
    name: 'FTP 对拍挂载(改名)',
    serverUrl: host,
    port: String(ftpPort),
    path: '/videos',
    username: ftpUser,
  });
  await call('26.更新后列表', 'GET', '/api/ftp/mounts');

  // 27~31. 临时连接（票据链路）
  const directQuery = new URLSearchParams({
    serverUrl: host,
    port: String(ftpPort),
    path: '/videos/a.mkv',
    username: ftpUser,
    password: ftpPass,
  }).toString();
  const direct = await call('27.临时连接解析', 'GET', `/api/stream/resolve-ftp?${directQuery}`);
  if (direct && direct.videoUrl) {
    await call('28.临时连接代理', 'GET', direct.videoUrl);
  }
  await call('29.临时连接无效票据', 'GET', '/api/stream/proxy-ftp?ticket=not-a-ticket');
  await call('30.临时连接缺参数', 'GET', '/api/stream/resolve-ftp?serverUrl=' + host);
  const badQuery = new URLSearchParams({
    serverUrl: host,
    port: String(ftpPort),
    path: '/videos/a.mkv',
    username: ftpUser,
    password: 'wrong-pass',
  }).toString();
  await call('31.临时连接错密码', 'GET', `/api/stream/resolve-ftp?${badQuery}`);

  // 32~34. 删除
  await call('32.删除挂载', 'DELETE', `/api/ftp/mounts/${mountId}`);
  await call('33.删除后列表', 'GET', '/api/ftp/mounts');
  await call('34.重复删除', 'DELETE', `/api/ftp/mounts/${mountId}`);

  process.stdout.write(JSON.stringify(results, null, 1) + '\n');
}

main().catch((e) => {
  process.stderr.write('对拍序列失败: ' + e.stack + '\n');
  process.exit(1);
});
