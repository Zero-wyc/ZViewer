/**
 * mergeLyrics 单测（node:test 原生运行，node --test）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mergeLyrics } from '../lrc.ts'

describe('mergeLyrics', () => {
  it('解析 [mm:ss.xx] 时间标签并按时间升序排列', () => {
    const lines = mergeLyrics('[01:02.50]world\n[00:01.00]hello')
    assert.equal(lines.length, 2)
    assert.equal(lines[0].time, 1)
    assert.equal(lines[0].text, 'hello')
    assert.equal(lines[1].time, 62.5)
    assert.equal(lines[1].text, 'world')
  })

  it('行首多时间标签展开为多行', () => {
    const lines = mergeLyrics('[00:01.0][00:05.0]chorus')
    assert.deepEqual(
      lines.map((l) => [l.time, l.text]),
      [
        [1, 'chorus'],
        [5, 'chorus'],
      ]
    )
  })

  it('过滤元数据标签行与空文本行', () => {
    const lines = mergeLyrics('[ti:测试]\n[ar:某歌手]\n\n[00:01.00]hi')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].text, 'hi')
  })

  it('毫秒按位数右补零（.5 → 500ms）', () => {
    const lines = mergeLyrics('[00:01.5]a\n[00:02.50]b\n[00:03.500]c')
    assert.deepEqual(
      lines.map((l) => l.time),
      [1.5, 2.5, 3.5]
    )
  })

  it('翻译按时间戳合并到原文行（容差内）', () => {
    const lines = mergeLyrics('[00:01.00]hello', '[00:01.00]你好')
    assert.equal(lines[0].translation, '你好')
  })

  it('翻译时间戳超出 50ms 容差不合并', () => {
    const lines = mergeLyrics('[00:01.00]hello', '[00:01.20]你好')
    assert.equal(lines[0].translation, undefined)
  })

  it('同一原文行匹配多条翻译时以 " / " 拼接', () => {
    const lines = mergeLyrics(
      '[00:01.00]hello',
      '[00:01.00]你好\n[00:01.04]哈罗'
    )
    assert.equal(lines[0].translation, '你好 / 哈罗')
  })

  it('罗马音与翻译各自合并且互不干扰', () => {
    const lines = mergeLyrics(
      '[00:01.00]hello',
      '[00:01.00]你好',
      '[00:01.00]ha-lou'
    )
    assert.equal(lines[0].translation, '你好')
    assert.equal(lines[0].roman, 'ha-lou')
  })

  it('空输入返回空数组', () => {
    assert.deepEqual(mergeLyrics(''), [])
  })
})
