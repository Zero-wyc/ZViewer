import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function fixture(withHandlers = true) {
  const source = readFileSync(
    new URL('../frontend/src/modules/player/engines/flv-engine.ts', import.meta.url),
    'utf8'
  )
  const code = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replace('export const flvEngine', 'const flvEngine')
  let now = 0
  let timerId = 0
  const timers = new Map()
  const setTimeout = (callback, delay) => {
    const id = ++timerId
    timers.set(id, { callback, at: now + delay })
    return id
  }
  const clearTimeout = (id) => timers.delete(id)
  const listeners = new Map()
  const videoListeners = new Map()
  const video = {
    addEventListener: (event, listener) => videoListeners.set(event, listener),
    removeEventListener: (event) => videoListeners.delete(event),
  }
  const counts = {
    unload: 0,
    load: 0,
    play: 0,
    pause: 0,
    destroy: 0,
    ready: 0,
    exhausted: 0,
    ended: 0,
  }
  const retries = []
  let loadAction = () => {}
  const player = {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(listener)
    },
    unload: () => counts.unload++,
    load: () => {
      counts.load++
      loadAction()
    },
    play: () => {
      counts.play++
      return Promise.resolve()
    },
    pause: () => counts.pause++,
    attachMediaElement: () => {},
    detachMediaElement: () => {},
    destroy: () => counts.destroy++,
  }
  const events = {
    onRetrying: (attempt, max) => retries.push({ attempt, max, at: now }),
    onReady: () => counts.ready++,
    onExhausted: () => counts.exhausted++,
    onStreamEnd: () => counts.ended++,
  }
  const flvjs = {
    Events: {
      ERROR: 'error',
      MEDIA_INFO: 'media-info',
      STATISTICS_INFO: 'statistics',
      LOADING_COMPLETE: 'loading-complete',
    },
    isSupported: () => true,
    createPlayer: () => player,
  }
  const engine = new Function(
    'flvjs',
    'resetVideoElement',
    'waitForMetadata',
    'resolveProxyUrl',
    'setTimeout',
    'clearTimeout',
    'console',
    `${code}
     return { flvEngine, attachLiveHandlers }`
  )(
    flvjs,
    () => {},
    async () => {},
    (url) => url,
    setTimeout,
    clearTimeout,
    { log: () => {}, warn: () => {} }
  )
  const dispose = withHandlers
    ? engine.attachLiveHandlers(video, player, events)
    : () => {}
  const emit = (event, ...args) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
  }
  return {
    ...engine,
    video,
    events,
    counts,
    retries,
    listeners,
    dispose,
    emit,
    now: () => now,
    pending: () => timers.size,
    nextDelay: () => Math.min(...[...timers.values()].map((t) => t.at - now)),
    onLoad: (action) => {
      loadAction = action
    },
    advance: (elapsed) => {
      const target = now + elapsed
      while (timers.size) {
        const [id, timer] = [...timers].sort(
          ([, a], [, b]) => a.at - b.at
        )[0]
        if (timer.at > target) break
        now = timer.at
        timers.delete(id)
        timer.callback()
      }
      now = target
    },
  }
}

test('normal live stream completion reconnects while the viewer remains mounted', () => {
  const f = fixture()
  f.onLoad(() => f.emit('media-info'))
  f.emit('loading-complete')
  assert.equal(f.counts.ended, 1)
  assert.equal(f.nextDelay(), 1000)
  f.advance(1000)
  assert.equal(f.counts.load, 1)
  assert.equal(f.counts.play, 1)
  assert.equal(f.counts.ready, 1)
  assert.equal(f.pending(), 0)
  f.dispose()
})

for (const failure of ['error', 'loading-complete']) {
  test(`${failure} keeps retrying past 31 seconds and resumes a source returning at 50 seconds`, () => {
    const f = fixture()
    f.onLoad(() => {
      if (f.now() >= 50000) f.emit('media-info')
      else f.emit(failure, 'network', 'unavailable')
    })
    f.emit(failure, 'network', 'unavailable')
    f.advance(49000)
    assert.equal(f.counts.load, 6)
    assert.equal(f.counts.ready, 0)
    assert.equal(f.nextDelay(), 2000)
    f.advance(2000)
    assert.equal(f.counts.load, 7)
    assert.equal(f.counts.ready, 1)
    assert.equal(f.counts.exhausted, 0)
    assert.equal(f.pending(), 0)
    f.dispose()
  })
}

test('overlapping error and completion signals share one scheduled reconnect', () => {
  const f = fixture()
  f.emit('error', 'network', 'lost')
  f.advance(500)
  f.emit('loading-complete')
  f.emit('error', 'network', 'lost')
  assert.equal(f.retries.length, 1)
  assert.equal(f.nextDelay(), 500)
  f.advance(500)
  assert.equal(f.counts.load, 1)
  f.dispose()
})

test('readiness cancels a queued reconnect and resets the fast recovery interval', () => {
  const f = fixture()
  f.emit('error', 'network', 'lost')
  f.advance(1000)
  f.emit('error', 'network', 'lost')
  assert.equal(f.nextDelay(), 2000)
  f.emit('media-info')
  f.advance(10000)
  assert.equal(f.counts.load, 1)
  f.emit('error', 'network', 'lost')
  assert.equal(f.nextDelay(), 1000)
  assert.equal(f.retries.at(-1).attempt, 1)
  f.dispose()
})

test('synchronous reconnect failures remain eligible for the next retry', () => {
  const f = fixture()
  f.onLoad(() => {
    throw new Error('temporary FLV load failure')
  })
  f.emit('loading-complete')
  f.advance(1000)
  assert.equal(f.counts.load, 1)
  assert.equal(f.nextDelay(), 2000)
  f.dispose()
  f.advance(60000)
  assert.equal(f.counts.load, 1)
})

test('offline unmount destroys the live engine and cancels future recovery', async () => {
  const f = fixture(false)
  const attached = await f.flvEngine.attach(f.video, {
    url: 'http://test.local/live/test.flv',
    isLive: true,
    flvRuntimeEvents: f.events,
  })
  f.emit('loading-complete')
  assert.equal(f.pending(), 1)
  attached.cleanup()
  attached.cleanup()
  f.emit('error', 'network', 'late failure')
  f.emit('loading-complete')
  f.advance(120000)
  assert.equal(f.pending(), 0)
  assert.equal(f.counts.load, 1)
  assert.equal(f.counts.destroy, 1)
})

test('on-demand FLV sources keep their existing lifecycle without live retries', async () => {
  const f = fixture(false)
  const attached = await f.flvEngine.attach(f.video, {
    url: 'http://test.local/movie.flv',
  })
  assert.equal(f.listeners.size, 0)
  f.emit('error', 'network', 'lost')
  f.emit('loading-complete')
  f.advance(120000)
  assert.equal(f.counts.load, 1)
  assert.equal(f.pending(), 0)
  attached.cleanup()
  assert.equal(f.counts.destroy, 1)
})
