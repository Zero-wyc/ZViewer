#!/usr/bin/env node
/**
 * 动漫源对拍用的假上游（RSS / Atom 订阅 + 第三方 HTTP 源）。
 *
 * 三条轨道：
 *   /rss.xml             RSS 2.0（含 CDATA、HTML 标签、实体、只有 enclosure 的条目）
 *   /atom.xml            Atom（link 用属性，summary/published）
 *   /tp/*                第三方源：search 会把关键词回显进标题，
 *                        用来验证 {keyword} 插值与 URL 编码是否一致
 *
 * 数据全部固定，两侧拿到逐字节相同的响应；媒体地址统一用 cdn.example.com，
 * 免得产物里带上随机端口。
 *
 * 用法：node mock-anime.js [port]   → 打印实际端口
 */
'use strict';

const http = require('node:http');

const port = Number(process.argv[2]) || 0;

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>示例订阅</title>
    <item>
      <title><![CDATA[<b>孤独摇滚</b> 第1话]]></title>
      <link>https://example.com/ep/1</link>
      <description><![CDATA[<p>波奇酱 &amp; 朋友们</p>]]></description>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <enclosure url="https://cdn.example.com/1.mp4" type="video/mp4"/>
    </item>
    <item>
      <title>轻音少女 剧场版</title>
      <link>https://example.com/ep/2</link>
      <description>放学后的茶会</description>
      <enclosure url="https://cdn.example.com/2.mp4" type="video/mp4"/>
    </item>
    <item>
      <title>只有附件的条目</title>
      <enclosure url="https://cdn.example.com/3.mp4"/>
    </item>
    <item>
      <title>没有链接也没有附件</title>
      <description>该条目应被丢弃</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>示例 Atom 订阅</title>
  <entry>
    <title>孤独摇滚 &amp; 剧场版</title>
    <link rel="alternate" href="https://example.com/a/1"/>
    <summary>乐队日常</summary>
    <published>2024-01-01T00:00:00Z</published>
  </entry>
  <entry>
    <title>没有链接的条目</title>
    <summary>应被丢弃</summary>
  </entry>
</feed>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  switch (true) {
    case url.pathname === '/rss.xml':
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end(RSS);
      return;
    case url.pathname === '/atom.xml':
      res.writeHead(200, { 'Content-Type': 'application/atom+xml; charset=utf-8' });
      res.end(ATOM);
      return;
    case url.pathname === '/empty.xml':
      res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
      res.end('   ');
      return;

    // 第三方源：默认端点 = {baseUrl}/search、{baseUrl}/episodes/{id}、{baseUrl}/resolve/{id}
    case url.pathname === '/tp/search':
      json({
        code: 0,
        data: [
          {
            // 用 animeId 而不是 id，验证 id 回落链
            animeId: '7',
            // 回显**原始查询串**：+ 与 %20 的差异只有这里能看出来。
            name: `搜索结果:${url.searchParams.get('keyword') || ''}|raw:${url.search}`,
            cover: 'https://cdn.example.com/c.jpg',
            description: '描述文本',
            extra: { seasonId: 7 },
          },
          // seasonId 回落 + cover 为空串（该键应消失）
          { seasonId: '9', title: '第二部', cover: '' },
          // 缺 title → 整条丢弃
          { id: '11' },
        ],
      });
      return;
    case url.pathname === '/tp/episodes/7':
      json([
        { id: 'e1', title: '第一话', episodeNumber: 1, playbackParams: { ep: 'e1' } },
        { episodeNumber: '3' },
        {},
      ]);
      return;
    case url.pathname === '/tp/resolve/e1':
      json({
        // playUrl 而非 url，验证回落链
        playUrl: 'https://cdn.example.com/1.m3u8',
        headers: { Referer: 'https://up.example' },
      });
      return;
    case url.pathname === '/tp/resolve/bad':
      json({ url: '' });
      return;
    case url.pathname.startsWith('/tp/'):
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 502, message: '上游抽风' }));
      return;
    default:
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 404 }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(server.address().port);
});
