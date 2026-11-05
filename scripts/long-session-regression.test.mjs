import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

let now = 1_800_000_000_000
class Clock extends Date { static now() { return now } }
function load(file, imports = {}) {
  const exports = {}
  const code = ts.transpileModule(fs.readFileSync(`frontend/src/${file}`, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('exports', 'require', 'Date', code)(exports, name => {
    assert.ok(name in imports, `unexpected import ${name}`)
    return imports[name]
  }, Clock)
  return exports
}
const expiry = load('modules/playback-memory/services/url-expiry.ts')
const cdn = seconds => `https://fixture.bilivideo.com/audio.m4s?deadline=${Math.floor(now/1000)+seconds}`
const proxied = url => `http://example.test/api/stream/proxy?url=${encodeURIComponent(url)}`
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('renewal reads nested proxy deadlines and starts before the CDN rejects media', () => {
  assert.equal(expiry.isBilibiliUrlExpiring(proxied(proxied(cdn(59)))), true)
  assert.equal(expiry.isBilibiliUrlExpiring(cdn(61)), false)
  for (const url of ['', 'bad', 'https://example.test/?deadline=123abc', 'https://example.test/?deadline=Infinity']) {
    assert.equal(expiry.getBilibiliUrlDeadline(url), null)
  }
})

test('audio cache expires by the CDN deadline even when its two-hour TTL is fresh', () => {
  const cache = load('modules/music/hooks/biliAudioCache.ts', {
    '@/modules/playback-memory/services/url-expiry': expiry,
  })
  cache.setCachedBiliAudioUrl('fixture:101', proxied(cdn(70)))
  assert.ok(cache.getCachedBiliAudioUrl('fixture:101'))
  now += 11_000
  assert.equal(cache.getCachedBiliAudioUrl('fixture:101'), null)
  cache.setCachedBiliAudioUrl('fixture:202', cdn(7200))
  assert.ok(cache.getCachedBiliAudioUrl('fixture:202'))
  cache.invalidateBiliAudioUrl('fixture:202')
  assert.equal(cache.getCachedBiliAudioUrl('fixture:202'), null)
})

function renewalFixture() {
  const item = { biliBvid: 'BVfixture', biliCid: 202 }
  const state = { currentKey: 'bili:BVfixture:202', queue: [item], isPlaying: true }
  const audio = { src: proxied(cdn(30)), currentTime: 7201, paused: false, playbackRate: 1.25, error: null }
  const request = deferred()
  const plays = [], broadcasts = [], failures = [], invalidated = []
  let resolutions = 0, refreshes = 0
  const options = {
    audioRef: { current: audio }, roomIdRef: { current: 'room-a' },
    socketRef: { current: { connected: true } }, isHostRef: { current: true },
    playSource: (...args) => { plays.push(args); audio.src = args[0] },
    resolve: async target => { assert.equal(target.biliCid, 202); resolutions++; return request.promise },
    broadcast: state => broadcasts.push(state),
    onFailure: (error, exhausted) => failures.push({ error, exhausted }),
  }
  const api = load('modules/music/hooks/bilibiliAudioRenewal.ts', {
    '@/lib/api': { refreshAccessToken: async () => { refreshes++; return true } },
    '@/lib/authTransport': { isAccessTokenExpired: () => false },
    '@/modules/playback-memory/services/url-expiry': expiry,
    '../store': { useMusicStore: { getState: () => state }, musicItemKey: () => 'bili:BVfixture:202' },
    './biliAudioCache': {
      invalidateBiliAudioUrl: key => invalidated.push(key),
      // 备用直链由后台续签预存；本组用例不带 standby，走原解析路径
      takeBiliStandbyUrl: () => null,
      setCachedBiliAudioUrl: () => {},
    },
  })
  return { controller: api.createBilibiliAudioRenewal(options), options, state, audio, request,
    plays, broadcasts, failures, invalidated, resolutions: () => resolutions, refreshes: () => refreshes }
}

test('Bilibili renewal deduplicates, retains CID, and resumes current progress and rate', async () => {
  const f = renewalFixture()
  f.controller.checkDeadline()
  f.controller.checkDeadline()
  assert.equal(f.resolutions(), 1)
  f.audio.currentTime = 7210
  f.request.resolve({ playUrl: proxied(cdn(7200)) })
  await flush()
  assert.deepEqual(f.plays[0].slice(1), [7210, true, 'bili:BVfixture:202'])
  assert.equal(f.audio.playbackRate, 1.25)
  assert.deepEqual(f.invalidated, ['BVfixture:202'])
  assert.deepEqual(f.broadcasts, [{ positionSec: 7210, isPlaying: true }])
})

test('403-style media errors refresh authentication and respect a user pause during resolve', async () => {
  const f = renewalFixture()
  assert.equal(f.controller.recover(true), true)
  await flush()
  assert.equal(f.refreshes(), 1)
  f.state.isPlaying = false
  f.audio.paused = true
  f.audio.currentTime = 7300
  f.request.resolve({ playUrl: cdn(7200) })
  await flush()
  assert.equal(f.plays[0][1], 7300)
  assert.equal(f.plays[0][2], false)
})

for (const change of ['track', 'room', 'socket', 'source', 'teardown', 'unmount']) {
  test(`a late resolution cannot restart media after ${change}`, async () => {
    const f = renewalFixture()
    f.controller.recover(false)
    if (change === 'track') f.state.currentKey = 'ncm:1'
    if (change === 'room') f.options.roomIdRef.current = 'room-b'
    if (change === 'socket') f.options.socketRef.current.connected = false
    if (change === 'source') f.audio.src = 'https://example.test/new.mp3'
    if (change === 'teardown') f.controller.cancel()
    if (change === 'unmount') f.controller.dispose()
    f.request.resolve({ playUrl: cdn(7200) })
    await flush()
    assert.equal(f.plays.length, 0)
    assert.equal(f.broadcasts.length, 0)
  })
}

test('failed renewal stops after three attempts even while old buffered audio advances', async () => {
  const f = renewalFixture()
  f.request.reject(new Error('fixture upstream denied'))
  for (let attempt = 0; attempt < 3; attempt++) {
    now += 31_000
    f.controller.checkDeadline()
    await flush()
    f.audio.currentTime += 5
  }
  now += 31_000
  f.controller.checkDeadline()
  await flush()
  assert.equal(f.resolutions(), 3)
  assert.equal(f.failures.length, 3)
  assert.equal(f.failures[2].exhausted, true)
})

function videoRecoveryFixture() {
  const source = ts.createSourceFile('recovery.ts',
    fs.readFileSync('frontend/src/modules/room/watch-together/useWatchTogether.ts', 'utf8'),
    ts.ScriptTarget.Latest, true)
  let effect
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect' &&
        node.arguments[0]?.getText(source).includes('const MAX_AUTO_RELOADS')) {
      effect = node.arguments[0].getText(source)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(effect, 'Bilibili video recovery effect must exist')
  const events = new Map()
  const video = {
    currentTime: 7200, paused: false, error: { code: 2 },
    addEventListener: (name, fn) => events.set(name, fn),
    removeEventListener: name => events.delete(name),
  }
  const state = { sourceType: 'bilibili', sourceUrl: cdn(7200), audioUrl: cdn(20) }
  let reloads = 0, notified = 0, cleanup
  const options = {
    useRoomStore: { getState: () => ({ watchTogether: state }) },
    isHostRef: { current: true }, videoRef: { current: video },
    autoReloadSourceRef: { current: '' }, autoReloadProgressRef: { current: null },
    autoReloadCountRef: { current: 0 }, autoReloadNotifiedRef: { current: false },
    lastAutoReloadAtRef: { current: 0 }, suppressEventsRef: { current: false },
    isReloadingBilibiliRef: { current: false },
    isBilibiliUrlExpiring: expiry.isBilibiliUrlExpiring,
    reloadBilibili: () => { reloads++ },
    message: { warning: () => { notified++ } }, translate: text => text,
    document: { addEventListener() {}, removeEventListener() {} },
    setInterval() { return 1 }, clearInterval() {}, setTimeout() { return 1 }, clearTimeout() {},
  }
  const compiled = ts.transpileModule(`const recovery = ${effect}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const install = new Function(...Object.keys(options), 'Date', `${compiled}; return recovery()`)
  return { state, video, events, reloads: () => reloads, notified: () => notified,
    install() { cleanup?.(); cleanup = install(...Object.values(options), Clock) },
    cleanup() { cleanup?.() } }
}

test('video recovery checks the audio deadline and caps retries until playback advances', () => {
  const f = videoRecoveryFixture()
  for (let attempt = 0; attempt < 4; attempt++) {
    now += 61_000
    f.state.sourceUrl = `${cdn(7200)}&attempt=${attempt}`
    f.install()
  }
  assert.equal(f.reloads(), 3)
  assert.equal(f.notified(), 1)
  f.video.error = null
  f.video.currentTime += 3
  f.events.get('timeupdate')()
  assert.equal(f.reloads(), 4)
  f.cleanup()
  assert.equal(f.events.size, 0)
})

test('fully buffered video does not renew an unused CDN source', () => {
  const f = videoRecoveryFixture()
  f.state.bufferMode = true
  f.install()
  assert.equal(f.reloads(), 0)
  f.cleanup()
})

function membershipFixture() {
  let cleanup
  const listeners = new Map(), timers = new Set(), requests = []
  const state = {
    viewers: [{ socketId: 'stale' }], moderators: [], mutedViewerIds: [],
    setViewers(value) { this.viewers = value },
    setModerators(value) { this.moderators = value },
    setMutedViewerIds(value) { this.mutedViewerIds = value },
    addViewer(value) { this.viewers.push(value) },
    removeViewer(id) { this.viewers = this.viewers.filter(v => v.socketId !== id) },
  }
  const socket = {
    connected: true, id: 'host-current',
    on(name, fn) { listeners.set(name, fn) },
    off(name) { listeners.delete(name) },
    timeout() { return this },
    emit(name, data, ack) { requests.push({ name, data, ack }) },
  }
  const code = ts.transpileModule(fs.readFileSync('frontend/src/modules/sync-playback/hooks/useViewerList.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText
  const modules = {
    react: { useEffect: fn => { cleanup = fn() } },
    '@/hooks/useSocket': { useSocket: () => ({ socket }) },
    '@/store/roomStore': { useRoomStore: { getState: () => state } },
    '@/store/authStore': { useAuthStore: { getState: () => ({ user: { id: 2 } }) } },
    '@/components/ui/message': { message: { success() {}, info() {} } },
    '@/i18n': { t: text => text },
    '../constants': { SOCKET_EVENT: { VIEWER_JOINED: 'viewer-joined', VIEWER_LEFT: 'viewer-left' } },
  }
  const exports = {}
  new Function('exports', 'require', 'document', 'setInterval', 'clearInterval', code)(
    exports, name => modules[name], { addEventListener() {}, removeEventListener() {} },
    fn => { timers.add(fn); return fn }, fn => timers.delete(fn))
  exports.useViewerList('room-a')
  const snapshot = { roomId: 'room-a', viewers: [{ socketId: 'new-member', userId: 2 }],
    moderators: [2], mutedViewerIds: [] }
  return { state, socket, listeners, requests, snapshot, cleanup: () => cleanup() }
}

test('room-level snapshots repair missing members and permissions with the info panel closed', () => {
  const f = membershipFixture()
  f.requests[0].ack(null, { success: true, data: f.snapshot })
  assert.equal(f.state.viewers[0].socketId, 'new-member')
  assert.deepEqual(f.state.moderators, [2])
  f.listeners.get('moderators-changed')({ roomId: 'room-a', moderators: [] })
  assert.deepEqual(f.state.moderators, [])
  f.listeners.get('room-members')({ ...f.snapshot, roomId: 'room-b' })
  assert.deepEqual(f.state.moderators, [])
  f.cleanup()
})

test('an older member snapshot cannot overwrite later joins or an unmounted room', () => {
  const f = membershipFixture()
  f.listeners.get('viewer-joined')({ viewerSocketId: 'latest', userId: 3 })
  f.requests[0].ack(null, { success: true, data: f.snapshot })
  assert.ok(f.state.viewers.some(v => v.socketId === 'latest'))
  f.listeners.get('connect')()
  const pending = f.requests.at(-1)
  f.cleanup()
  pending.ack(null, { success: true, data: f.snapshot })
  assert.ok(f.state.viewers.some(v => v.socketId === 'latest'))
})

test('an older query cannot overwrite a newer pushed membership snapshot', () => {
  const f = membershipFixture()
  f.listeners.get('room-members')({ ...f.snapshot, moderators: [3] })
  f.requests[0].ack(null, { success: true, data: f.snapshot })
  assert.deepEqual(f.state.moderators, [3])
  f.cleanup()
})
