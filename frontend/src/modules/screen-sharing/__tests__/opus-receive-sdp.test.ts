/**
 * Opus 接收上限改写：只碰音频段的 Opus fmtp，别的原样保留。
 *
 * 这条补丁是中继模式能不能出声的关键——浏览器生成的 answer 不带
 * `maxaveragebitrate`，服务端会按 32kbps 判「带不动共享音频」。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OPUS_RECEIVE_MAX_BITRATE,
  preferOpusReceiveLimit,
} from '../core/opus-receive-sdp.ts'

const ANSWER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'c=IN IP4 0.0.0.0',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 VP8/90000',
].join('\r\n')

const opusFmtp = (sdp: string): string => {
  const line = sdp.split(/\r\n/).find((item) => item.startsWith('a=fmtp:111'))
  assert.ok(line, '应有 opus 的 fmtp 行')
  return line!
}

describe('preferOpusReceiveLimit', () => {
  it('给已有 fmtp 追加接收上限，原参数保留', () => {
    const line = opusFmtp(preferOpusReceiveLimit(ANSWER))
    assert.match(line, /minptime=10/)
    assert.match(line, /useinbandfec=1/)
    assert.match(
      line,
      new RegExp(`maxaveragebitrate=${OPUS_RECEIVE_MAX_BITRATE}`)
    )
  })

  it('已有 maxaveragebitrate 时覆盖而不是重复', () => {
    const sdp = ANSWER.replace(
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=fmtp:111 minptime=10;maxaveragebitrate=32000'
    )
    const line = opusFmtp(preferOpusReceiveLimit(sdp))
    assert.equal(line.match(/maxaveragebitrate=/g)?.length, 1)
    assert.match(
      line,
      new RegExp(`maxaveragebitrate=${OPUS_RECEIVE_MAX_BITRATE}`)
    )
  })

  it('没有 fmtp 行时补一条，紧跟 rtpmap', () => {
    const sdp = ANSWER.replace('a=fmtp:111 minptime=10;useinbandfec=1\r\n', '')
    const result = preferOpusReceiveLimit(sdp)
    const lines = result.split(/\r\n/)
    const rtpIndex = lines.indexOf('a=rtpmap:111 opus/48000/2')
    assert.ok(rtpIndex >= 0)
    assert.equal(
      lines[rtpIndex + 1],
      `a=fmtp:111 maxaveragebitrate=${OPUS_RECEIVE_MAX_BITRATE}`
    )
  })

  it('不碰视频段：video 里的 payload 编号与音频独立', () => {
    const sdp = ANSWER.replace(
      'a=rtpmap:96 VP8/90000',
      'a=rtpmap:96 VP8/90000\r\na=fmtp:96 max-fs=12288'
    )
    const result = preferOpusReceiveLimit(sdp)
    assert.match(result, /a=fmtp:96 max-fs=12288/)
    assert.doesNotMatch(result, /a=fmtp:96 max-fs=12288;maxaveragebitrate/)
  })

  it('非 Opus 的音频编码不动', () => {
    const sdp = ANSWER.replace('opus/48000/2', 'PCMU/8000')
    assert.equal(preferOpusReceiveLimit(sdp), sdp)
  })

  it('空 SDP 与非法码率原样返回', () => {
    assert.equal(preferOpusReceiveLimit(''), '')
    assert.equal(preferOpusReceiveLimit(ANSWER, 0), ANSWER)
  })

  it('改完仍是合法 SDP 结构（行数只多不少）', () => {
    const result = preferOpusReceiveLimit(ANSWER)
    assert.ok(result.split(/\r\n/).length >= ANSWER.split(/\r\n/).length)
    assert.ok(result.startsWith('v=0\r\n'))
  })
})
