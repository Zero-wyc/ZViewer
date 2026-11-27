/**
 * 连接日志的纯逻辑：候选摘要、选中候选对、长度上限。
 *
 * 这些字符串是观众报障时唯一能贴出来的东西，格式必须稳定；测试盯的就是
 * 「host/srflx 有没有标出来」「RTT 单位对不对」「日志会不会无限增长」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONNECTION_LOG_LIMIT,
  appendConnectionLog,
  describeCandidate,
  describeSelectedPair,
  type ConnectionLogEntry,
} from '../connection-log.ts'

function fakeReport(entries: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map(entries.map((entry) => [String(entry.id), entry]))
  return map as unknown as RTCStatsReport
}

test('候选摘要标出类型、协议与地址', () => {
  assert.equal(
    describeCandidate({
      type: 'srflx',
      protocol: 'udp',
      address: '203.0.113.5',
      port: 54321,
    }),
    'srflx/udp 203.0.113.5:54321'
  )
  // 没有协议时不能留一个尾随的斜杠
  assert.equal(describeCandidate({ type: 'host' }), 'host')
  assert.equal(
    describeCandidate({ address: '10.0.0.2', port: 5000 }),
    '10.0.0.2:5000'
  )
  // 拿不到任何字段时返回 null：调用方据此跳过，别记空行
  assert.equal(describeCandidate({}), null)
  assert.equal(describeCandidate(null), null)
})

test('选中候选对取 transport 指向的那一条', () => {
  const report = fakeReport([
    { id: 'T01', type: 'transport', selectedCandidatePairId: 'CP1' },
    {
      id: 'CP1',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'L1',
      remoteCandidateId: 'R1',
      currentRoundTripTime: 0.032,
    },
    {
      id: 'L1',
      type: 'local-candidate',
      candidateType: 'srflx',
      protocol: 'udp',
      address: '203.0.113.5',
      port: 54321,
    },
    {
      id: 'R1',
      type: 'remote-candidate',
      candidateType: 'host',
      protocol: 'udp',
      address: '198.51.100.7',
      port: 60000,
    },
  ])

  assert.deepEqual(describeSelectedPair(report), {
    local: 'srflx/udp 203.0.113.5:54321',
    remote: 'host/udp 198.51.100.7:60000',
    // stats 里是秒，日志里统一成毫秒
    rttMs: 32,
  })
})

test('没有 transport 时退回 nominated + succeeded 的候选对', () => {
  const report = fakeReport([
    {
      id: 'CP1',
      type: 'candidate-pair',
      state: 'succeeded',
      nominated: true,
      localCandidateId: 'L1',
      remoteCandidateId: 'R1',
    },
    {
      id: 'L1',
      type: 'local-candidate',
      candidateType: 'relay',
      protocol: 'udp',
      address: '203.0.113.9',
      port: 40000,
    },
    {
      id: 'R1',
      type: 'remote-candidate',
      candidateType: 'relay',
      protocol: 'udp',
      address: '203.0.113.10',
      port: 40001,
    },
  ])

  const pair = describeSelectedPair(report)
  assert.equal(pair?.local, 'relay/udp 203.0.113.9:40000')
  assert.equal(pair?.remote, 'relay/udp 203.0.113.10:40001')
  // 没有 RTT 字段时留 null，不要写成 0（0ms 会被误读成「完美」）
  assert.equal(pair?.rttMs, null)
})

test('刚 connected 时 stats 还没补齐，返回 null 而不是半条记录', () => {
  assert.equal(describeSelectedPair(null), null)
  assert.equal(describeSelectedPair(fakeReport([])), null)
  assert.equal(
    describeSelectedPair(
      fakeReport([{ id: 'CP1', type: 'candidate-pair', state: 'in-progress' }])
    ),
    null
  )
})

test('日志长度压在上限内，且保留最新的一条', () => {
  let entries: ConnectionLogEntry[] = []
  const total = CONNECTION_LOG_LIMIT + 5
  for (let index = 0; index < total; index += 1) {
    entries = appendConnectionLog(entries, {
      id: index + 1,
      at: index,
      level: 'info',
      message: 'x',
    })
  }
  assert.equal(entries.length, CONNECTION_LOG_LIMIT)
  assert.equal(entries[entries.length - 1]?.id, total)
  // 最早那几条应该被挤掉
  assert.equal(entries[0]?.id, total - CONNECTION_LOG_LIMIT + 1)
})
