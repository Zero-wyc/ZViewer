#!/usr/bin/env node
/**
 * Emby / Jellyfin 端点对拍驱动器。
 *
 * 对某个 base URL 跑一条固定请求序列，输出规范化 JSON（key 递归排序），
 * Node 侧（最小 express 应用）与 Go 侧（真实 zviewer-server）各跑一遍后逐步骤比较。
 *
 * m3u8 改写结果按**全文**比对（不是只看字节数）：令牌有没有被抹掉、
 * resource 参数拼得对不对，只有逐字符比才看得出来。
 *
 * 用法：
 *   node parity-emby-run.js --base http://127.0.0.1:PORT \
 *     --mock http://127.0.0.1:MOCKPORT --user emby-owner --movieIds 1,2
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

/** 挂载 DTO 的时间列两端不可能相等（各写各的 now），比对时剔掉。 */
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
  const mockUrl = args.mock;
  const embyUser = args.embyUser || 'emby';
  const embyPass = args.embyPass || 'emby-pass';
  const movieIds = (args.movieIds || '').split(',').filter(Boolean).map(Number);

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
      body: JSON.stringify({ username, password: args.password || 'emby-owner-pass' }),
    });
    const realBody = await real.json().catch(() => ({}));
    if (!realBody.accessToken) throw new Error('登录失败: ' + JSON.stringify(realBody));
    return realBody.accessToken;
  };

  const token = await login(args.user || 'emby-owner');

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
    const buf = Buffer.from(await res.arrayBuffer());
    if (/mpegurl|text\/plain/.test(contentType)) {
      // 播放列表 / 文本：全文比对（改写结果必须逐字符相同）
      results.push({ step, status: res.status, body: { contentType, text: buf.toString('utf8') } });
      return null;
    }
    results.push({
      step,
      status: res.status,
      body: {
        bytes: buf.length,
        contentRange: res.headers.get('content-range'),
        acceptRanges: res.headers.get('accept-ranges'),
        contentType: contentType || null,
        etag: res.headers.get('etag'),
        cacheControl: res.headers.get('cache-control'),
        // 取前 8 字节做指纹，确认两端读到的是同一段数据
        head: buf.subarray(0, 8).toString('hex'),
      },
    });
    return null;
  };

  const mockBase = mockUrl || '';
  const embyUrl = mockBase;

  // 每轮开跑前把 mock 的会话与登录计数清空：两侧是**先后**跑同一条序列的，
  // 不清零的话 Go 侧第一次登录拿到的就是 tok-2（Node 已经用掉了 1），
  // 比对结果里会出现纯编号差异。
  if (mockUrl) {
    await fetch(mockUrl + '/__invalidate', { method: 'POST' });
  }

  // 1~2. 初始挂载列表 / 缺地址
  await call('1.空挂载列表', 'GET', '/api/emby/mounts');
  await call('2.连接测试缺地址', 'POST', '/api/emby/mounts/test', { username: embyUser, password: embyPass });

  // 3~5. 连接测试：账号密码 / API Key / 缺凭证
  await call('3.连接测试账号密码', 'POST', '/api/emby/mounts/test', {
    serverUrl: embyUrl,
    username: embyUser,
    password: embyPass,
  });
  await call('4.连接测试API Key', 'POST', '/api/emby/mounts/test', {
    serverUrl: embyUrl,
    apiKey: 'api-key-ok',
  });
  await call('5.连接测试缺凭证', 'POST', '/api/emby/mounts/test', { serverUrl: embyUrl });

  // 6~7. 连接测试失败分支
  await call('6.连接测试错密码', 'POST', '/api/emby/mounts/test', {
    serverUrl: embyUrl,
    username: embyUser,
    password: 'wrong-pass',
  });
  // /Users/Me 返回 500 → 回退 /Users 取管理员
  await call('7.连接测试回退取管理员', 'POST', '/api/emby/mounts/test', {
    serverUrl: embyUrl,
    apiKey: 'api-key-broken-me',
  });

  // 8~9. 创建挂载
  const created = await call('8.创建挂载', 'POST', '/api/emby/mounts', {
    name: '对拍 Emby 挂载',
    serverUrl: embyUrl,
    username: embyUser,
    password: embyPass,
    directLink: true,
  });
  const mountId = created && created.mount ? created.mount.id : 0;
  await call('9.创建挂载空名', 'POST', '/api/emby/mounts', {
    name: '   ',
    serverUrl: embyUrl,
    apiKey: 'api-key-ok',
  });
  await call('10.创建挂载错密码', 'POST', '/api/emby/mounts', {
    name: '错的',
    serverUrl: embyUrl,
    username: embyUser,
    password: 'nope',
  });
  await call('11.挂载列表', 'GET', '/api/emby/mounts');

  // 12~18. 浏览 / 搜索
  await call('12.浏览根（媒体库）', 'GET', `/api/emby/mounts/${mountId}/browse`);
  await call('13.浏览电影库', 'GET', `/api/emby/mounts/${mountId}/browse?path=lib-movies`);
  await call('14.浏览剧集', 'GET', `/api/emby/mounts/${mountId}/browse?path=s1`);
  await call('15.浏览挂载ID非数字', 'GET', '/api/emby/mounts/abc/browse');
  await call('16.浏览不存在的挂载', 'GET', '/api/emby/mounts/999999/browse');
  await call('17.搜索', 'GET', `/api/emby/mounts/${mountId}/search?term=${encodeURIComponent('沙丘')}`);
  await call('18.搜索空词', 'GET', `/api/emby/mounts/${mountId}/search?term=`);

  // 19~22. 海报（含文件夹回退、ETag/304）
  await call('19.海报有tag', 'GET', `/api/emby/mounts/${mountId}/image?itemId=m1&tag=tag-m1`);
  await call('20.海报无tag文件夹回退', 'GET', `/api/emby/mounts/${mountId}/image?itemId=plain-folder&maxWidth=180`);
  await call('21.海报不存在条目', 'GET', `/api/emby/mounts/${mountId}/image?itemId=nope&tag=x`);
  await call('22.海报缺itemId', 'GET', `/api/emby/mounts/${mountId}/image`);

  // 23~30. 解析
  await call('23.解析单版本', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m1`);
  await call('24.解析多版本默认', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m2`);
  await call('25.解析多版本选4K', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m2&ms=ms-m2-4k`);
  await call('26.解析DTS音轨', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m3`);
  await call('27.解析缺Path条目', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m4`);
  await call('28.解析无媒体源', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m-empty`);
  await call('29.解析缺参数', 'GET', `/api/emby/resolve?mountId=${mountId}`);
  await call('30.解析挂载ID非数字', 'GET', '/api/emby/resolve?mountId=abc&path=m1');

  // 31~37. 代理
  await call('31.代理静态Range', 'GET', `/api/emby/proxy?mountId=${mountId}&path=m1`, undefined, {
    range: 'bytes=0-31',
  });
  await call('32.代理静态全量', 'GET', `/api/emby/proxy?mountId=${mountId}&path=m1`);
  await call('33.代理转码播放列表', 'GET', `/api/emby/proxy?mountId=${mountId}&path=m3&at=1`);
  await call(
    '34.代理HLS分片',
    'GET',
    `/api/emby/proxy?mountId=${mountId}&path=m3&resource=${encodeURIComponent('/emby/Videos/m3/hls1/main/0.ts')}`,
  );
  await call(
    '35.代理HLS非法资源',
    'GET',
    `/api/emby/proxy?mountId=${mountId}&path=m3&resource=${encodeURIComponent('/emby/Videos/other/hls1/main/0.ts')}`,
  );
  await call('36.代理缺mountId', 'GET', '/api/emby/proxy?path=m1');
  await call('37.代理缺path', 'GET', `/api/emby/proxy?mountId=${mountId}`);

  // 38~39. 令牌失效 → 客户端应丢弃陈旧登录缓存并重登一次
  if (mockUrl) {
    await fetch(mockUrl + '/__invalidate', { method: 'POST' });
    await call('38.令牌失效后浏览（自动重登）', 'GET', `/api/emby/mounts/${mountId}/browse?path=lib-movies`);
  }
  await call('39.重登后解析', 'GET', `/api/emby/resolve?mountId=${mountId}&path=m1`);

  // 40~44. 影片流（房间内观众走的入口）
  if (movieIds.length >= 2) {
    await call('40.影片流Range', 'GET', `/api/emby/stream?movieId=${movieIds[0]}`, undefined, {
      range: 'bytes=0-15',
    });
    await call('41.影片流转码播放列表', 'GET', `/api/emby/stream?movieId=${movieIds[1]}`);
    await call('42.影片流不存在', 'GET', '/api/emby/stream?movieId=999999');
    await call('43.影片流缺movieId', 'GET', '/api/emby/stream');
    await call('44.影片版本列表', 'GET', `/api/emby/movie-source?movieId=${movieIds[0]}`);
  }

  // 45~46. 更新
  await call('45.更新挂载改名', 'PUT', `/api/emby/mounts/${mountId}`, { name: '改名后的挂载' });
  await call('46.更新挂载ID非数字', 'PUT', '/api/emby/mounts/abc', { name: 'x' });

  // 47~49. Jellyfin 前缀走同一套实现
  await call('47.Jellyfin无挂载浏览', 'GET', '/api/jellyfin/mounts');
  const jelly = await call('48.Jellyfin创建挂载', 'POST', '/api/jellyfin/mounts', {
    name: '对拍 Jellyfin 挂载',
    serverUrl: embyUrl,
    apiKey: 'api-key-ok',
  });
  const jellyId = jelly && jelly.mount ? jelly.mount.id : 0;
  await call('49.Jellyfin浏览', 'GET', `/api/jellyfin/mounts/${jellyId}/browse`);

  // 50~52. 删除
  await call('50.删除Jellyfin挂载', 'DELETE', `/api/jellyfin/mounts/${jellyId}`);
  await call('51.再删同一个', 'DELETE', `/api/jellyfin/mounts/${jellyId}`);
  await call('52.删除Emby挂载', 'DELETE', `/api/emby/mounts/${mountId}`);

  process.stdout.write(JSON.stringify(results, null, 1) + '\n');
}

main().catch((e) => {
  process.stderr.write('驱动器失败: ' + (e && e.stack) + '\n');
  process.exit(1);
});
