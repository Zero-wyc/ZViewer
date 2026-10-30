import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function fixture(refreshResults, refreshImplementation) {
  const source = readFileSync(
    new URL('../frontend/src/hooks/useSocket.ts', import.meta.url),
    'utf8'
  )
  const code = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replaceAll('export function', 'function')
  const cleanups = []
  const auth = {
    user: { id: '1', role: 'user' },
    autoLoginStatus: 'done',
    hasLoggedOut: false,
    logout() {
      auth.user = null
      auth.hasLoggedOut = true
    },
  }
  const useAuthStore = (select) => select(auth)
  useAuthStore.getState = () => auth
  const react = {
    useEffect: (effect) => cleanups.push(effect()),
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [
      typeof value === 'function' ? value() : value,
      () => {},
    ],
  }
  const listeners = new Map()
  const timers = new Map()
  let timerId = 0
  const setTimeout = (callback, delay) => {
    const id = ++timerId
    timers.set(id, { callback, delay })
    return id
  }
  const clearTimeout = (id) => timers.delete(id)
  const socket = {
    connected: false,
    connects: 0,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return socket
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler)
      return socket
    },
    connect() {
      socket.connects++
      socket.connected = true
      socket.emit('connect')
      return socket
    },
    disconnect() {
      socket.drop('io client disconnect')
      return socket
    },
    emit(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
    },
    drop(reason = 'io server disconnect') {
      socket.connected = false
      socket.emit('disconnect', reason)
    },
    expire() {
      socket.emit('auth-expired', { code: 'TOKEN_EXPIRED' })
      socket.drop()
    },
  }
  let refreshCalls = 0
  let completeRefresh
  const refreshResult = new Promise((resolve) => {
    completeRefresh = resolve
  })
  const api = {
    getSocketUrl: () => '',
    refreshAccessToken: () => {
      refreshCalls++
      if (refreshImplementation) return refreshImplementation()
      if (refreshResults) return Promise.resolve(refreshResults.shift() ?? false)
      return refreshResult
    },
    apiFetch: () => {
      throw new Error('server-disconnect recovery must not downgrade identity')
    },
    saveAuthTokens: () => {},
    resetSessionExpired: () => {},
  }
  const hooks = new Function(
    'react',
    'io',
    'useAuthStore',
    'api',
    'buildSocketAuth',
    'window',
    'setTimeout',
    'clearTimeout',
    `const { useEffect, useMemo, useRef, useState } = react
     const { apiFetch, getSocketUrl, refreshAccessToken, saveAuthTokens, resetSessionExpired } = api
     ${code}
     return { useSocket, resetSocket }`
  )(
    react,
    () => socket,
    useAuthStore,
    api,
    () => ({}),
    {},
    setTimeout,
    clearTimeout
  )
  hooks.useSocket()
  return {
    ...hooks,
    auth,
    socket,
    completeRefresh,
    refreshCalls: () => refreshCalls,
    retryCount: () =>
      [...timers.values()].filter((timer) => timer.delay >= 1000).length,
    runRetry: async () => {
      const next = [...timers].find(([, timer]) => timer.delay >= 1000)
      assert.ok(next, 'expected a scheduled expiry recovery retry')
      timers.delete(next[0])
      next[1].callback()
      await flush()
    },
    unmount: () => cleanups.splice(0).forEach((cleanup) => cleanup?.()),
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('a server expiry refreshes once and reconnects, restoring connect subscribers', async () => {
  const f = fixture()
  f.useSocket()
  let hostRegistrations = 0
  f.socket.on('connect', () => hostRegistrations++)
  f.socket.emit('auth-expired', { code: 'TOKEN_EXPIRED' })
  f.socket.expire()
  assert.equal(f.refreshCalls(), 1)
  assert.equal(f.socket.connects, 1)
  f.completeRefresh(true)
  await flush()
  assert.equal(f.socket.connects, 2)
  assert.equal(hostRegistrations, 1)
  f.resetSocket()
})

test('a revoked refresh stops without reconnecting or downgrading the host', async () => {
  const f = fixture()
  f.socket.expire()
  f.completeRefresh(false)
  await flush()
  await f.runRetry()
  await f.runRetry()
  assert.equal(f.refreshCalls(), 3)
  assert.equal(f.retryCount(), 0)
  assert.equal(f.socket.connects, 1)
  assert.equal(f.socket.connected, false)
  assert.equal(f.auth.user.role, 'user')
  f.resetSocket()
})

test('client disconnects and transport failures keep their existing lifecycle', () => {
  const f = fixture()
  f.socket.drop('io client disconnect')
  f.socket.drop('ping timeout')
  f.socket.drop('transport close')
  assert.equal(f.refreshCalls(), 0)
  f.resetSocket()
})

test('logging out during a refresh cannot revive the connection', async () => {
  const f = fixture()
  f.socket.expire()
  f.auth.logout()
  f.completeRefresh(true)
  await flush()
  assert.equal(f.socket.connects, 1)
  f.resetSocket()
})

test('changing identity during a refresh cannot reconnect as the old host', async () => {
  const f = fixture()
  f.socket.expire()
  f.auth.user = { id: '2', role: 'user' }
  f.completeRefresh(true)
  await flush()
  assert.equal(f.socket.connects, 1)
  f.resetSocket()
})

test('a reset socket ignores an old refresh completion', async () => {
  const f = fixture()
  f.socket.expire()
  f.resetSocket()
  f.completeRefresh(true)
  await flush()
  assert.equal(f.socket.connects, 1)
})

test('a page without socket subscribers does not reconnect after a late refresh', async () => {
  const f = fixture()
  f.socket.expire()
  f.unmount()
  f.completeRefresh(true)
  await flush()
  assert.equal(f.socket.connects, 1)
  f.resetSocket()
})

test('a deliberately logged-out page never starts expiry recovery', () => {
  const f = fixture()
  f.auth.logout()
  f.socket.expire()
  assert.equal(f.refreshCalls(), 0)
  f.resetSocket()
})

test('a server disconnect without an expiry notice cannot automatically rejoin', () => {
  const f = fixture()
  f.socket.drop()
  assert.equal(f.refreshCalls(), 0)
  assert.equal(f.socket.connects, 1)
  f.resetSocket()
})

for (const event of ['viewer-kicked', 'room-closed']) {
  test(`${event} cancels expiry recovery without blocking a later valid session`, async () => {
    const f = fixture()
    f.socket.emit('auth-expired', { code: 'TOKEN_EXPIRED' })
    f.socket.emit(event, { roomId: 'test-room' })
    f.socket.drop()
    assert.equal(f.refreshCalls(), 0)
    assert.equal(f.socket.connects, 1)

    f.socket.connect()
    f.socket.expire()
    f.completeRefresh(true)
    await flush()
    assert.equal(f.refreshCalls(), 1)
    assert.equal(f.socket.connects, 3)
    f.resetSocket()
  })
}

test('an expiry notice cannot leak across a transport disconnect', () => {
  const f = fixture()
  f.socket.emit('auth-expired', { code: 'TOKEN_EXPIRED' })
  f.socket.drop('transport close')
  f.socket.connect()
  f.socket.drop()
  assert.equal(f.refreshCalls(), 0)
  f.resetSocket()
})

test('a transient refresh failure recovers on the next bounded retry', async () => {
  const f = fixture([false, true])
  f.socket.expire()
  await flush()
  assert.equal(f.refreshCalls(), 1)
  assert.equal(f.socket.connects, 1)
  await f.runRetry()
  assert.equal(f.refreshCalls(), 2)
  assert.equal(f.socket.connects, 2)
  assert.equal(f.retryCount(), 0)
  f.resetSocket()
})

for (const event of ['viewer-kicked', 'room-closed']) {
  test(`${event} cancels a refresh that was already pending`, async () => {
    const f = fixture()
    f.socket.expire()
    f.socket.emit(event, { roomId: 'test-room' })
    f.completeRefresh(true)
    await flush()
    assert.equal(f.socket.connects, 1)
    assert.equal(f.retryCount(), 0)
    f.resetSocket()
  })
}

test('a malformed expiry notice cannot reconnect a server-disconnected socket', () => {
  const f = fixture()
  f.socket.emit('auth-expired', { code: 'REVOKED' })
  f.socket.drop()
  assert.equal(f.refreshCalls(), 0)
  f.resetSocket()
})

function refreshFixture(...responses) {
  const source = readFileSync(
    new URL('../frontend/src/lib/api.ts', import.meta.url),
    'utf8'
  )
  const code = stripTypeScriptTypes(source)
    .replace(/^import[\s\S]*?from '[^']+'\r?\n/gm, '')
    .replace(/^export\s*\{[\s\S]*?\}\s*from '[^']+'\r?\n/gm, '')
    .replace(/\bexport (?=(?:async )?function|let|const)/g, '')
    .replaceAll('import.meta.env', 'viteEnv')
  const requests = []
  const tokens = []
  const fetch = async (url, options) => {
    requests.push({ url, options })
    const response = responses.shift()
    if (typeof response !== 'number') return response
    return new Response(
      JSON.stringify({
        success: response === 200,
        ...(response === 200 ? { accessToken: 'renewed-test-token' } : {}),
      }),
      { status: response }
    )
  }
  const api = new Function(
    'fetch',
    'getRefreshToken',
    'saveAuthTokens',
    'buildAuthHeaders',
    'localStorage',
    'window',
    'viteEnv',
    `${code}
     return { refreshAccessToken, resetSessionExpired }`
  )(
    fetch,
    () => '',
    (token) => tokens.push(token),
    () => ({}),
    { getItem: () => null },
    { location: { origin: 'http://test.local', hostname: 'test.local' } },
    {}
  )
  return { ...api, requests, tokens }
}

for (const status of [502, 503, 429]) {
  test(`the actual refresh implementation retries HTTP ${status} successfully`, async () => {
    const f = refreshFixture(status, 200)
    assert.equal(await f.refreshAccessToken(), false)
    assert.equal(await f.refreshAccessToken(), true)
    assert.equal(f.requests.length, 2)
    assert.deepEqual(f.tokens, ['renewed-test-token'])
  })
}

for (const status of [401, 403]) {
  test(`the actual refresh implementation caches HTTP ${status} until login resets it`, async () => {
    const f = refreshFixture(status, 200)
    assert.equal(await f.refreshAccessToken(), false)
    assert.equal(await f.refreshAccessToken(), false)
    assert.equal(f.requests.length, 1)
    f.resetSessionExpired()
    assert.equal(await f.refreshAccessToken(), true)
    assert.equal(f.requests.length, 2)
  })
}

test('the actual refresh implementation shares one fetch across concurrent callers', async () => {
  let completeResponse
  const pendingResponse = new Promise((resolve) => {
    completeResponse = resolve
  })
  const f = refreshFixture(pendingResponse)
  const first = f.refreshAccessToken()
  const second = f.refreshAccessToken()
  assert.equal(f.requests.length, 1)
  completeResponse(
    new Response(
      JSON.stringify({ success: true, accessToken: 'renewed-test-token' }),
      { status: 200 }
    )
  )
  assert.deepEqual(await Promise.all([first, second]), [true, true])
  assert.deepEqual(f.tokens, ['renewed-test-token'])
})

test('expiry recovery actually fetches again after HTTP 503', async () => {
  const api = refreshFixture(503, 200)
  const f = fixture(undefined, api.refreshAccessToken)
  f.socket.expire()
  await flush()
  assert.equal(api.requests.length, 1)
  assert.equal(f.socket.connects, 1)
  await f.runRetry()
  assert.equal(api.requests.length, 2)
  assert.equal(f.socket.connects, 2)
  assert.equal(f.retryCount(), 0)
  f.resetSocket()
})
