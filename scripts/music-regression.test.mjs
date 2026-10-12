import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function load(file) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('exports', 'require', code)(exports, require);
  return exports;
}
const { initialMusicVolume } = load('frontend/src/modules/music/utils/volume.ts');
const { usePersonalFmStore: fm, fetchPersonalFmPool, advancePersonalFm } = load('frontend/src/modules/music/personal-fm.ts');
const song = (id) => ({ songId: id, name: `Song ${id}`, artist: '', album: '', cover: '', durationMs: 1000, vip: false });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('initial volume is 50%, server default applies, saved volume including mute wins', () => {
  assert.equal(initialMusicVolume(null), .5);
  assert.equal(initialMusicVolume(null, 35), .35);
  assert.equal(initialMusicVolume('0', 35), 0);
  assert.equal(initialMusicVolume('1', 35), 1);
  for (const invalid of ['', 'garbage', '1oops', '-1', '2', 'Infinity']) {
    assert.equal(initialMusicVolume(invalid, 35), .35);
  }
  for (const invalid of [-1, 101, NaN]) assert.equal(initialMusicVolume(null, invalid), .5);
});

test('FM requests deduplicate and filter repeated/current/history songs', async () => {
  fm.getState().reset();
  fm.getState().activate('room', song(1));
  fm.getState().setHistory([song(2)]);
  const wait = deferred();
  let count = 0;
  const request = async () => { count++; return wait.promise; };
  const first = fetchPersonalFmPool(request);
  assert.equal(fetchPersonalFmPool(request), first);
  wait.resolve([1, 2, 3, 3, 4].map((id) => ({ id, name: String(id) })));
  await first;
  assert.equal(count, 1);
  assert.deepEqual(fm.getState().pool.map((s) => s.songId), [3, 4]);
});

test('mode changes invalidate old responses and use current mode/submode with fallback', async () => {
  fm.getState().reset();
  const wait = deferred();
  const old = fetchPersonalFmPool(() => wait.promise);
  fm.getState().setMode('SCENE_RCMD');
  fm.getState().setSubmode('NIGHT_EMO');
  const urls = [];
  await fetchPersonalFmPool(async (url) => {
    urls.push(url);
    return urls.length === 1 ? [] : [{ id: 9, name: 'New' }];
  });
  wait.resolve([{ id: 8, name: 'Old' }]);
  await old;
  assert.match(urls[0], /mode=SCENE_RCMD.*submode=NIGHT_EMO/);
  assert.equal(urls[1], '/api/music/ncm/personal_fm');
  assert.deepEqual(fm.getState().pool.map((s) => s.songId), [9]);
});

test('FM automatically enqueues and plays successive candidates, refilling on exhaustion', async () => {
  fm.getState().reset();
  fm.getState().activate('room', song(1));
  fm.getState().setPool([song(2), song(3)]);
  const events = [];
  let refills = 0;
  for (const id of [1, 2, 3, 4]) {
    await advancePersonalFm('room', `ncm:${id}`, {
      refill: async () => { refills++; fm.getState().setPool([song(4), song(5)]); },
      enqueue: async (s) => { events.push(`enqueue:${s.songId}`); },
      play: (s) => { events.push(`play:${s.songId}`); },
      isCurrent: () => true,
    });
  }
  assert.deepEqual(events, [2, 3, 4, 5].flatMap((id) => [`enqueue:${id}`, `play:${id}`]));
  assert.equal(refills, 1);
  assert.equal(fm.getState().activeKey, 'ncm:5');
  assert.deepEqual(fm.getState().history.map((s) => s.songId), [1, 2, 3, 4]);
});

test('FM waits for queue acknowledgement before switching and preserves candidate on denial', async () => {
  fm.getState().reset(); fm.getState().activate('room', song(1)); fm.getState().setPool([song(2)]);
  const wait = deferred(); const played = [];
  const next = advancePersonalFm('room', 'ncm:1', {
    refill: async () => {}, enqueue: () => wait.promise,
    play: (s) => played.push(s.songId), isCurrent: () => true,
  });
  assert.deepEqual(played, []);
  assert.equal(fm.getState().activeKey, 'ncm:1');
  wait.resolve(); await next;
  assert.deepEqual(played, [2]);
  fm.getState().setPool([song(3)]);
  await assert.rejects(advancePersonalFm('room', 'ncm:2', {
    refill: async () => {}, enqueue: async () => { throw new Error('denied'); },
    play: () => assert.fail(), isCurrent: () => true,
  }), /denied/);
  assert.equal(fm.getState().activeKey, 'ncm:2');
  assert.equal(fm.getState().pool[0].songId, 3);
});

test('leaving room, ordinary playback, mode change or user action cancels pending FM', async () => {
  for (const cancel of [() => fm.getState().reset(), () => fm.getState().deactivate(), () => fm.getState().setMode('EXPLORE'), () => fm.getState().invalidate()]) {
    fm.getState().reset(); fm.getState().activate('room', song(1)); fm.getState().setPool([song(2)]);
    const wait = deferred(); const allowed = true;
    const next = advancePersonalFm('room', 'ncm:1', {
      refill: async () => {}, enqueue: () => wait.promise,
      play: () => assert.fail('stale request must not start playback'), isCurrent: () => allowed,
    });
    cancel(); wait.resolve(); await next;
  }
});

test('losing playback control while awaiting queue acknowledgement cannot start a song', async () => {
  fm.getState().reset(); fm.getState().activate('room', song(1)); fm.getState().setPool([song(2)]);
  const wait = deferred(); let allowed = true;
  const next = advancePersonalFm('room', 'ncm:1', {
    refill: async () => {}, enqueue: () => wait.promise,
    play: () => assert.fail(), isCurrent: () => allowed,
  });
  allowed = false; wait.resolve(); await next;
  assert.equal(fm.getState().activeKey, 'ncm:1');
});

test('other rooms and non-FM tracks do not request or enqueue recommendations', async () => {
  fm.getState().reset(); fm.getState().activate('room', song(1));
  for (const [room, key] of [['other', 'ncm:1'], ['room', 'ncm:99'], ['room', null]]) {
    await advancePersonalFm(room, key, {
      refill: async () => assert.fail(), enqueue: async () => assert.fail(),
      play: () => assert.fail(), isCurrent: () => true,
    });
  }
});
