#!/usr/bin/env node
/**
 * 假 NCM API 服务（一起听对拍用）。
 *
 * Node 版用 `@neteasecloudmusicapienhanced/api` 在 127.0.0.1:36530 起内部服务，
 * Go 版由 `NCM_API_BASE` 指过来。对拍时两侧都指到这个假服务，数据固定，
 * 所以可以逐字段比较。
 *
 * 覆盖的坑：
 * - `/echo` 回显 cookie 与 query，用来验「客户端传的 cookie/noCookie 被剥掉」；
 * - 扫码三接口也回显 cookie（QR 登录必须无 cookie 调用，注入旧 MUSIC_U 会让轮询 800）；
 * - `/nuser/account/get` 下发 Set-Cookie（验登录态落库）；
 * - `/album` 带 MUSIC_U 时少给一首（验匿名补齐）；
 * - `/song/url/v1` 与 `/song/url` 的降级链、试听片段、无版权、非白名单域名；
 * - `/redirect` 与 `/not-json` 分别验「不跟随重定向」与「非 JSON → 502」。
 *
 * 用法：node mock-ncm.js <port>
 */
'use strict';

const http = require('node:http');

const port = Number(process.argv[2] || 0);

/** 曲目表：每首歌覆盖一种解析分支。 */
const SONGS = {
  // 正常：任意档位都能拿到直链
  1001: { url: 'https://m801.music.126.net/1001.mp3', type: 'mp3', br: 320000, sr: 44100 },
  // 只有 higher 及以下有地址 → 验降级链（请求 exhigh 时实际解析出 higher）
  2002: { url: 'https://m801.music.126.net/2002.mp3', type: 'mp3', br: 192000, sr: 44100, minLevel: 'higher' },
  // 试听片段 → VIP_REQUIRED
  3003: { freeTrial: true },
  // 全部不可用 + check/music 说没版权 → NO_COPYRIGHT
  4004: { url: null },
  // v1 路由 404（依赖残缺）→ 回退老接口 /song/url
  5005: { legacyOnly: true },
  // 直链域名不在 *.music.126.net → RESOLVE_FAILED（防 SSRF）
  6006: { url: 'https://evil.example.com/6006.mp3', type: 'mp3', br: 320000 },
  // 全部不可用但版权正常 → RESOLVE_FAILED
  7007: { url: null },
};

const LEVEL_ORDER = ['lossless', 'exhigh', 'higher', 'standard'];

function song(id) {
  return SONGS[id] || { url: null };
}

/** 该档位是否有直链（minLevel 表示「从这一档开始才有」）。 */
function levelAvailable(spec, level) {
  if (spec.legacyOnly || spec.freeTrial) return false;
  if (spec.url === null || spec.url === undefined) return false;
  if (!spec.minLevel) return true;
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(spec.minLevel);
}

function cookieHeader(req) {
  return req.headers.cookie || '';
}

function sendJSON(res, status, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  // 探活（Node 的 waitForApiReachable / Go 的 Available 都打这里）
  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ncm-mock');
    return;
  }

  // 回显：cookie / query / body（query 去掉 timestamp，两侧都能对上）
  if (path === '/echo') {
    const query = {};
    for (const [key, value] of url.searchParams) {
      if (key === 'timestamp') continue;
      query[key] = value;
    }
    let body = null;
    if (req.method === 'POST') {
      const raw = await readBody(req);
      const text = raw.toString('utf8');
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { __raw: text };
        }
      }
    }
    sendJSON(res, 200, {
      method: req.method,
      path,
      cookie: cookieHeader(req),
      query,
      body,
    });
    return;
  }

  // 扫码登录三接口：把收到的 cookie 回显出来（应为空）
  if (path.startsWith('/login/qr/')) {
    sendJSON(res, 200, {
      code: 200,
      data: { unikey: 'QRKEY' },
      cookie: cookieHeader(req),
    });
    return;
  }

  if (path === '/user/account') {
    sendJSON(res, 200, {
      code: 200,
      profile: {
        nickname: '网易云用户',
        avatarUrl: 'https://p1.music.126.net/avatar.jpg',
        vipType: 0,
      },
    });
    return;
  }

  if (path === '/vip/info') {
    sendJSON(res, 200, {
      code: 200,
      data: {
        associator: {
          vipCode: 100,
          expireTime: 4102444800000,
          iconUrl: 'https://cdn.example.com/vip.png',
        },
        musicPackage: { vipCode: 0, expireTime: 0, iconUrl: '' },
        redplus: null,
      },
    });
    return;
  }

  // Cookie 登录校验：下发登录态 cookie（验落库）
  if (path === '/nuser/account/get') {
    sendJSON(
      res,
      200,
      {
        code: 200,
        profile: {
          nickname: 'Cookie 用户',
          avatarUrl: 'https://p1.music.126.net/cookie.jpg',
        },
      },
      {
        'Set-Cookie': [
          'MUSIC_U=nuser-uuid; Path=/; HttpOnly',
          '__csrf=csrf-token; Path=/',
        ],
      },
    );
    return;
  }

  // 专辑：带 MUSIC_U 时少给一首（Node/Go 都会用匿名上下文补齐）
  if (path === '/album') {
    const loggedIn = cookieHeader(req).includes('MUSIC_U=');
    const all = [
      { id: 1, name: '第一首' },
      { id: 2, name: '第二首' },
      { id: 3, name: '第三首' },
    ];
    sendJSON(res, 200, {
      code: 200,
      album: { id: Number(url.searchParams.get('id')), size: 3 },
      songs: loggedIn ? all.slice(0, 2) : all,
    });
    return;
  }

  if (path === '/song/url/v1') {
    const id = Number(url.searchParams.get('id'));
    const level = url.searchParams.get('level') || '';
    const spec = song(id);
    if (spec.legacyOnly) {
      sendJSON(res, 404, { code: 404, msg: 'Not Found' });
      return;
    }
    if (spec.freeTrial) {
      sendJSON(res, 200, {
        code: 200,
        data: [{ id, url: null, freeTrialInfo: { start: 0, end: 30 }, level }],
      });
      return;
    }
    if (!levelAvailable(spec, level)) {
      sendJSON(res, 200, { code: 200, data: [{ id, url: null, freeTrialInfo: null, level }] });
      return;
    }
    sendJSON(res, 200, {
      code: 200,
      data: [
        {
          id,
          url: spec.url,
          type: spec.type || 'mp3',
          br: spec.br || 128000,
          sr: spec.sr || 44100,
          level,
        },
      ],
    });
    return;
  }

  // 老接口：只有 5005 有地址（对应 v1 依赖残缺时的兜底）
  if (path === '/song/url') {
    const id = Number(url.searchParams.get('id'));
    const spec = song(id);
    if (id === 5005) {
      sendJSON(res, 200, {
        code: 200,
        data: [
          {
            id,
            url: 'https://m801.music.126.net/5005.mp3',
            br: Number(url.searchParams.get('br')),
            type: 'mp3',
            sr: 44100,
          },
        ],
      });
      return;
    }
    sendJSON(res, 200, { code: 200, data: [{ id, url: spec.url || null }] });
    return;
  }

  if (path === '/check/music') {
    const id = Number(url.searchParams.get('id'));
    // 4004 判无版权，其余正常
    sendJSON(res, 200, { success: id !== 4004, code: 200 });
    return;
  }

  if (path === '/redirect') {
    res.writeHead(302, { Location: '/target' });
    res.end();
    return;
  }

  if (path === '/target') {
    sendJSON(res, 200, { code: 200, ok: true });
    return;
  }

  if (path === '/not-json') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html>not json</html>');
    return;
  }

  // 云盘上传：回显 cookie 与「有没有收到文件字段」。
  // 不回显字节数：multipart 的 boundary 每次随机，长度不可比。
  if (path === '/cloud') {
    const raw = await readBody(req);
    const text = raw.toString('utf8');
    sendJSON(res, 200, {
      code: 200,
      cookie: cookieHeader(req),
      hasFile: text.includes('name="file"'),
    });
    return;
  }

  sendJSON(res, 404, { code: 404, msg: 'Not Found', path });
});

server.listen(port, '127.0.0.1', () => {
  console.log(server.address().port);
});
