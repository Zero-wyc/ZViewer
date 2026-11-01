/**
 * NAT 端口预测单测。
 *
 * 这套逻辑的价值全在「赌错也不亏」：预测候选只是**追加**在正常候选后面，
 * 错了 ICE 自己丢掉。所以这里锁的是三件事：
 *  - 只对**同源 + 等差**的 srflx 观测下注（混源会把不同 socket 的偏移当步长）；
 *  - 普通候选必须**立刻**转发，时序不能因为预测被拖慢；
 *  - 预算有界（最多 8 个），不能挤占正常 ICE 的候选额度。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  MAX_NAT_PREDICTION_CANDIDATES,
  NatPredictionCandidateBatch,
  NatPredictionCandidateEmitter,
  candidateSignalOrigin,
  iceServersWithNatPrediction,
  isPredictedCandidateFoundation,
  natPredictionSurveyUrls,
  predictSrflxCandidates,
  type SignalCandidate,
} from '../core/nat-prediction.ts'

/** 造一条 srflx 候选字符串（字段顺序按 RFC 8445）。 */
function srflx(
  port: number,
  overrides: {
    raddr?: string
    rport?: number
    address?: string
    foundation?: string
  } = {}
): string {
  const address = overrides.address ?? '203.0.113.7'
  const foundation = overrides.foundation ?? '842163049'
  return [
    `candidate:${foundation}`,
    '1',
    'udp',
    '1677729535',
    address,
    String(port),
    'typ',
    'srflx',
    'raddr',
    overrides.raddr ?? '192.168.1.5',
    'rport',
    String(overrides.rport ?? 50000),
    'generation',
    '0',
    'ufrag',
    'abcd',
  ].join(' ')
}

function signal(candidate: string, sdpMid = '0'): SignalCandidate {
  return { candidate, sdpMid, sdpMLineIndex: 0, usernameFragment: 'abcd' }
}

describe('candidateSignalOrigin', () => {
  it('spN / smN foundation 是预测候选', () => {
    assert.equal(
      candidateSignalOrigin('candidate:sp1 1 udp 1 1.2.3.4 50000 typ srflx'),
      'predicted'
    )
    assert.equal(
      candidateSignalOrigin('candidate:sm3 1 udp 1 1.2.3.4 50000 typ srflx'),
      'predicted'
    )
  })

  it('普通候选照旧', () => {
    assert.equal(candidateSignalOrigin(srflx(50000)), 'ordinary')
  })

  it('空串/null 是收集结束标记', () => {
    assert.equal(candidateSignalOrigin(''), 'end')
    assert.equal(candidateSignalOrigin('   '), 'end')
    assert.equal(candidateSignalOrigin(null), 'end')
  })

  it('foundation 只有纯 sp/m 形式才算预测（s1、sp、spx 都不算）', () => {
    assert.equal(isPredictedCandidateFoundation('sp1'), true)
    assert.equal(isPredictedCandidateFoundation('sm12'), true)
    assert.equal(isPredictedCandidateFoundation('s1'), false)
    assert.equal(isPredictedCandidateFoundation('sp'), false)
    assert.equal(isPredictedCandidateFoundation('spx'), false)
    assert.equal(isPredictedCandidateFoundation(null), false)
  })
})

describe('natPredictionSurveyUrls', () => {
  const servers: RTCIceServer[] = [
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.cdnbye.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
  ]
  const aux = ['stun:stun.cdnbye.com:3478', 'stun:stun.l.google.com:19302']

  it('恰好两个辅助 + 一个基准，基准取第一个 :3478', () => {
    assert.deepEqual([...natPredictionSurveyUrls(servers, aux)].sort(), [
      'stun:stun.cdnbye.com:3478',
      'stun:stun.l.google.com:19302',
      'stun:stun.miwifi.com:3478',
    ])
  })

  it('辅助数量不是 2 就完全关闭（这个部署没打算做预测）', () => {
    assert.equal(natPredictionSurveyUrls(servers, [aux[0]!]).size, 0)
    assert.equal(natPredictionSurveyUrls(servers, []).size, 0)
    assert.equal(
      natPredictionSurveyUrls(servers, [
        ...aux,
        'stun:stun1.l.google.com:19302',
      ]).size,
      0
    )
  })

  it('非 stun: 与畸形 URL 不计入辅助', () => {
    assert.equal(
      natPredictionSurveyUrls(servers, ['turn:turn.example.com:3478', aux[1]!])
        .size,
      0
    )
  })

  it('URL 归一化：大小写、缺端口（默认 3478）、显式非 3478', () => {
    const set = natPredictionSurveyUrls(
      [
        { urls: 'stun:STUN.miwifi.com' },
        { urls: 'stun:stun.cdnbye.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
      ],
      ['stun:stun.cdnbye.com:3478', 'stun:stun.l.google.com:19302']
    )
    assert.ok(set.has('stun:stun.miwifi.com:3478'), '缺端口要补成 3478')
    assert.ok(set.has('stun:stun.l.google.com:19302'))
  })
})

describe('iceServersWithNatPrediction', () => {
  it('关闭时只做深拷贝，不动列表', () => {
    const servers: RTCIceServer[] = [{ urls: 'stun:stun.miwifi.com:3478' }]
    const copy = iceServersWithNatPrediction(servers, false, [
      'stun:stun.cdnbye.com:3478',
    ])
    assert.deepEqual(copy, servers)
    assert.notEqual(copy, servers)
  })

  it('开启时只追加缺失的辅助，不重复、不改顺序', () => {
    const servers: RTCIceServer[] = [
      { urls: 'stun:stun.miwifi.com:3478' },
      { urls: ['stun:stun.cdnbye.com:3478'] },
    ]
    const merged = iceServersWithNatPrediction(servers, true, [
      'stun:stun.cdnbye.com:3478',
      'stun:stun.l.google.com:19302',
    ])
    assert.equal(merged.length, 3)
    assert.deepEqual(merged[0]!.urls, 'stun:stun.miwifi.com:3478')
    assert.deepEqual(merged[1]!.urls, ['stun:stun.cdnbye.com:3478'])
    assert.deepEqual(merged[2]!.urls, 'stun:stun.l.google.com:19302')
  })
})

describe('predictSrflxCandidates', () => {
  it('三个等差观测 → 上下各 4 个，最多 8 个', () => {
    const predictions = predictSrflxCandidates([
      signal(srflx(50_000)),
      signal(srflx(50_001)),
      signal(srflx(50_002)),
    ])
    assert.equal(predictions.length, MAX_NAT_PREDICTION_CANDIDATES)
    const ports = predictions.map((item) =>
      Number(item.candidate!.split(' ')[5])
    )
    assert.deepEqual(
      ports,
      [50_003, 50_004, 50_005, 50_006, 49_999, 49_998, 49_997, 49_996]
    )
    const foundations = predictions.map((item) => item.candidate!.split(' ')[0])
    assert.deepEqual(foundations, [
      'candidate:sp1',
      'candidate:sp2',
      'candidate:sp3',
      'candidate:sp4',
      'candidate:sm1',
      'candidate:sm2',
      'candidate:sm3',
      'candidate:sm4',
    ])
  })

  it('只有两个观测不下注（两点永远能连成线，那不叫规律）', () => {
    assert.deepEqual(
      predictSrflxCandidates([signal(srflx(50_000)), signal(srflx(50_001))]),
      []
    )
  })

  it('步长不稳定（0 / 负数 / 不等差）→ 拒绝', () => {
    assert.deepEqual(
      predictSrflxCandidates([
        signal(srflx(50_000)),
        signal(srflx(50_002)),
        signal(srflx(50_005)),
      ]),
      []
    )
  })

  it('不同本地 socket（raddr/rport 不同）不能拼成一条序列', () => {
    assert.deepEqual(
      predictSrflxCandidates([
        signal(srflx(50_000, { raddr: '192.168.1.5', rport: 50_000 })),
        signal(srflx(50_001, { raddr: '192.168.1.5', rport: 50_100 })),
        signal(srflx(50_002, { raddr: '192.168.1.6', rport: 50_000 })),
      ]),
      []
    )
  })

  it('不同 m-line 各自成组，凑不满就不预测', () => {
    assert.deepEqual(
      predictSrflxCandidates([
        signal(srflx(50_000), '0'),
        signal(srflx(50_001), '0'),
        signal(srflx(60_000), '1'),
        signal(srflx(60_001), '1'),
      ]),
      []
    )
  })

  it('host / relay 候选不参与推断', () => {
    const host =
      'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host generation 0'
    const relay =
      'candidate:2 1 udp 41885439 203.0.113.7 49152 typ relay raddr 0.0.0.0 rport 0'
    assert.deepEqual(
      predictSrflxCandidates([signal(host), signal(relay), signal(host)]),
      []
    )
  })

  it('保留原候选的其余字段（只改 foundation 与端口）', () => {
    const [first] = predictSrflxCandidates([
      signal(srflx(50_000)),
      signal(srflx(50_001)),
      signal(srflx(50_002)),
    ])
    const fields = first!.candidate!.split(' ')
    assert.equal(fields[2], 'udp')
    assert.equal(fields[4], '203.0.113.7')
    assert.equal(fields[6], 'typ')
    assert.equal(fields[7], 'srflx')
    assert.ok(first!.candidate!.includes('raddr 192.168.1.5'))
  })

  it('端口越界不产出（<1 或 >65535）', () => {
    const predictions = predictSrflxCandidates([
      signal(srflx(1)),
      signal(srflx(2)),
      signal(srflx(3)),
    ])
    const ports = predictions.map((item) =>
      Number(item.candidate!.split(' ')[5])
    )
    assert.ok(ports.every((port) => port >= 1 && port <= 65_535))
  })
})

describe('NatPredictionCandidateBatch', () => {
  it('普通候选立刻转发；凑出规律后预测只发一次', () => {
    const sent: string[] = []
    const batch = new NatPredictionCandidateBatch((candidate) => {
      sent.push(candidate?.candidate ?? 'END')
    })
    batch.add(signal(srflx(50_000))!)
    assert.equal(sent.length, 1, '第一条普通候选必须立刻出去')
    batch.add(signal(srflx(50_001))!)
    assert.equal(sent.length, 2)
    batch.add(signal(srflx(50_002))!)
    // 3 个观测凑出等差数列：这一条普通候选 + 8 条预测。
    assert.equal(sent.length, 3 + MAX_NAT_PREDICTION_CANDIDATES)
    batch.add(signal(srflx(50_003))!)
    // 已经预测过，不再追加。
    assert.equal(sent.length, 4 + MAX_NAT_PREDICTION_CANDIDATES)
    batch.complete()
    assert.equal(sent.at(-1), 'END')
  })

  it('complete 之后再 add 一律丢弃', () => {
    const sent: string[] = []
    const batch = new NatPredictionCandidateBatch((candidate) => {
      sent.push(candidate?.candidate ?? 'END')
    })
    batch.complete()
    batch.add(signal(srflx(50_000))!)
    assert.deepEqual(sent, ['END'])
  })

  it('discard 之后什么都不发', () => {
    const sent: string[] = []
    const batch = new NatPredictionCandidateBatch((candidate) => {
      sent.push(candidate?.candidate ?? 'END')
    })
    batch.discard()
    batch.add(signal(srflx(50_000))!)
    batch.complete()
    assert.deepEqual(sent, [])
  })

  it('非 survey 来源的 srflx 只转发、不当证据', () => {
    const sent: string[] = []
    const batch = new NatPredictionCandidateBatch((candidate) => {
      sent.push(candidate?.candidate ?? 'END')
    })
    batch.add(signal(srflx(50_000))!, false)
    batch.add(signal(srflx(50_001))!, false)
    batch.add(signal(srflx(50_002))!, false)
    assert.equal(sent.length, 3, '一条预测都不该发')
  })
})

/** 造一条「浏览器候选」：`url` 是 survey 判据，`toJSON()` 会丢掉它。 */
function browserCandidate(
  port: number,
  url: string,
  usernameFragment = 'abcd'
): RTCIceCandidate {
  return {
    candidate: srflx(port),
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment,
    url,
  } as unknown as RTCIceCandidate
}

describe('NatPredictionCandidateEmitter', () => {
  const SURVEY = new Set([
    'stun:stun.miwifi.com:3478',
    'stun:stun.cdnbye.com:3478',
    'stun:stun.l.google.com:19302',
  ])
  const sent: string[] = []
  const collect = (candidate: SignalCandidate) => {
    sent.push(candidate?.candidate ?? 'END')
  }

  it('只有 survey 目的地打出来的 srflx 才算证据', () => {
    sent.length = 0
    const emitter = new NatPredictionCandidateEmitter(true, collect, SURVEY)
    // 不在 survey 集合里的目的地：端口 40000 明显偏离序列，且不计入证据。
    emitter.add(browserCandidate(40_000, 'stun:stun.other.example:3478'))
    emitter.add(browserCandidate(50_000, 'stun:stun.miwifi.com:3478'))
    emitter.add(browserCandidate(50_001, 'stun:stun.cdnbye.com:3478'))
    assert.equal(sent.length, 3, '三条普通候选都立刻转发')
    assert.equal(
      sent.filter((candidate) => candidate.startsWith('candidate:sp')).length,
      0,
      '证据只有两条，还凑不出序列'
    )
    emitter.add(browserCandidate(50_002, 'stun:stun.l.google.com:19302'))
    const predicted = sent.filter((candidate) =>
      candidate.startsWith('candidate:sp')
    )
    assert.equal(predicted.length, 4, '第三个 survey 观测到达后往上预测 4 个')
    // 50000/50001/50002 等差 1 → 预测从最高点 50002 往上。
    assert.ok(predicted[0]!.includes(' 50003 '))
  })

  it('关闭时不预测，但普通候选照旧全部转发', () => {
    sent.length = 0
    const emitter = new NatPredictionCandidateEmitter(false, collect, SURVEY)
    emitter.add(browserCandidate(50_000, 'stun:stun.miwifi.com:3478'))
    emitter.add(browserCandidate(50_001, 'stun:stun.cdnbye.com:3478'))
    emitter.add(browserCandidate(50_002, 'stun:stun.l.google.com:19302'))
    assert.equal(sent.length, 3)
  })

  it('ufrag 变化（ICE restart）→ 旧观测作废，新一代重新计数', () => {
    sent.length = 0
    const emitter = new NatPredictionCandidateEmitter(true, collect, SURVEY)
    emitter.add(browserCandidate(50_000, 'stun:stun.miwifi.com:3478', 'gen1'))
    emitter.add(browserCandidate(50_001, 'stun:stun.cdnbye.com:3478', 'gen1'))
    // 换代际：前两条观测不能算进新代际。
    emitter.add(browserCandidate(60_000, 'stun:stun.miwifi.com:3478', 'gen2'))
    emitter.add(browserCandidate(60_001, 'stun:stun.cdnbye.com:3478', 'gen2'))
    assert.equal(
      sent.filter((candidate) => candidate.startsWith('candidate:sp')).length,
      0
    )
    emitter.add(
      browserCandidate(60_002, 'stun:stun.l.google.com:19302', 'gen2')
    )
    const predicted = sent.filter((candidate) =>
      candidate.startsWith('candidate:sp')
    )
    assert.equal(predicted.length, 4)
    assert.ok(predicted[0]!.includes(' 60003 '), '用的是新一代的端口')
  })

  it('gatheringComplete 之后迟到的候选仍照常转发（丢候选比多一个批更糟）', () => {
    sent.length = 0
    const emitter = new NatPredictionCandidateEmitter(true, collect, SURVEY)
    emitter.add(browserCandidate(50_000, 'stun:stun.miwifi.com:3478'))
    emitter.gatheringComplete()
    const afterComplete = sent.length
    emitter.add(browserCandidate(50_001, 'stun:stun.cdnbye.com:3478'))
    assert.equal(sent.length, afterComplete + 1)
  })

  it('结束标记是空候选，由调用方丢弃（线上格式没有 end）', () => {
    sent.length = 0
    const emitter = new NatPredictionCandidateEmitter(true, collect, SURVEY)
    emitter.add(browserCandidate(50_000, 'stun:stun.miwifi.com:3478'))
    emitter.gatheringComplete()
    // 结束标记是「候选字符串为空」，不是 null：Piik 用它把批收口。
    // 调用方（host-peer / viewer-peer）负责丢掉它，线上不发空候选。
    assert.equal(sent.at(-1), '')
  })
})
