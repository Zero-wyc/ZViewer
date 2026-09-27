const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createKazumiProvider } = require('../dist/services/kazumi/provider');
const kazumi = require('../dist/services/kazumi/scraper');
const anisubs = require('../dist/services/anisubs/scraper');
const { buildProvidersFromRules } = require('../dist/services/kazumi/ruleLoader');

const rule = {
  name: 'Fixture',
  baseURL: 'https://anime.example/',
  searchURL: 'https://anime.example/search?q=@keyword',
  searchList: '//li',
  searchName: '//a',
  searchResult: '//a',
  chapterRoads: '//ul',
  chapterResult: '//a',
};

function mockFetch(t, handler) {
  const original = global.fetch;
  global.fetch = async (url, options) => {
    const body = handler(String(url), options);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body));
  };
  t.after(() => { global.fetch = original; });
}

test('Kazumi parses HTML declarations and preserves escaped text/attributes', () => {
  const doc = kazumi.parseHtmlDocument(
    '<!DOCTYPE html><html><body><a href="/show?a=1&amp;b=2">A &amp; B</a></body></html>',
  );
  const node = kazumi.selectXPath(doc, '//a')[0];
  assert.equal(kazumi.extractText(node), 'A & B');
  assert.equal(kazumi.extractAttr(node, 'href'), '/show?a=1&b=2');
  assert.equal(kazumi.toRelativeXPath('//a'), './/a');
  assert.equal(kazumi.toRelativeXPath('./a'), './a');
});

test('Kazumi search and chapter XPath stay scoped to each result/road', async (t) => {
  mockFetch(t, () => '<!DOCTYPE html><ul><li><a href="/a">First</a></li></ul>' +
    '<ul><li><a href="/b">Second</a></li></ul>');
  const provider = createKazumiProvider('fixture', rule);
  assert.deepEqual((await provider.search('example')).map(x => [x.title, x.id]), [
    ['First', 'https://anime.example/a'], ['Second', 'https://anime.example/b'],
  ]);
  assert.deepEqual((await provider.getEpisodes(rule.baseURL)).map(x => x.playbackParams.episodeUrl), [
    'https://anime.example/a', 'https://anime.example/b',
  ]);
});

test('Kazumi recursively resolves iframe URLs relative to the containing player', async (t) => {
  mockFetch(t, url => {
    if (url.endsWith('/episode')) return '<iframe src="https://player.example/embed/start"></iframe>';
    if (url.endsWith('/embed/start')) return '<iframe src="next"></iframe>';
    assert.equal(url, 'https://player.example/embed/next');
    return '<video src="https://cdn.example/video.mp4"></video>';
  });
  assert.deepEqual(await kazumi.resolveVideoUrl('https://anime.example/episode', rule), {
    url: 'https://cdn.example/video.mp4', format: 'mp4',
  });
});

test('Kazumi resolves public bootstrap player API without executing page scripts', async (t) => {
  mockFetch(t, (url, options) => {
    if (url.endsWith('/episode')) return '<iframe src="https://player.example/embed"></iframe>';
    if (url.endsWith('/embed')) return '<script>window.__HHJX_BOOTSTRAP__ = {"url":"opaque","t":1,"key":"key","act":99};</script>';
    assert.equal(url, 'https://player.example/api/parse');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { url: 'opaque', t: 1, key: 'key', act: 99 });
    return { code: 200, url: 'https://cdn.example/video.m3u8' };
  });
  assert.equal((await kazumi.resolveVideoUrl('https://anime.example/episode', rule)).format, 'hls');
});

test('ani-subs trims greedy HTML captures, preserves encoded queries and explicit empty Referer', async (t) => {
  mockFetch(t, () => '<script>player={url:"https://cdn.example/v.mp4?sig=a%2Fb%26c&amp;x=1",next:0}</script>');
  const config = { matchVideoUrl: 'https://cdn\\.example/.*', addHeadersToVideo: { referer: '', userAgent: 'Fixture' } };
  const result = await anisubs.resolveVideoUrl('https://anime.example/play', config);
  assert.equal(result.url, 'https://cdn.example/v.mp4?sig=a%2Fb%26c&x=1');
  assert.equal(result.format, 'mp4');
  assert.deepEqual(result.headers, { 'User-Agent': 'Fixture' });
  delete config.addHeadersToVideo.referer;
  assert.equal((await anisubs.resolveVideoUrl('https://anime.example/play', config)).headers.Referer, 'https://anime.example/play');
});

test('KazumiRules repository and indexes expand and deduplicate rule URLs', async (t) => {
  const urls = [];
  mockFetch(t, url => {
    urls.push(url);
    return url.includes('index.json') ? [{ name: 'First' }, { name: 'Second' }, { name: '../invalid' }] :
      { ...rule, name: url.includes('First.json') ? 'First' : 'Second' };
  });
  const providers = await buildProvidersFromRules([
    'https://github.com/Predidit/KazumiRules.git/',
    'https://raw.githubusercontent.com/Predidit/KazumiRules/main/First.json',
  ]);
  assert.deepEqual(Object.values(providers).map(x => x.name), ['First', 'Second']);
  assert.equal(urls.filter(x => x.endsWith('Second.json')).length, 1);
  assert.ok(!urls.some(x => x.includes('invalid.json')));
});
