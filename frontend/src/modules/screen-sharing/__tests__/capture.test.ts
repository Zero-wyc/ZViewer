/**
 * 采集选项的纯函数部分。
 *
 * 只测 `displayMediaOptions`：它决定了「不共享系统声」时到底向浏览器要什么，
 * 而这个选择一旦要求了音频再丢掉，浏览器的共享选择器仍会显示声音开关，
 * 用户会以为自己勾上了。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { displayMediaOptions } from '../core/capture-options.ts'

describe('displayMediaOptions', () => {
  it('默认请求系统声，并要求不做语音处理', () => {
    const options = displayMediaOptions({ width: 1920 }) as Record<
      string,
      unknown
    >
    assert.equal(options.systemAudio, 'include')
    assert.equal(options.windowAudio, 'window')
    const audio = options.audio as Record<string, unknown>
    assert.equal(audio.echoCancellation, false)
    assert.equal(audio.noiseSuppression, false)
    assert.equal(audio.autoGainControl, false)
    // 音乐/系统声要立体声，单声道会被下混。
    assert.deepEqual(audio.channelCount, { ideal: 2 })
  })

  it('不共享系统声时完全不请求音频', () => {
    const options = displayMediaOptions({ width: 1920 }, false) as Record<
      string,
      unknown
    >
    assert.equal(options.audio, false)
    assert.equal(options.systemAudio, undefined)
    assert.deepEqual(options.video, { width: 1920 })
  })
})
