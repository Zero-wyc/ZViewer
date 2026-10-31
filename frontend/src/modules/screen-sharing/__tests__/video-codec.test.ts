/**
 * SDP 归一化单测。
 *
 * 这一层存在的唯一原因：Firefox 房主 + Chromium 观众时，被排除编码的
 * `a=fmtp` 行会残留在 offer 里，Chromium 解析整份 SDP 失败，症状是
 * 「换浏览器就连不上」而两端日志都没有明显错误。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeVideoOfferSdp } from '../core/video-codec.ts'

const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
  'a=rtpmap:96 H264/90000',
  'a=fmtp:96 packetization-mode=1',
  'a=rtcp-fb:96 nack',
  'a=rtpmap:97 VP8/90000',
  'a=fmtp:97 profile-id=0',
  'a=rtcp-fb:97 nack',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10',
  '',
].join('\r\n')

describe('normalizeVideoOfferSdp', () => {
  it('没有残留属性时原样返回（不做无意义重排）', () => {
    assert.equal(normalizeVideoOfferSdp(OFFER), OFFER)
  })

  it('删掉被排除编码的 fmtp 与 rtcp-fb 行', () => {
    const trimmed = OFFER.replace(' 97', '')
    const normalized = normalizeVideoOfferSdp(trimmed)
    assert.ok(!normalized.includes('a=fmtp:97'))
    assert.ok(!normalized.includes('a=rtcp-fb:97'))
    // 保留下来的编码属性不能被误删。
    assert.ok(normalized.includes('a=fmtp:96 packetization-mode=1'))
    assert.ok(normalized.includes('a=rtcp-fb:96 nack'))
  })

  it('音频段不受影响（音频编码不参与视频偏好）', () => {
    const trimmed = OFFER.replace(' 97', '')
    const normalized = normalizeVideoOfferSdp(trimmed)
    assert.ok(normalized.includes('a=fmtp:111 minptime=10'))
  })

  it('保留原有的 CRLF 行尾', () => {
    const trimmed = OFFER.replace(' 97', '')
    assert.ok(normalizeVideoOfferSdp(trimmed).includes('\r\n'))
  })

  it('LF 行尾的 SDP 保持 LF', () => {
    const lf = OFFER.replace(' 97', '').replace(/\r\n/g, '\n')
    const normalized = normalizeVideoOfferSdp(lf)
    assert.ok(!normalized.includes('\r\n'))
    assert.ok(normalized.split('\n').length > 5)
  })

  it('非视频段里的同号属性不会被误删', () => {
    // m=audio 段没有 payload 集合，属性一律保留。
    const audioOnly = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10',
      '',
    ].join('\r\n')
    assert.equal(normalizeVideoOfferSdp(audioOnly), audioOnly)
  })
})
