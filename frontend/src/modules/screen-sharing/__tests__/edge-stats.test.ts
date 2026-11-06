/**
 * 多连接统计的汇总口径。
 *
 * 这里断言的不是「求和」，而是每类数字该按哪种方式合并：码率求和、帧率取
 * 最差、受限原因取最严重、中继节点只看入边。这些都是面板上「一句话结论」
 * 的依据，合并错了会得出与现场相反的印象。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateEdgeStats,
  worstState,
  type ShareEdgeStats,
} from '../core/edge-stats.ts'
import { emptyShareStats, type ShareStats } from '../core/stats.ts'

function statsOf(overrides: Partial<ShareStats>): ShareStats {
  return { ...emptyShareStats(), ...overrides }
}

function edge(
  connectionId: string,
  direction: 'inbound' | 'outbound',
  state: RTCPeerConnectionState,
  overrides: Partial<ShareStats>,
  quality?: ShareEdgeStats['quality']
): ShareEdgeStats {
  return {
    connectionId,
    direction,
    state,
    stats: statsOf(overrides),
    quality,
  }
}

test('没有连接时不编造数字', () => {
  const aggregate = aggregateEdgeStats([])
  assert.equal(aggregate.edgeCount, 0)
  assert.equal(aggregate.connectedCount, 0)
  assert.equal(aggregate.connectionState, 'new')
  assert.equal(aggregate.bitrate, null)
  assert.equal(aggregate.frameRate, null)
  assert.equal(aggregate.resolution, null)
  assert.equal(aggregate.windowPacketLossRate, null)
})

test('码率求和，帧率与丢包取最差的一条', () => {
  const aggregate = aggregateEdgeStats([
    edge('a', 'outbound', 'connected', {
      sending: true,
      bitrate: 2_000_000,
      frameRate: 30,
      windowPacketLossRate: 0.001,
      resolution: { width: 1920, height: 1080 },
    }),
    edge('b', 'outbound', 'connected', {
      sending: true,
      bitrate: 1_000_000,
      frameRate: 12,
      windowPacketLossRate: 0.04,
      resolution: { width: 1280, height: 720 },
    }),
  ])

  assert.equal(aggregate.bitrate, 3_000_000)
  // 一位观众掉到 12 fps，面板就该显示 12 fps——平均值会把它藏起来。
  assert.equal(aggregate.frameRate, 12)
  assert.equal(aggregate.windowPacketLossRate, 0.04)
  // 分辨率报源（最大那份），逐条连接里再各自显示自己收到的尺寸。
  assert.deepEqual(aggregate.resolution, { width: 1920, height: 1080 })
  assert.equal(aggregate.connectedCount, 2)
  assert.equal(aggregate.edgeCount, 2)
})

test('中继节点同时有进出边时，码率只算入边', () => {
  const aggregate = aggregateEdgeStats([
    edge('in', 'inbound', 'connected', { receiving: true, bitrate: 2_400_000 }),
    edge('out1', 'outbound', 'connected', {
      sending: true,
      bitrate: 2_400_000,
    }),
    edge('out2', 'outbound', 'connected', {
      sending: true,
      bitrate: 2_400_000,
    }),
  ])
  // 同一路流不该被算三遍：入边才是他真正在收的那份。
  assert.equal(aggregate.bitrate, 2_400_000)
  assert.equal(aggregate.receiving, true)
  assert.equal(aggregate.sending, true)
})

test('累计丢包率按总丢包 / 总发包重算，而不是逐边平均', () => {
  const aggregate = aggregateEdgeStats([
    edge('a', 'inbound', 'connected', {
      packetsReceived: 990,
      packetsLost: 10,
    }),
    edge('b', 'inbound', 'connected', {
      packetsReceived: 9,
      packetsLost: 1,
    }),
  ])
  // 逐边平均会得到 (1% + 10%) / 2 = 5.5%，真实值只有 1.1%。
  assert.equal(aggregate.packetsReceived, 999)
  assert.equal(aggregate.packetsLost, 11)
  assert.ok(Math.abs((aggregate.packetLossRate ?? 0) - 11 / 1010) < 1e-9)
})

test('受限原因取最严重的一档：CPU 压过带宽', () => {
  const aggregate = aggregateEdgeStats([
    edge('a', 'outbound', 'connected', {
      qualityLimitationReason: 'bandwidth',
      encodeMsPerFrame: 6,
    }),
    edge('b', 'outbound', 'connected', {
      qualityLimitationReason: 'cpu',
      encodeMsPerFrame: 22,
    }),
  ])
  assert.equal(aggregate.qualityLimitationReason, 'cpu')
  // 编码耗时是单帧成本，多条边取最慢的那条。
  assert.equal(aggregate.encodeMsPerFrame, 22)
})

test('受限时间占比先累加秒数再归一化', () => {
  const aggregate = aggregateEdgeStats([
    edge('a', 'outbound', 'connected', {
      limitationShare: { none: 8, bandwidth: 2, cpu: 0, other: 0 },
    }),
    edge('b', 'outbound', 'connected', {
      limitationShare: { none: 0, bandwidth: 10, cpu: 0, other: 0 },
    }),
  ])
  const share = aggregate.limitationShare
  assert.ok(share)
  assert.equal(Math.round(share.none), 40)
  assert.equal(Math.round(share.bandwidth), 60)
})

test('出边看不到的丢包与抖动，退回观众回传的那份', () => {
  const aggregate = aggregateEdgeStats([
    edge(
      'a',
      'outbound',
      'connected',
      { sending: true, bitrate: 1_500_000 },
      {
        packetLossRate: 0.08,
        rttMs: 120,
        jitterMs: 35,
        frameRate: 24,
        bitrate: 1_500_000,
        limitation: 'bandwidth',
        packetsLost: 42,
      }
    ),
  ])
  assert.equal(aggregate.windowPacketLossRate, 0.08)
  assert.equal(aggregate.rttMs, 120)
  assert.equal(aggregate.jitterMs, 35)
})

test('有一条连接失败就报失败，不被其余正常连接掩盖', () => {
  assert.equal(
    aggregateEdgeStats([
      edge('a', 'outbound', 'connected', {}),
      edge('b', 'outbound', 'failed', {}),
    ]).connectionState,
    'failed'
  )
  assert.equal(
    aggregateEdgeStats([
      edge('a', 'outbound', 'connected', {}),
      edge('b', 'outbound', 'connecting', {}),
    ]).connectionState,
    'connecting'
  )
  assert.equal(worstState([]), 'new')
  assert.equal(worstState(['connected', 'connected']), 'connected')
})

test('音频取一条就够，不叠加', () => {
  const audio = {
    receiving: false,
    sending: true,
    bitrate: 128_000,
    packetLossRate: null,
    jitterMs: null,
    level: null,
    concealmentRate: null,
    jitterBufferMs: null,
  }
  const aggregate = aggregateEdgeStats([
    edge('a', 'outbound', 'connected', { sending: true, audio }),
    edge('b', 'outbound', 'connected', { sending: true, audio }),
  ])
  assert.equal(aggregate.audio?.bitrate, 128_000)
})
