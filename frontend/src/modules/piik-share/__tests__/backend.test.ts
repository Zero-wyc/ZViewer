/**
 * 开关解析的用例。
 *
 * 这个文件最容易出错的不是默认值，而是「显式指定」的判断：页面靠它决定
 * 要不要用服务端能力覆盖链路，判错就会把用户手动切换的开关又拨回去。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  captureShareBackendFromQuery,
  shareBackend,
  shareBackendChoice,
} from '../backend.ts'

const KEY = 'zviewer-share-backend'

interface Env {
  search?: string
  stored?: string | null
  /** 模拟隐私模式：localStorage 一碰就抛。 */
  hostile?: boolean
}

function installEnv({ search = '', stored = null, hostile = false }: Env) {
  const store = new Map<string, string>()
  if (stored !== null) store.set(KEY, stored)
  Object.defineProperty(globalThis, 'location', {
    value: { search },
    configurable: true,
    writable: true,
  })
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => {
        if (hostile) throw new Error('SecurityError')
        return store.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (hostile) throw new Error('SecurityError')
        store.set(key, value)
      },
      removeItem: (key: string) => store.delete(key),
    },
    configurable: true,
    writable: true,
  })
  return store
}

test('没配过的机器走 Piik', () => {
  installEnv({})
  assert.deepEqual(shareBackendChoice(), {
    backend: 'piik',
    explicit: false,
  })
})

test('query 指定 sfu 时算显式，且优先于 storage', () => {
  installEnv({ search: '?shareBackend=sfu', stored: 'piik' })
  assert.deepEqual(shareBackendChoice(), { backend: 'sfu', explicit: true })
})

test('storage 里的值也算显式', () => {
  installEnv({ stored: 'sfu' })
  assert.deepEqual(shareBackendChoice(), { backend: 'sfu', explicit: true })
})

test('非法取值既不生效也不覆盖既有选择', () => {
  const store = installEnv({ search: '?shareBackend=quic', stored: 'piik' })
  captureShareBackendFromQuery()
  assert.equal(store.get(KEY), 'piik')
  assert.deepEqual(shareBackendChoice(), { backend: 'piik', explicit: true })
})

test('重定向丢掉 query 之后，开关仍然算显式', () => {
  // `/share/<id>` → `/room/<id>` 的真实顺序：先带 query 抓一次，再被重定向。
  const store = installEnv({ search: '?shareBackend=sfu' })
  captureShareBackendFromQuery()
  assert.equal(store.get(KEY), 'sfu')

  Object.defineProperty(globalThis, 'location', {
    value: { search: '' },
    configurable: true,
    writable: true,
  })
  assert.deepEqual(shareBackendChoice(), { backend: 'sfu', explicit: true })
})

test('隐私模式（localStorage 抛异常）退回默认 Piik，不炸页面', () => {
  installEnv({ hostile: true })
  assert.deepEqual(shareBackendChoice(), {
    backend: 'piik',
    explicit: false,
  })
  assert.equal(shareBackend(), 'piik')
})
