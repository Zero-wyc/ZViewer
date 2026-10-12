const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createKazumiProvider } = require('../dist/services/kazumi/provider');
const kazumi = require('../dist/services/kazumi/scraper');
const anisubs = require('../dist/services/anisubs/scraper');
const { buildProvidersFromRules } = require('../dist/services/kazumi/ruleLoader');
const { createWebSelectorProvider } = require('../dist/services/anisubs/provider');
const { createSearchPosterReader } = require('../dist/services/anime/searchMetadata');
const { defaultSourceOverride } = require('../dist/services/anisubs/defaultCompatibility');
const { buildProvidersFromSubscription } = require('../dist/services/anisubs/subscription');

test('Kazumi extracts data-bg posters, decodes queries and keeps titles scoped', async (t) => {
  mockFetch(t, () => '<ul><li><div><a href="/show/1" data-bg="//img.example/1.jpg?a=1&amp;b=2"></a><a href="/show/1">First</a></div></li><li><a href="/show/2">Second</a></li></ul>');
  const results = await createKazumiProvider('fixture', {...rule, searchName: '//a[last()]', searchResult: '//a[last()]'}).search('test');
  assert.equal(results[0].cover, 'https://img.example/1.jpg?a=1&b=2');
  assert.equal(results[1].cover, undefined);
});

test('ani-subs finds sibling lazy posters and resolves path-relative URLs', () => {
  const html = '<ul><li><a href="show/1"><img src="data:image/gif;base64,AA" data-original="../covers/1.jpg"></a><h3><a href="show/1">First</a></h3></li><li><h3><a href="show/2">Second</a></h3></li></ul>';
  const results = anisubs.parseSearchResults(html, {searchUrl:'', subjectFormatId:'a', selectorSubjectFormatA:{selectLists:'h3 a'}}, 'https://anime.example/catalog/search');
  assert.equal(results[0].url, 'https://anime.example/catalog/show/1');
  assert.equal(results[0].cover, 'https://anime.example/covers/1.jpg');
  assert.equal(results[1].cover, undefined);
  assert.equal(createSearchPosterReader('<a href="/1" data-bg="javascript:alert(1)">Bad</a>', 'https://anime.example/')('https://anime.example/1'), undefined);
});

test('JSON indexed subscriptions preserve missing-field positions and raw base URLs', () => {
  const results = anisubs.parseSearchResults(JSON.stringify({data:{videos:[{name:'One',slug:'one'}, {name:'Two',slug:'two',pic:'/two.jpg'}]}}), {
    searchUrl:'',rawBaseUrl:'https://anime.example/video/',subjectFormatId:'json-path-indexed',
    selectorSubjectFormatJsonPathIndexed:{selectNames:'$.data.videos[*].name',selectLinks:'$.data.videos[*].slug',selectCovers:'$.data.videos[*].pic'},
  },'https://anime.example/api/search');
  assert.equal(results[0].url, 'https://anime.example/video/one');
  assert.equal(results[0].cover, undefined);
  assert.equal(results[1].cover, 'https://anime.example/two.jpg');
});

test('ani-subs honours keyword normalisation and copies poster metadata to API results', async (t) => {
  mockFetch(t, url => {
    assert.equal(new URL(url).searchParams.get('q'), '辉夜');
    return '<a href="/show" data-bg="/poster.jpg">辉夜</a>';
  });
  const results = await createWebSelectorProvider('fixture','Fixture',{searchUrl:'https://anime.example/search?q={keyword}',searchRemoveSpecial:true,searchUseOnlyFirstWord:true,selectorSubjectFormatA:{selectLists:'a'}}).search('辉夜： 第一季');
  assert.equal(results[0].cover,'https://anime.example/poster.jpg');
});

test('episode selectors pointing to spans/buttons use the containing link', () => {
  const results = anisubs.parseEpisodes('<ul><li><a href="episode/1"><span>第1集</span></a></li></ul>',{
    searchUrl:'',channelFormatId:'index-grouped',selectorChannelFormatFlattened:{selectChannelNames:'.name',selectEpisodeLists:'ul',selectEpisodesFromList:'a span',selectEpisodeLinksFromList:'a'},
  },'https://anime.example/show');
  assert.equal(results.length,1);
  assert.equal(results[0].url,'https://anime.example/episode/1');
});

test('default source filtering preserves IDs and does not alter custom subscriptions', () => {
  const subscription={exportedMediaSourceDataList:{mediaSources:['E-ACG','Fixture'].map(name=>({factoryId:'web-selector',arguments:{name,searchConfig:{searchUrl:'https://anime.example/search',selectorSubjectFormatA:{selectLists:'a'}}}}))}};
  const providers=buildProvidersFromSubscription(subscription,source=>defaultSourceOverride('https://sub.creamycake.org/v1/css1.json',source));
  assert.deepEqual(Object.keys(providers),['ani_subs_web-selector_1']);
  assert.equal(Object.keys(buildProvidersFromSubscription(subscription,source=>defaultSourceOverride('https://custom.example/css1.json',source))).length,2);
});

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
