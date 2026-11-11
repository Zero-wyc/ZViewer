import test from 'node:test'
import assert from 'node:assert/strict'
import {
  bilibiliLiveRoomUrl,
  extractLiveRoomId,
  isBilibiliLiveUrl,
} from '../live.ts'

/**
 * 直播间链接识别的边界。
 *
 * 与后端 internal/bilibili/live.go 的 liveRoomPattern 保持同一套规则：
 * 「添加影片」面板、播放解析、后端取流三处必须对同一串输入得出同一个房间号，
 * 否则会出现「能添加但播不了」这种最难排查的错位。
 */
test('extractLiveRoomId 支持常见直播间链接形态', () => {
  const cases: Array<[string, number]> = [
    ['https://live.bilibili.com/32153039', 32153039],
    [
      'https://live.bilibili.com/32153039?broadcast_type=0&is_room_feed=1',
      32153039,
    ],
    ['https://live.bilibili.com/blanc/21452505', 21452505],
    ['https://live.bilibili.com/h5/1234/', 1234],
    ['http://live.bilibili.com/6', 6],
    ['  https://live.bilibili.com/27351537  ', 27351537],
  ]
  for (const [input, want] of cases) {
    assert.equal(extractLiveRoomId(input), want, input)
  }
})

test('extractLiveRoomId 不把点播/个人页误判为直播间', () => {
  const inputs = [
    'https://www.bilibili.com/video/BV1xx411c7mD',
    'https://www.bilibili.com/bangumi/play/ep123',
    'https://space.bilibili.com/12345',
    'https://live.bilibili.com/p/eden/area-tags',
    'https://live.bilibili.com/',
    'BV1xx411c7mD',
    '12345',
    '',
  ]
  for (const input of inputs) {
    assert.equal(extractLiveRoomId(input), 0, input)
  }
})

test('isBilibiliLiveUrl 与 bilibiliLiveRoomUrl 往返一致', () => {
  assert.equal(isBilibiliLiveUrl('https://live.bilibili.com/123'), true)
  assert.equal(
    isBilibiliLiveUrl('https://www.bilibili.com/video/BV1xx411c7mD'),
    false
  )

  const canonical = bilibiliLiveRoomUrl(32153039)
  assert.equal(canonical, 'https://live.bilibili.com/32153039')
  assert.equal(extractLiveRoomId(canonical), 32153039)
})
