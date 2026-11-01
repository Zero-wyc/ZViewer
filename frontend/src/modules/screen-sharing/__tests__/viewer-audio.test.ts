/**
 * 观众端音量控制的纯逻辑测试。
 *
 * 只钉住四条「错了就会静音/双响」的不变量：
 *  1. 用户没动过音量时不接 Web Audio（默认路径必须保持原生播放）；
 *  2. 接管期间 `video.muted` 恒为 true（否则同一路声音播两次）；
 *  3. 静音 / 暂停时增益归零（不能"静音了但还在响"）；
 *  4. 上下文起不来时降级回原生 0–100%，不留「UI 显示 200% 但没声音」。
 *
 * 用假 video / 假 AudioContext，不碰真实媒体栈。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ViewerAudio, type ViewerAudioSnapshot } from '../core/viewer-audio.ts'

// node 没有 MediaStream：`createMediaStreamSource` 需要一个容器对象，
// 这里补一个最小实现（只被原样传进假 AudioContext，不会被读取）。
;(globalThis as unknown as { MediaStream: unknown }).MediaStream = class {
  tracks: unknown[]
  constructor(tracks: unknown[]) {
    this.tracks = tracks
  }
}

class FakeVideo extends EventTarget {
  volume = 1
  muted = false
  paused = false
  ended = false
}

interface FakeGain {
  gain: { value: number }
  connect: () => void
  disconnect: () => void
}

function fakeContext(options: { resumeFails?: boolean } = {}) {
  const gains: FakeGain[] = []
  // 真实浏览器里，没有用户手势时新建的 AudioContext 就是 suspended，
  // resume() 才会被拒绝——这里照这个初始值模拟。
  const state = {
    current: (options.resumeFails
      ? 'suspended'
      : 'running') as AudioContextState,
    closed: false,
  }
  const context = {
    get state() {
      return state.current
    },
    destination: {},
    createGain(): FakeGain {
      const gain = { gain: { value: 0 }, connect() {}, disconnect() {} }
      gains.push(gain)
      return gain
    },
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} }
    },
    addEventListener() {},
    removeEventListener() {},
    resume() {
      if (options.resumeFails) {
        state.current = 'suspended'
        return Promise.reject(new Error('blocked'))
      }
      state.current = 'running'
      return Promise.resolve()
    },
    close() {
      state.closed = true
      return Promise.resolve()
    },
  }
  return {
    context: context as unknown as AudioContext,
    gains,
    state,
    isClosed: () => state.closed,
  }
}

const track = () => ({ kind: 'audio', id: 'a1' }) as unknown as MediaStreamTrack

function streamOf(audio: MediaStreamTrack | null): MediaStream {
  return {
    getAudioTracks: () => (audio ? [audio] : []),
  } as unknown as MediaStream
}

describe('ViewerAudio', () => {
  it('默认音量不建 AudioContext（保持原生播放）', () => {
    const video = new FakeVideo()
    const fake = fakeContext()
    const snapshots: ViewerAudioSnapshot[] = []
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      (snapshot) => snapshots.push(snapshot),
      2,
      () => fake.context
    )
    audio.bind(streamOf(track()))

    assert.equal(fake.gains.length, 0, '默认不该建增益图')
    assert.equal(video.muted, false)
    assert.equal(video.volume, 1)
    assert.deepEqual(snapshots.at(-1), {
      level: 1,
      muted: false,
      boostAvailable: true,
    })
  })

  it('调离 100% 后接管：元素静音、增益等于请求值', () => {
    const video = new FakeVideo()
    const fake = fakeContext()
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      () => {},
      2,
      () => fake.context
    )
    audio.bind(streamOf(track()))
    audio.setLevel(1.5)

    assert.equal(fake.gains.length, 1)
    assert.equal(fake.gains[0]!.gain.value, 1.5)
    assert.equal(video.muted, true, '接管期间元素必须静音，否则声音播两次')
    assert.equal(video.volume, 1, '元素音量上限仍是 1，超过部分靠增益')
    assert.equal(audio.snapshot.level, 1.5)
    assert.equal(audio.snapshot.muted, false)
  })

  it('静音 / 暂停时增益归零', () => {
    const video = new FakeVideo()
    const fake = fakeContext()
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      () => {},
      2,
      () => fake.context
    )
    audio.bind(streamOf(track()))
    audio.setLevel(2)
    assert.equal(fake.gains[0]!.gain.value, 2)

    audio.setMuted(true)
    assert.equal(fake.gains[0]!.gain.value, 0, '静音必须真的把增益关掉')
    assert.equal(audio.snapshot.muted, true)

    audio.setMuted(false)
    assert.equal(fake.gains[0]!.gain.value, 2)

    video.paused = true
    video.dispatchEvent(new Event('pause'))
    assert.equal(fake.gains[0]!.gain.value, 0, '暂停时不该继续出声')
  })

  it('音量越界按 0–200% 钳制', () => {
    const video = new FakeVideo()
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      () => {},
      2,
      () => fakeContext().context
    )
    audio.setLevel(5)
    assert.equal(audio.snapshot.level, 2)
    audio.setLevel(-1)
    assert.equal(audio.snapshot.level, 0)
    assert.equal(video.muted, true, '音量为 0 等同于静音')
  })

  it('没有 AudioContext 时上限退回 100%', () => {
    const video = new FakeVideo()
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      () => {},
      2
      // 不注入 factory：测试环境没有全局 AudioContext
    )
    assert.equal(audio.snapshot.boostAvailable, false)
    audio.setLevel(1.8)
    assert.equal(audio.snapshot.level, 1, '不支持增益时必须钳到 100%')
    assert.equal(video.volume, 1)
  })

  it('上下文起不来（自动播放策略）就降级回原生', () => {
    const video = new FakeVideo()
    const fake = fakeContext({ resumeFails: true })
    const snapshots: ViewerAudioSnapshot[] = []
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      (snapshot) => snapshots.push(snapshot),
      2,
      () => fake.context
    )
    audio.bind(streamOf(track()))
    audio.setLevel(2)
    // resume 的失败回调是异步的，等一个微任务。
    return Promise.resolve().then(() => {
      assert.equal(
        audio.snapshot.boostAvailable,
        false,
        '失败后不能再宣称支持增益'
      )
      assert.equal(audio.snapshot.level, 1, '音量必须退回 100%，不能骗用户')
      assert.equal(video.muted, false, '降级后回到原生播放')
      assert.equal(snapshots.at(-1)?.boostAvailable, false, '界面要跟着变')
    })
  })

  it('dispose 后把元素还原成用户意图', () => {
    const video = new FakeVideo()
    const fake = fakeContext()
    const audio = new ViewerAudio(
      video as unknown as HTMLVideoElement,
      () => {},
      2,
      () => fake.context
    )
    audio.setLevel(1.5)
    audio.dispose()
    assert.equal(fake.isClosed(), true)
    assert.equal(video.volume, 1)
    assert.equal(video.muted, false)
  })
})
