#!/usr/bin/env node
/**
 * Kazumi 对拍用的假站（规则 JSON + 抓站页面 + API 接口）。
 *
 *   /rules/index.json        规则索引（含非法名 / 坏规则，用来验过滤与下标推进）
 *   /rules/alpha.json        XPath 规则（搜索 + 选集都抓页面）
 *   /rules/beta.json         API 规则（搜索 + 选集都走 JSON，nested 格式）
 *   /rules/gamma.json        API 规则（搜索走 JSON + 选集走 delimited 分隔串）
 *   /rules/broken.json       缺 searchURL 的坏规则（应被跳过）
 *   /rules/delta.json        与 alpha 同构（证明坏规则不会让下标塌陷）
 *   /site/search?wd=...      搜索结果页（有重复项、有没链接的项、有懒加载封面）
 *   /detail/1、/detail/2     详情页（两条线路，6 集覆盖 5 种播放页形态）
 *   /play/direct             页面里直接写着 m3u8
 *   /play/player             player_aaaa encrypt=1（base64）
 *   /play/player2            player_aaaa encrypt=2（%u 转义）
 *   /play/iframe             iframe 嵌套普通播放器
 *   /play/hhjx               iframe + HHJX bootstrap（POST /api/parse 换地址）
 *   /play/youku              bootstrap 返回 ext=youku（后端拿不到 → 404）
 *   /api/search              POST JSON 搜索
 *   /api/detail?id=...       章节 JSON（nested）
 *   /api/delimited           POST 表单章节（delimited）
 *   /api/parse               HHJX 换地址接口
 *   /e1、/e2、/e3、/play/api/*  直链页（给 API 选集后的 resolve 用）
 *
 * 用法：node mock-kazumi.js [port]   → 打印实际端口
 */
'use strict';

const http = require('node:http');

const port = Number(process.argv[2]) || 0;
const CDN = 'https://cdn.example.com';

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const base = `http://${req.headers.host}`;
  let rawBody = '';
  req.on('data', (chunk) => {
    rawBody += chunk;
  });
  req.on('end', () => route(url, rawBody));

  function html(body) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  }
  function json(body) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }
  function rule(body) {
    json(body);
  }

  // ---- 规则文件 -----------------------------------------------------------
  const searchPageURL = `${base}/site/search?wd=@keyword`;
  const xpathRule = (name) => ({
    api: '9',
    type: 'anime',
    name,
    version: '1.0',
    useWebview: false,
    useNativePlayer: true,
    userAgent: '',
    baseURL: `${base}/`,
    searchURL: searchPageURL,
    searchList: "//div[@class='item']",
    searchName: './/h3/a',
    searchResult: './/a',
    chapterRoads: "//ul[@class='road']",
    chapterResult: ".//li/a[contains(@href,'/play/')]",
    searchMode: 'xpath',
    chapterMode: 'xpath',
    referer: `${base}/`,
  });

  const searchApiConfig = {
    request: {
      method: 'POST',
      url: `${base}/api/search`,
      headers: { 'X-Rule': 'beta', 'Content-Type': 'application/json' },
      bodyType: 'json',
      body: { wd: '@keyword', page: 1, enabled: true },
    },
    listPath: '$.data.list[*]',
    namePath: '$.title',
    sourcePath: '$.id',
  };

  // ---- 路由 ---------------------------------------------------------------
  function route(url, rawBody) {
    const path = url.pathname;

    if (path === '/rules/index.json') {
      return rule([
        { name: 'alpha', version: '1.0' },
        { name: 'beta', version: '1.0' },
        { name: 'gamma', version: '1.0' },
        { name: 'bad name!' },
        { name: 'broken', version: '1.0' },
        { name: 'delta', version: '1.0' },
      ]);
    }
    if (path === '/rules/alpha.json') return rule(xpathRule('alpha'));
    if (path === '/rules/delta.json') return rule(xpathRule('delta'));
    if (path === '/rules/broken.json') {
      // 缺 searchURL 又没有 api 搜索配置 → 两侧都该跳过它。
      return rule({ name: 'broken', baseURL: `${base}/` });
    }
    if (path === '/rules/beta.json') {
      return rule({
        api: '9',
        type: 'anime',
        name: 'beta',
        useWebview: false,
        userAgent: 'MockAgent/1.0',
        baseURL: `${base}/`,
        searchURL: '',
        searchMode: 'api',
        chapterMode: 'api',
        referer: `${base}/`,
        searchApiConfig,
        chapterApiConfig: {
          request: {
            method: 'GET',
            url: `${base}/api/detail`,
            query: { id: '@source' },
          },
          format: 'nested',
          roadsPath: '$.roads[*]',
          roadNamePath: '$.name',
          episodesPath: '$.eps[*]',
          episodeNamePath: '$.label',
          episodeUrlPath: '$.id',
          variables: { token: '$.token' },
          episodePage: {
            url: `${base}/play/api/@episodeUrl`,
            query: { t: '@token' },
          },
        },
      });
    }
    if (path === '/rules/gamma.json') {
      return rule({
        api: '9',
        type: 'anime',
        name: 'gamma',
        baseURL: `${base}/`,
        searchURL: '',
        searchMode: 'api',
        chapterMode: 'api',
        searchApiConfig,
        chapterApiConfig: {
          request: {
            method: 'POST',
            url: `${base}/api/delimited`,
            bodyType: 'form',
            body: { id: '@source', fmt: 'delimited' },
          },
          format: 'delimited',
          roadNamesPath: '$.from',
          roadEpisodesPath: '$.url',
          roadSeparator: '$$$',
          episodeSeparator: '#',
          fieldSeparator: '$',
        },
      });
    }

    // ---- 抓站页面 ---------------------------------------------------------
    if (path === '/site/search') {
      const keyword = url.searchParams.get('wd') || '';
      return html(`<html><body>
<h1>搜索 ${keyword}</h1>
<div class="item">
  <a href="/detail/1"><img src="/img/placeholder.png" data-src="/img/1.jpg"></a>
  <h3><a href="/detail/1">番剧一</a></h3>
</div>
<div class="item">
  <a href="/detail/2"><img data-original="/img/2.jpg"></a>
  <h3><a href="/detail/2">番剧二</a></h3>
</div>
<div class="item">
  <a href="/detail/1"><img data-src="/img/1-duplicate.jpg"></a>
  <h3><a href="/detail/1">重复的番剧一</a></h3>
</div>
<div class="item">
  <h3><a>没有链接</a></h3>
</div>
<div class="item">
  <!-- 注释节点也要算进 textContent -->
  <h3><a href="/detail/3"><!-- 注解 -->番剧三</a></h3>
  <a href="/detail/3"><img data-bg="/img/3.jpg"></a>
</div>
</body></html>`);
    }

    if (path === '/detail/1' || path === '/detail/2') {
      return html(`<html><body>
<ul class="road">
  <li><a href="/play/direct">第1集</a></li>
  <li><a href="/play/player">第2集</a></li>
  <li><a href="/play/player2">EP3</a></li>
</ul>
<ul class="road">
  <li><a href="/play/iframe">第4集</a></li>
  <li><a href="/play/hhjx">第5集</a></li>
  <li><a href="/play/youku">第6集</a></li>
  <li><span>不是链接</span></li>
</ul>
</body></html>`);
    }

    if (path === '/play/direct') {
      return html(`<html><body><video src="${CDN}/direct.m3u8?token=1"></video></body></html>`);
    }
    if (path === '/play/player') {
      const encoded = Buffer.from(`${CDN}/player.m3u8`).toString('base64');
      return html(`<html><body><script>var player_aaaa={"url":"${encoded}","encrypt":1}</script></body></html>`);
    }
    if (path === '/play/player2') {
      // %u002E 解出来是 "."，所以页面里不会出现字面量 .m3u8
      const encoded = Buffer.from(`${CDN}/player2%u002Em3u8`).toString('base64');
      return html(`<html><body><script>var player_aaaa={"url":"${encoded}","encrypt":2}</script></body></html>`);
    }
    if (path === '/play/iframe') {
      return html(`<html><body><iframe src="/frame/normal"></iframe></body></html>`);
    }
    if (path === '/frame/normal') {
      return html(`<html><body><video src="${CDN}/frame.mp4"></video></body></html>`);
    }
    if (path === '/play/hhjx' || path === '/play/youku') {
      const frame = path === '/play/hhjx' ? '/frame/hhjx' : '/frame/youku';
      return html(`<html><body><iframe src="${frame}"></iframe></body></html>`);
    }
    if (path === '/frame/hhjx') {
      return html(
        `<html><body><script>window.__HHJX_BOOTSTRAP__ = {"url":"https://v.example/hhjx","t":1730000000,"key":"k1"};</script></body></html>`,
      );
    }
    if (path === '/frame/youku') {
      return html(
        `<html><body><script>window.__HHJX_BOOTSTRAP__ = {"url":"https://v.example/youku","t":1730000001,"key":"k2","act":99};</script></body></html>`,
      );
    }
    if (path === '/api/parse') {
      let payload = {};
      try {
        payload = JSON.parse(rawBody || '{}');
      } catch {
        payload = {};
      }
      if (payload.url === 'https://v.example/youku') {
        return json({ code: 200, url: `${CDN}/youku.m3u8`, ext: 'youku' });
      }
      return json({ code: 200, url: `${CDN}/hhjx.m3u8`, ext: 'mp4' });
    }

    // ---- API 规则接口 -----------------------------------------------------
    if (path === '/api/search') {
      let payload = {};
      try {
        payload = JSON.parse(rawBody || '{}');
      } catch {
        payload = {};
      }
      // 回显请求体，验证模板渲染（@keyword 替换、数字/布尔值的 String 语义）。
      return json({
        echo: payload,
        data: {
          list: [
            { id: 11, title: `接口一:${payload.wd}` },
            { id: 12, title: '接口二' },
            { id: 11, title: '接口一重复' },
            { title: '没有 id' },
          ],
        },
      });
    }
    if (path === '/api/detail') {
      // @source 是完整详情地址（URL 编码后进 query），这里还原成裸 id。
      const identifier = url.searchParams.get('id') || '';
      const id = identifier.replace(/^https?:\/\/[^/]+\//, '');
      return json({
        token: `tk-${id}`,
        roads: [
          {
            name: '线路A',
            eps: [
              { label: '第1集', id: 'e1' },
              { label: '第2集', id: 'e2' },
            ],
          },
          { name: '', eps: [{ label: 'OVA', id: 'e3' }] },
          { name: '空线路', eps: [] },
        ],
      });
    }
    if (path === '/api/delimited') {
      return json({
        from: '线路甲$$$线路乙',
        url: '第1集$e1#第2集$e2$$$第3集$e3#坏的没有分隔符',
      });
    }

    // ---- 直链页 -----------------------------------------------------------
    if (path === '/e1' || path === '/e2' || path === '/e3') {
      return html(`<html><body><video src="${CDN}${path}.m3u8"></video></body></html>`);
    }
    if (path.startsWith('/play/api/')) {
      return html(`<html><body><video src="${CDN}${path}.m3u8"></video></body></html>`);
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(server.address().port);
});
