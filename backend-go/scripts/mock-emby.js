#!/usr/bin/env node
/**
 * 最小 Emby / Jellyfin 模拟服务器（阶段 6 对拍用）。
 *
 * 只实现 ZViewer 客户端真正会打的那几个端点，但每条都带「可判定」的边界：
 * - 登录：校验 X-Emby-Authorization 客户端标识头（缺了 400）、错密码 401；
 * - /Users/Me 对特定账号返回 500，用于验证「回退 /Users 取管理员」的降级链；
 * - 条目：含缺 Path / 缺时间戳 / 只有子项有海报（触发海报回退）等形态；
 * - 播放：多版本 MediaSource、DTS 音轨（触发转码）、空 MediaSources；
 * - 视频流：真实 Range 支持；转码播放列表带 api_key，用于验证改写时确实抹掉了令牌。
 *
 * /__invalidate 会清空会话令牌但保留 API Key，让两侧都能走到
 * 「401 → 丢弃陈旧登录缓存 → 重登 → 重试」这条分支。
 *
 * 用法：node mock-emby.js <端口>
 */
const http = require('http');

const port = Number(process.argv[2]);
if (!port) {
  process.stderr.write('用法: mock-emby.js <端口>\n');
  process.exit(2);
}

const SERVER_ID = 'srv-mock-1';

/** 账号：meBroken 的账号 /Users/Me 返回 500（触发回退 /Users）。 */
const USERS = {
  emby: { id: 'user-emby', password: 'emby-pass', name: 'Emby 用户', meBroken: false },
  brokenme: { id: 'user-broken', password: 'broken-pass', name: 'Broken 用户', meBroken: true },
};

/** API Key：直接带 token 访问，userId 只能靠 /Users/Me 或挂载表里的缓存。 */
const API_KEYS = {
  'api-key-ok': { id: 'user-api', name: 'API 用户', meBroken: false },
  'api-key-broken-me': { id: 'user-api', name: 'API 用户', meBroken: true },
};

/** token → 会话（登录成功后写入；/__invalidate 清空）。 */
const sessions = new Map();
let loginCounter = 0;

const requests = [];

const VIEWS = [
  { Id: 'lib-movies', Name: '电影', Type: 'CollectionFolder', IsFolder: true, ChildCount: 3 },
  { Id: 'lib-tv', Name: '剧集', Type: 'CollectionFolder', IsFolder: true, ChildCount: 1 },
  { Id: 'lib-plain', Name: '无海报库', Type: 'CollectionFolder', IsFolder: true, ChildCount: 1 },
];

/** ParentId → 子项。字段刻意有缺（有的没有 Path、有的没有 ImageTags）。 */
const CHILDREN = {
  'lib-movies': [
    {
      Id: 'm1',
      Name: '沙丘',
      Type: 'Movie',
      Path: '/media/电影/沙丘 2021.mkv',
      ImageTags: { Primary: 'tag-m1' },
      ProductionYear: 2021,
      RunTimeTicks: 97200000000, // 9720 秒
    },
    {
      Id: 'm2',
      Name: '多版本影片',
      Type: 'Movie',
      Path: '/media/电影/m2.mkv',
      ImageTags: { Primary: 'tag-m2' },
      ProductionYear: 2022,
      RunTimeTicks: 54000000000,
    },
    {
      // 缺 Path：验证 title 退化成 item-<id>、format 退化成 unknown
      Id: 'm4',
      Name: '缺路径影片',
      Type: 'Movie',
      ImageTags: { Primary: 'tag-m4' },
    },
  ],
  'lib-tv': [
    {
      Id: 's1',
      Name: '某剧',
      Type: 'Series',
      IsFolder: true,
      ChildCount: 2,
      RecursiveItemCount: 2,
      ImageTags: { Primary: 'tag-s1' },
    },
  ],
  s1: [
    {
      Id: 'e1',
      Name: '第一集',
      Type: 'Episode',
      Path: '/media/剧/e1.mkv',
      IndexNumber: 1,
      ParentIndexNumber: 1,
      RunTimeTicks: 14400000000,
    },
    {
      Id: 'e2',
      Name: '第二集',
      Type: 'Episode',
      Path: '/media/剧/e2.mkv',
      IndexNumber: 2,
      ParentIndexNumber: 1,
      RunTimeTicks: 15000000000,
    },
  ],
  'lib-plain': [
    // 自身没有 Primary（文件夹海报回退的典型场景）
    { Id: 'plain-folder', Name: '按目录整理的库', Type: 'Folder', IsFolder: true, ImageTags: {} },
  ],
  'plain-folder': [
    { Id: 'plain-child-1', Name: '子项一', Type: 'Movie', ImageTags: { Primary: 'tag-pc1' }, PrimaryImageAspectRatio: 0.66 },
    { Id: 'plain-child-2', Name: '子项二', Type: 'Movie', ImageTags: { Primary: 'tag-pc2' }, PrimaryImageAspectRatio: 1.78 },
  ],
};

/** Video/音频流。 */
function streamOf(entry) {
  const streams = [];
  if (entry.height) streams.push({ Index: 0, Type: 'Video', Codec: entry.videoCodec || 'h264', Height: entry.height });
  streams.push({ Index: 1, Type: 'Audio', Codec: entry.audioCodec || 'aac', Language: 'chi' });
  return streams;
}

/** itemId → PlaybackInfo 的 MediaSources。 */
const MEDIA_SOURCES = {
  m1: [
    {
      Id: 'ms-m1',
      // 1.25 GiB：版本标签要出现 1.3GB（JS toFixed 的进位规则）
      Size: 1342177280,
      Container: 'mkv',
      Path: '/media/电影/沙丘 2021.mkv',
      MediaStreams: streamOf({ height: 1080 }),
    },
  ],
  m2: [
    {
      Id: 'ms-m2-hd',
      Size: 1342177280,
      Container: 'mkv',
      Path: '/media/电影/m2-1080p.mkv',
      Name: 'Remux',
      MediaStreams: streamOf({ height: 1080 }),
    },
    {
      Id: 'ms-m2-4k',
      Size: 6111111111,
      Container: 'mkv',
      Path: '/media/电影/m2-2160p.mkv',
      MediaStreams: streamOf({ height: 2160, audioCodec: 'flac' }),
    },
  ],
  m3: [
    {
      Id: 'ms-m3',
      Size: 1234567,
      Container: 'mkv',
      Path: '/media/电影/m3.mkv',
      // DTS 音轨：浏览器解不了，必须转码（format=hls、at=1）
      MediaStreams: streamOf({ height: 1080, audioCodec: 'dts' }),
    },
  ],
  m4: [
    {
      // 完全没有 Path：title/format 的兜底分支
      Id: 'ms-m4',
      Container: 'mp4',
      MediaStreams: streamOf({ height: 720 }),
    },
  ],
  'm-empty': [],
};

const IMAGES = {
  'tag-m1': 'PNG-m1',
  'tag-m2': 'PNG-m2',
  'tag-m4': 'PNG-m4',
  'tag-s1': 'PNG-s1',
  'tag-pc1': 'PNG-pc1',
  'tag-pc2': 'PNG-pc2',
};

/** 条目 id → 主海报 tag（图片端点按 itemId 直接取，无需先查列表）。 */
const ITEM_TAGS = {
  m1: 'tag-m1',
  m2: 'tag-m2',
  m4: 'tag-m4',
  s1: 'tag-s1',
  'plain-child-1': 'tag-pc1',
  'plain-child-2': 'tag-pc2',
  'plain-folder': null, // 故意没有海报 → 触发后代回退
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

/** 解析 token → 会话；无效返回 null。 */
function sessionOf(req, url) {
  const token = req.headers['x-emby-token'] || url.searchParams.get('api_key') || '';
  if (!token) return null;
  if (API_KEYS[token]) {
    return { token, userId: API_KEYS[token].id, name: API_KEYS[token].name, meBroken: API_KEYS[token].meBroken };
  }
  const session = sessions.get(token);
  if (!session) return null;
  return { token, ...session };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;
  requests.push({ method: req.method, url: req.url });

  // ---- 对拍控制面 ----
  if (pathname === '/__invalidate' && req.method === 'POST') {
    const count = sessions.size;
    sessions.clear();
    // 计数器一并归零：两侧是先后跑同一条序列的，令牌里带绝对计数会让
    // 「第一轮登录的令牌」在两侧取到不同值（1 vs 3），比对的就不是行为了。
    loginCounter = 0;
    json(res, 200, { ok: true, cleared: count });
    return;
  }
  if (pathname === '/__stats') {
    json(res, 200, { requests: requests.length, sessions: sessions.size });
    return;
  }

  // ---- 登录 ----
  if (pathname === '/emby/Users/authenticatebyname' && req.method === 'POST') {
    const clientHeader = req.headers['x-emby-authorization'] || '';
    if (!/^MediaBrowser\s+Client="/.test(clientHeader)) {
      json(res, 400, { Message: '缺少 X-Emby-Authorization 客户端标识' });
      return;
    }
    const body = await readBody(req);
    const username = String(body.Username ?? '');
    const password = String(body.Pw ?? '');
    const user = USERS[username];
    if (!user || user.password !== password) {
      json(res, 401, { Message: '用户名或密码错误' });
      return;
    }
    loginCounter += 1;
    const token = `tok-${username}-${loginCounter}`;
    sessions.set(token, { userId: user.id, name: user.name, meBroken: user.meBroken });
    json(res, 200, {
      AccessToken: token,
      ServerId: SERVER_ID,
      User: { Id: user.id, Name: user.name, ServerId: SERVER_ID },
    });
    return;
  }

  // ---- 以下全部需要有效令牌 ----
  const session = sessionOf(req, url);
  if (!session) {
    json(res, 401, { Message: 'Invalid token' });
    return;
  }

  if (pathname === '/emby/Users/Me') {
    if (session.meBroken) {
      json(res, 500, { Message: '/Users/Me 不可用' });
      return;
    }
    json(res, 200, { Id: session.userId, Name: session.name, ServerId: SERVER_ID });
    return;
  }

  if (pathname === '/emby/Users') {
    json(res, 200, [
      { Id: 'user-other', Name: '普通用户', ServerId: SERVER_ID, Policy: { IsAdministrator: false } },
      { Id: 'user-admin', Name: '管理员', ServerId: SERVER_ID, Policy: { IsAdministrator: true } },
      { Id: 'user-api', Name: 'API 用户', ServerId: SERVER_ID, Policy: { IsAdministrator: false } },
    ]);
    return;
  }

  let match = /^\/emby\/Users\/([^/]+)\/Views$/.exec(pathname);
  if (match) {
    json(res, 200, { Items: VIEWS });
    return;
  }

  match = /^\/emby\/Users\/([^/]+)\/Items$/.exec(pathname);
  if (match) {
    const parentId = url.searchParams.get('ParentId') || '';
    const term = url.searchParams.get('SearchTerm');
    const recursive = url.searchParams.get('Recursive') === 'true';
    if (term !== null) {
      const hits = [];
      for (const list of Object.values(CHILDREN)) {
        for (const item of list) {
          if (String(item.Name).includes(term)) hits.push(item);
        }
      }
      json(res, 200, { Items: hits, TotalRecordCount: hits.length });
      return;
    }
    if (recursive) {
      // 海报回退：递归取后代（这里只下探一层，够用）
      const direct = CHILDREN[parentId] || [];
      const nested = [];
      for (const item of direct) {
        if (CHILDREN[item.Id]) nested.push(...CHILDREN[item.Id]);
      }
      json(res, 200, { Items: [...direct, ...nested] });
      return;
    }
    json(res, 200, { Items: CHILDREN[parentId] || [] });
    return;
  }

  match = /^\/emby\/Items\/([^/]+)\/Images\/Primary$/.exec(pathname);
  if (match) {
    const itemId = decodeURIComponent(match[1]);
    const tag = url.searchParams.get('tag') || ITEM_TAGS[itemId] || '';
    const payload = IMAGES[tag];
    if (!payload) {
      json(res, 404, { Message: 'Not found' });
      return;
    }
    const body = Buffer.from(payload);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length });
    res.end(body);
    return;
  }

  match = /^\/emby\/Items\/([^/]+)\/PlaybackInfo$/.exec(pathname);
  if (match) {
    const itemId = decodeURIComponent(match[1]);
    if (!(itemId in MEDIA_SOURCES)) {
      json(res, 404, { Message: 'Item not found' });
      return;
    }
    json(res, 200, { MediaSources: MEDIA_SOURCES[itemId] });
    return;
  }

  // 转码播放列表：分片与密钥都带 api_key，用于验证改写确实抹掉了令牌
  match = /^\/emby\/Videos\/([^/]+)\/main\.m3u8$/.exec(pathname);
  if (match) {
    const itemId = decodeURIComponent(match[1]);
    const body = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:0',
      `#EXT-X-KEY:METHOD=AES-128,URI="hls1/key.bin?api_key=${session.token}"`,
      '#EXTINF:6.000000,',
      `hls1/main/0.ts?api_key=${session.token}`,
      '#EXTINF:6.000000,',
      `/emby/Videos/${itemId}/hls1/main/1.ts?api_key=${session.token}`,
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }

  // 静态视频流：按字节生成确定性内容，支持 Range
  match = /^\/emby\/Videos\/([^/]+)\/stream$/.exec(pathname);
  if (match) {
    const itemId = decodeURIComponent(match[1]);
    const body = Buffer.alloc(256);
    for (let i = 0; i < body.length; i++) body[i] = (itemId.charCodeAt(0) + i) & 0xff;
    const range = req.headers.range;
    if (!range) {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': body.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(body);
      return;
    }
    const parsed = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = parsed && parsed[1] ? Number(parsed[1]) : 0;
    let end = parsed && parsed[2] ? Number(parsed[2]) : body.length - 1;
    if (start >= body.length) {
      res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
      res.end();
      return;
    }
    end = Math.min(end, body.length - 1);
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': slice.length,
      'Content-Range': `bytes ${start}-${end}/${body.length}`,
      'Accept-Ranges': 'bytes',
    });
    res.end(slice);
    return;
  }

  // HLS 分片 / 密钥（改写后的代理地址会指回来）
  match = /^\/emby\/Videos\/([^/]+)\/hls1\/(.+)$/.exec(pathname);
  if (match) {
    const body = Buffer.from('SEG-' + decodeURIComponent(match[2]));
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
    res.end(body);
    return;
  }

  // 字幕
  match = /^\/emby\/Videos\/([^/]+)\/([^/]+)\/Subtitles\/(\d+)\/Stream(\.\w+)?$/.exec(pathname);
  if (match) {
    const body = `1\n00:00:01,000 --> 00:00:02,000\n字幕${match[3]}\n`;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  json(res, 404, { Message: 'Not found: ' + pathname });
});

server.listen(port, '127.0.0.1', () => {
  process.stderr.write(`[mock-emby] listening on ${port}\n`);
});
