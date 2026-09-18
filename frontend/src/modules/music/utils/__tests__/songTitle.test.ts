/**
 * extractSongTitle 单测（node:test 原生运行，node --test）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { extractSongTitle } from '../songTitle.ts'

describe('extractSongTitle', () => {
  it('剥离【】[]（）() 括号标签', () => {
    assert.equal(extractSongTitle('【4K】晴天（Live）[高清]'), '晴天')
  })

  it('保留书名号内的歌名内容', () => {
    assert.equal(extractSongTitle('《晴天》- 周杰伦'), '晴天')
  })

  it('按 - ｜ / 分隔取主段', () => {
    assert.equal(extractSongTitle('晴天 - 周杰伦'), '晴天')
    assert.equal(extractSongTitle('晴天｜周杰伦'), '晴天')
    assert.equal(extractSongTitle('晴天/周杰伦'), '晴天')
    assert.equal(extractSongTitle('晴天／周杰伦'), '晴天')
  })

  it('清洗空格包围的英文画质词与中文版本词', () => {
    assert.equal(extractSongTitle('晴天 1080P 高清 MV'), '晴天')
    assert.equal(extractSongTitle('晴天 官方 完整版'), '晴天')
  })

  it('不误伤含相同字母片段的其他单词', () => {
    // \b 定界：'Live' 不从 'Lively' 中剥出
    assert.equal(extractSongTitle('Lively 晴天'), 'Lively 晴天')
  })

  it('合并多余空白并去除首尾空格', () => {
    assert.equal(extractSongTitle('  晴天   周杰伦  '), '晴天 周杰伦')
  })

  it('空串返回空串', () => {
    assert.equal(extractSongTitle(''), '')
  })
})
