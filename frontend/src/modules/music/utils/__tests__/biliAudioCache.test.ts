/**
 * biliAudioCache 单测（node:test 原生运行）。
 *
 * 重点覆盖「直链失效自愈」依赖的三件事：
 * - 代际提交：失效前发起、失效后才返回的旧解析不能覆盖新地址；
 * - 备用直链：取出即消费，作废时一并清除；
 * - 视频源共享：同 bvid:cid:qn 才能复用，避免不同清晰度串用。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  beginBiliResolve,
  biliVideoSourceKey,
  commitBiliResolve,
  getCachedBiliAudioUrl,
  getCachedBiliVideoSource,
  invalidateBiliAudioUrl,
  isBiliAudioStale,
  setBiliStandbyUrl,
  setCachedBiliAudioUrl,
  setCachedBiliStream,
  setCachedBiliVideoSource,
  takeBiliStandbyUrl,
} from '../../hooks/biliAudioCache.ts'

describe('biliAudioCache', () => {
  it('读写与作废', () => {
    const key = 'BVread:1'
    assert.equal(getCachedBiliAudioUrl(key), null)
    setCachedBiliAudioUrl(key, '/proxy?u=A')
    assert.equal(getCachedBiliAudioUrl(key), '/proxy?u=A')
    invalidateBiliAudioUrl(key)
    assert.equal(getCachedBiliAudioUrl(key), null)
  })

  it('旧代际的解析结果被丢弃', () => {
    const key = 'BVgen:1'
    setCachedBiliAudioUrl(key, '/old')
    // 失效前发起的解析（gen1），尚未返回
    const staleGen = beginBiliResolve(key)
    invalidateBiliAudioUrl(key)
    // 自愈发起的新解析（gen2）先返回并写入
    const freshGen = beginBiliResolve(key)
    assert.equal(commitBiliResolve(key, freshGen, { url: '/new' }), true)
    assert.equal(getCachedBiliAudioUrl(key), '/new')
    // 旧解析此时才返回：必须被拒
    assert.equal(commitBiliResolve(key, staleGen, { url: '/old-late' }), false)
    assert.equal(getCachedBiliAudioUrl(key), '/new')
  })

  it('备用直链取出即消费', () => {
    const key = 'BVstandby:1'
    setBiliStandbyUrl(key, '/standby')
    assert.equal(takeBiliStandbyUrl(key), '/standby')
    assert.equal(takeBiliStandbyUrl(key), null)
  })

  it('作废缓存同时清掉备用直链', () => {
    const key = 'BVstandby:2'
    setBiliStandbyUrl(key, '/standby')
    invalidateBiliAudioUrl(key)
    assert.equal(takeBiliStandbyUrl(key), null)
  })

  it('新解析地址未过软 TTL', () => {
    const key = 'BVstale:1'
    setCachedBiliStream(key, { url: '/fresh', videoUrl: '/v', qn: 64 })
    assert.equal(isBiliAudioStale(key), false)
    assert.equal(isBiliAudioStale('BVmissing:1'), false)
  })

  it('视频源按 bvid:cid:qn 复用且不串清晰度', () => {
    const videoKey = biliVideoSourceKey('BVvideo', 42, 64)
    setCachedBiliVideoSource(videoKey, {
      url: '/video',
      format: 'mp4',
      duration: 100,
    })
    assert.equal(
      getCachedBiliVideoSource<{ url: string }>(videoKey)?.url,
      '/video'
    )
    // 不同 qn 不能命中（否则会拿 720P 冒充用户选的高清）
    assert.equal(
      getCachedBiliVideoSource(biliVideoSourceKey('BVvideo', 42, 80)),
      null
    )
    // 不同分P 也不能命中
    assert.equal(
      getCachedBiliVideoSource(biliVideoSourceKey('BVvideo', 43, 64)),
      null
    )
  })
})
