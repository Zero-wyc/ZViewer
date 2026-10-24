#!/usr/bin/env node
/**
 * CMS 采集源对拍用的假上游（苹果 CMS + TVBox 配置）。
 *
 * 同时扮演两个角色：
 *   1. TVBox 配置站：/tvbox.json、/redirect.json、/gbk.json（GBK 编码，验 charset 嗅探）
 *   2. 采集站：/cmsA/api.php/provide/vod、/cmsB/api.php/provide/vod
 *
 * 数据全部固定（播放地址用 cdn.example.com），这样 Node 与 Go 两侧拿到的
 * 响应逐字节可比——CMS 的「解析」是纯函数式的（拼 URL + 解析 vod_play_url），
 * 对拍能覆盖到真实分支。
 *
 * 用法：node mock-cms.js [port]   → 打印实际端口
 */
'use strict';

const http = require('node:http');
const iconv = require('iconv-lite');

const port = Number(process.argv[2]) || 0;

// 播放地址刻意用固定域名：换成 mock 自己的地址会让响应体带上随机端口，
// 两侧虽然同端口可比，但产物不可读、也不方便人工核对。
const CDN = 'https://cdn.example.com';

function vodListHandler(req, res, { site }) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const ac = url.searchParams.get('ac');

  // siteB 模拟「只认 ac=detail」的老站：videolist 返回空列表。
  if (site === 'siteB' && ac !== 'detail') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, list: [] }));
    return;
  }

  const ids = url.searchParams.get('ids');
  if (ids) {
    if (ids !== '1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, list: [] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 0,
        list: [
          {
            vod_id: '1',
            vod_name: '演示影片',
            vod_pic: 'https://img.example.com/1.jpg',
            vod_year: '2024',
            vod_area: '日本',
            type_name: '动画',
            vod_content: '这是一部演示影片',
            vod_remarks: '更新至第2集',
            vod_play_from: '线路一$$$线路二',
            vod_play_url:
              `第1集$${CDN}/a-1.m3u8#第2集$${CDN}/a-2.m3u8` +
              `$$$第1集$${CDN}/b-1.mp4#第2集$${CDN}/b-2.mkv`,
          },
        ],
      }),
    );
    return;
  }

  if (site === 'siteA') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        code: 0,
        list: [
          { vod_id: '1', vod_name: '演示影片', vod_pic: '', vod_remarks: '' },
          {
            vod_id: '3',
            vod_name: '另一部',
            vod_pic: 'https://img.example.com/3.jpg',
            vod_remarks: 'HD',
          },
        ],
      }),
    );
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      code: 0,
      list: [
        {
          vod_id: '2',
          vod_name: '演示影片！',
          vod_pic: 'https://img.example.com/2.jpg',
          vod_remarks: '更新至第3集',
        },
        { vod_id: '4', vod_name: '第三部' },
      ],
    }),
  );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const origin = `http://127.0.0.1:${server.address().port}`;

  if (url.pathname === '/tvbox.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        sites: [
          {
            key: 'siteA',
            name: '站点A',
            type: 1,
            api: `${origin}/cmsA/api.php/provide/vod`,
          },
          {
            key: 'siteB',
            name: '站点B',
            type: 1,
            api: `${origin}/cmsB/api.php/provide/vod`,
            searchable: 0,
          },
          {
            key: 'tvboxOnly',
            name: '非采集站',
            type: 0,
            api: 'https://example.com/api.php/provide/vod',
          },
        ],
      }),
    );
    return;
  }

  if (url.pathname === '/redirect.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        urls: [{ url: '/tvbox.json', name: '真实配置（相对地址）' }],
      }),
    );
    return;
  }

  // GBK 编码且不声明 charset：两侧的 decodeBody 都必须嗅探出 GB18030。
  if (url.pathname === '/gbk.json') {
    const body = iconv.encode(
      JSON.stringify({
        sites: [
          {
            key: 'gbkSite',
            name: '高清影视',
            type: 1,
            api: `${origin}/cmsA/api.php/provide/vod`,
          },
        ],
      }),
      'gbk',
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(body);
    return;
  }

  if (url.pathname === '/cmsA/api.php/provide/vod') {
    vodListHandler(req, res, { site: 'siteA' });
    return;
  }

  if (url.pathname === '/cmsB/api.php/provide/vod') {
    vodListHandler(req, res, { site: 'siteB' });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: -404, message: 'not found' }));
});

server.listen(port, '127.0.0.1', () => {
  // 只打印端口：启动脚本要拿它去种库并对齐两侧配置。
  process.stdout.write(`${server.address().port}\n`);
});
