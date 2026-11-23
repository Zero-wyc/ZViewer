import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCandidateItems,
  registerCliCandidates,
  resetRegisteredCandidates,
  unwrapCliProxyUrl,
} from '../cliCandidates.ts'

/**
 * 候选地址登记链路的边界。
 *
 * 这条链路决定「房主直链模式下某个 CDN 节点 502 时能不能换节点」：
 * 后端下发候选 → 前端登记给 CLI → CLI /proxy 失败换下一个。
 * 任何一环丢掉候选，表现都是整段视频黑屏，所以这里逐条钉住规则。
 */

const PROXY = 'http://127.0.0.1:12345'

test('buildCandidateItems 保留候选顺序并按主地址分组', () => {
  resetRegisteredCandidates()
  const items = buildCandidateItems(PROXY, {
    videoUrl: 'https://a.example/v.m4s',
    videoBackupUrls: [
      'https://a.example/v.m4s',
      'https://b.example/v.m4s',
      'https://c.example/v.m4s',
    ],
    audioUrl: 'https://a.example/a.m4s',
    audioBackupUrls: ['https://a.example/a.m4s', 'https://b.example/a.m4s'],
  })
  assert.equal(items.length, 2)
  assert.deepEqual(items[0], {
    primaryUrl: 'https://a.example/v.m4s',
    backupUrls: [
      'https://a.example/v.m4s',
      'https://b.example/v.m4s',
      'https://c.example/v.m4s',
    ],
  })
  assert.equal(items[1]?.primaryUrl, 'https://a.example/a.m4s')
})

test('buildCandidateItems 在没有回退能力时不产生条目', () => {
  resetRegisteredCandidates()
  // 无候选字段
  assert.deepEqual(
    buildCandidateItems(PROXY, { videoUrl: 'https://a.example/v.m4s' }),
    []
  )
  // 候选只有主地址自己
  assert.deepEqual(
    buildCandidateItems(PROXY, {
      videoUrl: 'https://a.example/v.m4s',
      videoBackupUrls: ['https://a.example/v.m4s'],
    }),
    []
  )
  // 候选里混入空串，去重后仍只有主地址
  assert.deepEqual(
    buildCandidateItems(PROXY, {
      videoUrl: 'https://a.example/v.m4s',
      videoBackupUrls: ['https://a.example/v.m4s', ''],
    }),
    []
  )
})

test('buildCandidateItems 把代理地址还原成原始 CDN 地址', () => {
  resetRegisteredCandidates()
  const raw = 'https://upos-sz-mirrorcos.bilivideo.com/v.m4s?e=1&deadline=2'
  const wrapped = `${PROXY}/proxy?url=${encodeURIComponent(raw)}`
  const items = buildCandidateItems(PROXY, {
    videoUrl: wrapped,
    videoBackupUrls: [
      wrapped,
      `${PROXY}/proxy?url=${encodeURIComponent('https://b.example/v.m4s')}`,
    ],
  })
  // CLI 的候选缓存以原始 URL 为 key，代理地址匹配不上，会静默失效。
  assert.equal(items.length, 1)
  assert.equal(items[0]?.primaryUrl, raw)
  assert.deepEqual(items[0]?.backupUrls, [raw, 'https://b.example/v.m4s'])
})

test('unwrapCliProxyUrl 兼容 ref=live 后缀与非法转义', () => {
  const raw = 'https://a.example/v.m4s?x=%20'
  assert.equal(
    unwrapCliProxyUrl(
      `${PROXY}/proxy?url=`,
      `${PROXY}/proxy?url=${encodeURIComponent(raw)}&ref=live`
    ),
    raw
  )
  // 非法百分号转义不应抛错，原样返回
  assert.equal(
    unwrapCliProxyUrl(`${PROXY}/proxy?url=`, `${PROXY}/proxy?url=%E0%A4%A`),
    `${PROXY}/proxy?url=%E0%A4%A`
  )
})

test('buildCandidateItems 对同一主地址只返回一次', () => {
  resetRegisteredCandidates()
  const payload = {
    videoUrl: 'https://a.example/v.m4s',
    videoBackupUrls: ['https://a.example/v.m4s', 'https://b.example/v.m4s'],
  }
  assert.equal(buildCandidateItems(PROXY, payload).length, 1)
  // 解析缓存命中会重复调用，不应重复登记
  assert.equal(buildCandidateItems(PROXY, payload).length, 0)

  // 换代理端口视为新的登记目标
  assert.equal(buildCandidateItems('http://127.0.0.1:9999', payload).length, 1)
})

test('registerCliCandidates 只 POST items，且失败不影响调用方', async () => {
  resetRegisteredCandidates()
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({ url: String(url), init })
    return new Response('{"success":true}', { status: 200 })
  }) as typeof fetch

  try {
    registerCliCandidates(PROXY, {
      videoUrl: 'https://a.example/v.m4s',
      videoBackupUrls: ['https://a.example/v.m4s', 'https://b.example/v.m4s'],
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, `${PROXY}/candidates`)
    assert.equal(calls[0]?.init?.method, 'POST')
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      items: Array<{ primaryUrl: string; backupUrls: string[] }>
    }
    assert.deepEqual(body.items, [
      {
        primaryUrl: 'https://a.example/v.m4s',
        backupUrls: ['https://a.example/v.m4s', 'https://b.example/v.m4s'],
      },
    ])

    // CLI 未启动：fetch 直接 reject，函数不能抛，也不能留下「已登记」标记
    resetRegisteredCandidates()
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed')
    }) as typeof fetch
    assert.doesNotThrow(() =>
      registerCliCandidates(PROXY, {
        videoUrl: 'https://a.example/v.m4s',
        videoBackupUrls: ['https://a.example/v.m4s', 'https://b.example/v.m4s'],
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(
      buildCandidateItems(PROXY, {
        videoUrl: 'https://a.example/v.m4s',
        videoBackupUrls: ['https://a.example/v.m4s', 'https://b.example/v.m4s'],
      }).length,
      1,
      '失败后应允许重试'
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
