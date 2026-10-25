#!/usr/bin/env node
/**
 * 用 Node 实现生成弹幕源的期望输出（Go 侧单测的基准）。
 *
 * 弹幕源的上游地址是硬编码的（ani.gamer.com.tw / api.dandanplay.net），没法
 * 像其它模块那样起一个假站来对拍。这里换个办法：把 global fetch 换掉，按
 * 「host + path」返回 testdata 里的夹具，然后直接调 Node 的 provider ——
 * 得到的就是 Node 实现解析同一份 HTML/JSON 的真实输出。
 *
 * 夹具与期望值都提交进仓库，Go 侧测试读同一份夹具比对，效果等价于对拍。
 *
 * 用法：node backend-go/scripts/gen-danmaku-fixtures.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const TESTDATA = path.join(ROOT, 'backend-go', 'internal', 'danmaku', 'testdata');

function fixture(name) {
  return fs.readFileSync(path.join(TESTDATA, name), 'utf8');
}

/** 每个用例：URL 形状 -> 夹具文件。查询串一律忽略。 */
const CASES = {
  'bahamut-search': {
    routes: {
      'ani.gamer.com.tw/search.php': 'bahamut-search.html',
    },
    async run(providers) {
      return providers.bahamut.search('孤獨搖滾');
    },
  },
  'bahamut-episodes': {
    routes: {
      'ani.gamer.com.tw/animeRef.php': 'bahamut-animeRef.html',
    },
    async run(providers) {
      return providers.bahamut.getEpisodes('1234');
    },
  },
  'bahamut-episodes-single': {
    routes: {
      'ani.gamer.com.tw/animeRef.php': 'bahamut-single.html',
    },
    async run(providers) {
      return providers.bahamut.getEpisodes('sn=7777');
    },
  },
  'bahamut-danmaku': {
    routes: {
      'ani.gamer.com.tw/ajax/danmuGet.php': 'bahamut-danmu.json',
    },
    async run(providers) {
      return providers.bahamut.getDanmaku({
        id: '1',
        title: '第 1 集',
        episodeNumber: 1,
        playbackParams: { sn: '1234' },
      });
    },
  },
  'bahamut-danmaku-wrapped': {
    routes: {
      'ani.gamer.com.tw/ajax/danmuGet.php': 'bahamut-danmu-wrapped.json',
    },
    async run(providers) {
      return providers.bahamut.getDanmaku({
        id: '1',
        title: '第 1 集',
        episodeNumber: 1,
        playbackParams: { sn: '5678' },
      });
    },
  },
  'dandanplay-search': {
    routes: {
      'api.dandanplay.net/api/v2/search/anime': 'dandanplay-search.json',
    },
    async run(providers) {
      return providers.dandanplay.search('孤獨搖滾');
    },
  },
  'dandanplay-episodes': {
    routes: {
      'api.dandanplay.net/api/v2/bangumi/11': 'dandanplay-bangumi.json',
    },
    async run(providers) {
      return providers.dandanplay.getEpisodes('11');
    },
  },
  'dandanplay-episodes-empty': {
    routes: {
      'api.dandanplay.net/api/v2/bangumi/12': 'dandanplay-bangumi-empty.json',
    },
    async run(providers) {
      return providers.dandanplay.getEpisodes('12');
    },
  },
  'dandanplay-danmaku': {
    routes: {
      'api.dandanplay.net/api/v2/comment/101': 'dandanplay-comment.json',
    },
    async run(providers) {
      return providers.dandanplay.getDanmaku({
        id: '11-101',
        title: '孤獨搖滾！ - 第1集',
        episodeNumber: 1,
        playbackParams: { animeId: 11, episodeId: 101 },
      });
    },
  },
};

// ---- fetch 替换 ------------------------------------------------------------
let activeRoutes = {};

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input.url;
  const url = new URL(raw);
  const key = `${url.host}${url.pathname}`;
  const file = activeRoutes[key];
  if (!file) {
    throw new Error(`未登记的请求: ${key}`);
  }
  const body = fixture(file);
  const contentType = file.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : 'application/json; charset=utf-8';
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
};

async function main() {
  // ts-node 注册后才能 require TS 源码。
  const { bahamutDanmakuProvider } = require(path.join(
    ROOT, 'backend', 'src', 'services', 'danmaku', 'providers', 'bahamut',
  ));
  const { dandanplayDanmakuProvider } = require(path.join(
    ROOT, 'backend', 'src', 'services', 'danmaku', 'providers', 'dandanplay',
  ));
  const providers = { bahamut: bahamutDanmakuProvider, dandanplay: dandanplayDanmakuProvider };

  const output = {};
  for (const [name, testCase] of Object.entries(CASES)) {
    activeRoutes = testCase.routes;
    try {
      output[name] = { ok: await testCase.run(providers) };
    } catch (err) {
      output[name] = { error: String((err && err.message) || err) };
    }
  }

  const target = path.join(TESTDATA, 'expected.json');
  fs.writeFileSync(target, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`已写入 ${path.relative(ROOT, target)}`);
  for (const [name, value] of Object.entries(output)) {
    const summary = value.error ? `错误: ${value.error}` : `${Array.isArray(value.ok) ? value.ok.length : '?'} 条`;
    console.log(`  ${name}: ${summary}`);
  }
  globalThis.fetch = realFetch;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
