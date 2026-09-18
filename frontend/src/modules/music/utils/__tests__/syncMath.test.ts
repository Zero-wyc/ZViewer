/**
 * compensatePositionSec 单测（node:test 原生运行，node --test）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  SYNC_COMPENSATION_MAX_SEC,
  compensatePositionSec,
} from '../syncMath.ts'
import type { MusicSyncState } from '../../types'

const state = (over: Partial<MusicSyncState>): MusicSyncState => ({
  trackSongId: null,
  trackKey: 'ncm:1',
  isPlaying: true,
  positionSec: 10,
  playMode: 'order',
  updatedAt: Date.now(),
  ...over,
})

describe('compensatePositionSec', () => {
  it('播放中按 updatedAt 外推经过的传输延迟', () => {
    const r = compensatePositionSec(state({ updatedAt: Date.now() - 2000 }))
    assert.ok(Math.abs(r - 12) < 0.05, `expected ≈12, got ${r}`)
  })

  it('暂停态原样返回（不外推）', () => {
    const r = compensatePositionSec(
      state({ isPlaying: false, updatedAt: Date.now() - 2000 })
    )
    assert.equal(r, 10)
  })

  it('updatedAt 非有限值不补偿', () => {
    const r = compensatePositionSec(state({ updatedAt: Number.NaN }))
    assert.equal(r, 10)
  })

  it('时钟倒挂（未来时间戳）不补偿', () => {
    const r = compensatePositionSec(state({ updatedAt: Date.now() + 5000 }))
    assert.equal(r, 10)
  })

  it('偏差超过补偿上限不补偿（跨设备时钟不同源防护）', () => {
    const r = compensatePositionSec(
      state({
        updatedAt: Date.now() - (SYNC_COMPENSATION_MAX_SEC + 1) * 1000,
      })
    )
    assert.equal(r, 10)
  })
})
