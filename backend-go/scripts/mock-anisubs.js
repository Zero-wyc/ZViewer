#!/usr/bin/env node
/**
 * ani-subs 对拍用的假站（订阅 JSON + 抓站页面 + RSS）。
 *
 *   /sub.json              订阅：web-selector × 2 + rss × 1
 *   /search?wd=...         列表页（a 格式，封面在兄弟节点）
 *   /api/search?q=...      JSON 接口（json-path-indexed 格式）
 *   /s/1                   详情页（分集链接）
 *   /p/1、/p/2             剧集页（1 有 m3u8，2 没有）
 *   /feed.xml              RSS
 *
 * 搜索页会把**原始查询串**回显进标题，用来锁 URL 编码（%20 vs +）。
 *
 * 用法：node mock-anisubs.js [port]   → 打印实际端口
 */
'use strict';

const http = require('node:http');

const port = Number(process.argv[2]) || 0;

const CDN = 'https://cdn.example.com';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const html = (body) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  };
  const json = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const base = `http://${req.headers.host}`;

  if (url.pathname === '/sub.json') {
    json({
      exportedMediaSourceDataList: {
        mediaSources: [
          {
            factoryId: 'web-selector',
            version: 2,
            arguments: {
              name: '假站甲',
              searchConfig: {
                searchUrl: `${base}/search?wd={keyword}`,
                searchRemoveSpecial: true,
                subjectFormatId: 'a',
                selectorSubjectFormatA: { selectLists: 'div.item > a', preferShorterName: true },
                channelFormatId: 'no-channel',
                selectorChannelFormatNoChannel: {
                  selectEpisodes: '.ep a',
                  matchEpisodeSortFromName: '第\\s*(?<ep>\\d+)\\s*集',
                },
                matchVideo: {
                  enableNestedUrl: true,
                  matchNestedUrl: 'https://player\\.example\\.com/.*',
                  matchVideoUrl:
                    '(^http(s)?:\\/\\/(?!.*http).+\\.(mp4|m3u8|flv))|(url=(?<v>http(s)?:\\/\\/.+\\.(mp4|m3u8|flv)))',
                  addHeadersToVideo: { origin: 'https://up.example' },
                },
              },
            },
          },
          {
            factoryId: 'web-selector',
            version: 2,
            arguments: {
              name: '假站乙',
              searchConfig: {
                searchUrl: `${base}/api/search?q={keyword}`,
                subjectFormatId: 'json-path-indexed',
                selectorSubjectFormatJsonPathIndexed: {
                  selectNames: '$.data.videos[*].name',
                  selectLinks: '$.data.videos[*].slug',
                  selectCovers: '$.data.videos[*].pic',
                },
                channelFormatId: 'index-grouped',
                selectorChannelFormatFlattened: {
                  selectChannelNames: '.tabs a',
                  matchChannelName: '^(?<ch>线路.+?)(\\d+)?$',
                  selectEpisodeLists: '.list',
                  selectEpisodesFromList: 'a',
                  matchEpisodeSortFromName: '第\\s*(?<ep>\\d+)\\s*集',
                },
                matchVideo: { matchVideoUrl: '(?<v>https://cdn\\.example\\.com/[^"]+\\.m3u8)' },
              },
            },
          },
          {
            factoryId: 'rss',
            version: 1,
            arguments: {
              name: '假RSS',
              searchConfig: { searchUrl: `${base}/feed.xml?q={keyword}` },
            },
          },
        ],
      },
    });
    return;
  }

  if (url.pathname === '/search') {
    html(`<html><body>
<div class="item"><a href="/s/1">搜索结果:${url.searchParams.get('wd') || ''}|raw:${url.search}</a><img data-src="${CDN}/1.jpg"></div>
<div class="item"><a href="/s/1">重复条目</a></div>
<div class="item"><a href="/s/9"></a></div>
</body></html>`);
    return;
  }

  if (url.pathname === '/api/search') {
    json({
      code: 0,
      data: {
        videos: [
          { slug: '/s/2', name: `接口命中:${url.searchParams.get('q') || ''}|raw:${url.search}`, pic: CDN + '/2.jpg' },
          { slug: '/s/3', name: '第二部' },
        ],
      },
    });
    return;
  }

  if (url.pathname === '/s/1') {
    html(`<div class="ep"><a href="/p/1">第 1 集</a><a href="/p/2">第 2 集</a><a href="/p/3">OVA</a></div>`);
    return;
  }

  if (url.pathname === '/s/2') {
    html(`<div class="tabs"><a>线路1</a><a>预告</a></div>
<div class="list"><a href="/p/1">第 1 集</a></div>
<div class="list"><a href="/p/2">第 2 集</a></div>`);
    return;
  }

  if (url.pathname === '/p/1') {
    html(`<script>const u = "url=${CDN}/1.m3u8";</script>`);
    return;
  }
  if (url.pathname === '/p/2') {
    // 配了嵌套规则但页面里既没有直链也没有嵌套地址 → 解析不到。
    html(`<html>nothing here</html>`);
    return;
  }

  if (url.pathname === '/feed.xml') {
    res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[<b>孤独摇滚</b> 第1话]]></title>
    <link>https://example.com/ep/1</link>
    <description><![CDATA[<p>波奇酱 &amp; 朋友们</p>]]></description>
    <enclosure url="${CDN}/1.mp4"/>
  </item>
  <item>
    <title>只有附件</title>
    <enclosure url="${CDN}/2.mp4"/>
  </item>
</channel></rss>`);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(server.address().port);
});
