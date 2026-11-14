import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseExpressions } from '../core/model-meta.ts'

// 表情清单的解析：这里只测纯函数，网络与缓存由调用方负责。
//
// 关键约定是「按下标寻址」——名字可以空、可以重名，下标必须稳定，
// 否则各端播的就不是同一个表情。

test('按 model3.json 的顺序给出下标', () => {
  const list = parseExpressions({
    FileReferences: {
      Expressions: [{ Name: '笑' }, { Name: '哭' }, { Name: '' }],
    },
  })
  assert.deepEqual(
    list.map((item) => item.index),
    [0, 1, 2]
  )
  assert.equal(list[0].name, '笑')
  // 空名字原样返回空串，显示兜底交给渲染期
  assert.equal(list[2].name, '')
})

test('没有表情字段时返回空数组', () => {
  assert.deepEqual(parseExpressions({}), [])
  assert.deepEqual(parseExpressions({ FileReferences: {} }), [])
  assert.deepEqual(parseExpressions(null), [])
  assert.deepEqual(parseExpressions('nonsense'), [])
  assert.deepEqual(
    parseExpressions({ FileReferences: { Expressions: {} } }),
    []
  )
})

test('名字不是字符串时按空处理，但下标保留', () => {
  const list = parseExpressions({
    FileReferences: { Expressions: [{ Name: 42 }, {}, { Name: '  ' }] },
  })
  assert.equal(list.length, 3)
  assert.deepEqual(
    list.map((item) => item.name),
    ['', '', '']
  )
})
