import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAnswerPayload,
  ownSendMid,
  peerOfPublication,
  publicationOf,
  type VoiceDescription,
} from '../lib/protocol.ts'

/** 造一份 offer：两条我收的（服务端 sendonly）+ 一条我发的（服务端 recvonly）。 */
function offer(
  tracks: Array<{ mid: string; publicationId: string }>
): VoiceDescription {
  return { revision: 7, sdp: { type: 'offer', sdp: 'v=0' }, tracks }
}

describe('publicationOf / peerOfPublication', () => {
  it('派生与解析互逆', () => {
    assert.equal(publicationOf('abc'), 'voice_abc')
    assert.equal(peerOfPublication('voice_abc'), 'abc')
  })

  it('不是本方案的发布返回 null', () => {
    assert.equal(peerOfPublication('something_else'), null)
    assert.equal(peerOfPublication(''), null)
  })
})

describe('ownSendMid', () => {
  const description = offer([
    { mid: '0', publicationId: 'voice_alice' },
    { mid: '1', publicationId: 'voice_me' },
    { mid: '2', publicationId: 'voice_bob' },
  ])

  it('按 publicationId 认自己那条，不按顺序猜', () => {
    assert.equal(ownSendMid(description, 'me'), '1')
  })

  it('自己不在 offer 里时返回空串（不猜第一条）', () => {
    assert.equal(ownSendMid(description, 'carol'), '')
  })

  it('还不知道自己是谁时返回空串', () => {
    assert.equal(ownSendMid(description, null), '')
  })
})

describe('buildAnswerPayload', () => {
  const description = offer([{ mid: '1', publicationId: 'voice_me' }])

  it('原样带回 offer 的 revision（服务端拿它判过期）', () => {
    const payload = buildAnswerPayload({
      description,
      sdp: 'v=0 answer',
      selfPeerID: 'me',
      sendMid: '1',
      bound: true,
    })
    assert.equal(payload.revision, 7)
    assert.equal(payload.sdp.type, 'answer')
    assert.equal(payload.sdp.sdp, 'v=0 answer')
  })

  it('挂上麦克风后 tracks 只列自己那一条', () => {
    const payload = buildAnswerPayload({
      description,
      sdp: 'v=0',
      selfPeerID: 'me',
      sendMid: '1',
      bound: true,
    })
    assert.deepEqual(payload.tracks, [{ mid: '1', publicationId: 'voice_me' }])
  })

  it('麦克风没挂上就不声明在发（否则服务端会建一条永远没数据的发布）', () => {
    const payload = buildAnswerPayload({
      description,
      sdp: 'v=0',
      selfPeerID: 'me',
      sendMid: '1',
      bound: false,
    })
    assert.deepEqual(payload.tracks, [])
  })

  it('找不到自己的 m-line 时也不声明', () => {
    const payload = buildAnswerPayload({
      description,
      sdp: 'v=0',
      selfPeerID: 'me',
      sendMid: '',
      bound: true,
    })
    assert.deepEqual(payload.tracks, [])
  })
})
