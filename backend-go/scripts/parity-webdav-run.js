#!/usr/bin/env node
/**
 * WebDAV 端点对拍驱动器。
 *
 * 对某个 base URL 跑一条固定请求序列，输出规范化 JSON（key 递归排序），
 * Node 侧（最小 express 应用）与 Go 侧（真实 zviewer-server）各跑一遍后逐字节比较。
 *
 * 二进制响应（/proxy、/stream）不比对内容，只比对状态码、关键头与字节数；
 * 两端从同一个 mock WebDAV 取数据，字节数一致即说明切片范围一致。
 *
 * 用法：
 *   node parity-webdav-run.js --base http://127.0.0.1:PORT --dav http://127.0.0.1:DAVPORT/dav \
 *     --user parity-user --davUser dav-user --davPass dav-secret
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

/** 挂载 DTO 里的时间列两端不可能相等（各写各的 now），比对时剔掉。 */
function stripMount(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clean = (m) => {
    if (!m || typeof m !== 'object') return m;
    const copy = { ...m };
    delete copy.createdAt;
    delete copy.updatedAt;
    return copy;
  };
  if (Array.isArray(payload.mounts)) {
    return { ...payload, mounts: payload.mounts.map(clean) };
  }
  if (payload.mount) return { ...payload, mount: clean(payload.mount) };
  return payload;
}

async function main() {
  const args = parseArgs(process.argv);
  const base = args.base;
  if (!base) {
    process.stderr.write('缺少 --base\n');
    process.exit(2);
  }
  const davUrl = args.dav;
  const davUser = args.davUser || 'dav-user';
  const davPass = args.davPass || 'dav-secret';

  const login = async (username) => {
    const probe = await fetch(base + '/__parity/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const body = await probe.json().catch(() => ({}));
    if (body.accessToken) return body.accessToken;
    const real = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: args.password || 'webdav-pass-1234' }),
    });
    const realBody = await real.json().catch(() => ({}));
    if (!realBody.accessToken) throw new Error('登录失败: ' + JSON.stringify(realBody));
    return realBody.accessToken;
  };

  const token = await login(args.user || 'webdav-owner');

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
      results.push({ step, status: res.status, body: canonical(stripMount(parsed)) });
      return parsed;
    }
    // 二进制：只记录字节数与关键头
    const buf = Buffer.from(await res.arrayBuffer());
    results.push({
      step,
      status: res.status,
      body: {
        bytes: buf.length,
        contentRange: res.headers.get('content-range'),
        acceptRanges: res.headers.get('accept-ranges'),
        contentType: contentType || null,
        // 取前 8 字节做指纹，确认两端读到的是同一段数据
        head: buf.subarray(0, 8).toString('hex'),
      },
    });
    return null;
  };

  // 1. 初始挂载列表
  await call('1.空挂载列表', 'GET', '/api/webdav/mounts');

  // 2. 连接测试：路径 /videos（含中文名与子目录，itemCount 应为 3）
  await call('2.连接测试', 'POST', '/api/webdav/mounts/test', {
    serverUrl: davUrl,
    path: '/videos',
    username: davUser,
    password: davPass,
  });

  // 3. 连接测试：错密码 → 期望 400 + AUTH_FAILED
  await call('3.连接测试错密码', 'POST', '/api/webdav/mounts/test', {
    serverUrl: davUrl,
    path: '/videos',
    username: davUser,
    password: 'wrong',
  });

  // 4. 连接测试：缺 serverUrl → 400 + INVALID_URL
  await call('4.连接测试缺地址', 'POST', '/api/webdav/mounts/test', { path: '/videos' });

  // 5. 创建挂载：请求直链，但地址是内网 → 强制中转 + warning
  const created = await call('5.创建挂载', 'POST', '/api/webdav/mounts', {
    name: '对拍挂载',
    serverUrl: davUrl,
    path: '/videos',
    username: davUser,
    password: davPass,
    directLink: true,
  });
  const mountId = created && created.mount ? created.mount.id : 0;

  // HTTPS 能力探测在两侧都是「保存后异步写回」，落库时机有毫秒级差异。
  // 这里显式等它落地（最多 2s），否则比对到的是时序而不是行为。
  // 探测结果本身是确定的：mock 是明文 HTTP，https 同端口握手必失败 → false。
  for (let i = 0; i < 20; i++) {
    const list = await (
      await fetch(base + '/api/webdav/mounts', { headers: { Authorization: 'Bearer ' + token } })
    ).json();
    const target = (list.mounts || []).find((m) => m.id === mountId);
    if (!target || target.httpsDirect !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  await call('6.挂载列表', 'GET', '/api/webdav/mounts');

  // 7. 浏览挂载根（/videos）
  await call('7.浏览根目录', 'GET', `/api/webdav/mounts/${mountId}/browse`);

  // 8. 浏览子目录
  await call('8.浏览子目录', 'GET', `/api/webdav/mounts/${mountId}/browse?path=${encodeURIComponent('/sub')}`);

  // 9. 解析文件（ASCII 名）
  await call('9.解析文件', 'GET', `/api/webdav/resolve?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`);

  // 10. 解析文件（中文+空格名，验证两端路径编码一致）
  await call(
    '10.解析中文名',
    'GET',
    `/api/webdav/resolve?mountId=${mountId}&path=${encodeURIComponent('/videos/测试 影片.mp4')}`,
  );

  // 11. 代理流：显式 Range
  await call('11.代理Range', 'GET', `/api/webdav/proxy?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`, undefined, {
    range: 'bytes=0-99',
  });

  // 12. 代理流：无 Range（全量）
  await call('12.代理全量', 'GET', `/api/webdav/proxy?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`);

  // 13. 代理流：开放式 Range（应收敛到 8MiB 以内，本文件 1MiB → 全量）
  await call('13.代理开放式Range', 'GET', `/api/webdav/proxy?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`, undefined, {
    range: 'bytes=0-',
  });

  // 14. 代理流：越界 Range（fileSize 之上）
  await call('14.代理越界Range', 'GET', `/api/webdav/proxy?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`, undefined, {
    range: 'bytes=99999999-',
  });

  // 15. 直链：内网地址必须拒绝
  await call('15.直链(内网拒绝)', 'GET', `/api/webdav/direct-url?mountId=${mountId}&path=${encodeURIComponent('/videos/a.mkv')}`);

  // 16. 更新挂载（不传密码 → 沿用旧密码，改名成功）
  await call('16.更新挂载', 'PUT', `/api/webdav/mounts/${mountId}`, {
    name: '对拍挂载(改名)',
    serverUrl: davUrl,
    path: '/videos',
    username: davUser,
    directLink: false,
  });

  // 17. 更新后列表
  await call('17.更新后列表', 'GET', '/api/webdav/mounts');

  // 17a~17c. 影片流（播放器实际走的入口）。影片种子由 shell 侧写入，
  // movieId 通过 --movieId 传入；影片行本身不带凭证，必须靠
  // serverUrl + type + 房主回退到挂载取凭证。
  const movieId = args.movieId;
  if (movieId) {
    await call('17a.影片流Range', 'GET', `/api/webdav/stream?movieId=${movieId}`, undefined, {
      range: 'bytes=0-99',
    });
    await call('17b.影片流全量', 'GET', `/api/webdav/stream?movieId=${movieId}`);
    await call('17c.影片流不存在', 'GET', '/api/webdav/stream?movieId=999999');
  }

  // 18. 挂载 ID 非数字
  await call('18.非法挂载ID', 'GET', '/api/webdav/mounts/abc/browse');

  // 19. 不存在的挂载
  await call('19.不存在挂载', 'GET', '/api/webdav/mounts/999999/browse');

  // 20. 删除挂载
  await call('20.删除挂载', 'DELETE', `/api/webdav/mounts/${mountId}`);
  await call('21.删除后列表', 'GET', '/api/webdav/mounts');
  await call('22.重复删除', 'DELETE', `/api/webdav/mounts/${mountId}`);

  process.stdout.write(JSON.stringify(results, null, 1) + '\n');
}

main().catch((e) => {
  process.stderr.write('对拍序列失败: ' + e.stack + '\n');
  process.exit(1);
});
