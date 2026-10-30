/**
 * pickBiliPartMeta 单测（node:test 原生运行，node --test）。
 *
 * 规则来源：一起听里 B站 多分P视频必须按分P名展示（合集里每个 P 一首歌），
 * 单 P 视频没有更细的名字，保留视频标题。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeBiliPages, pickBiliPartMeta } from '../biliPartName.ts'

const view = {
  title: '【Hi-Res无损音质】盘点华语经典100首',
  pages: [
    { page: 1, cid: 101, part: '01 周杰伦 - 晴天', duration: 270 },
    { page: 7, cid: 107, part: '07 周杰伦 - 夜曲', duration: 227 },
  ],
}

describe('pickBiliPartMeta', () => {
  it('单分P视频保留视频标题，不塞 album', () => {
    const meta = pickBiliPartMeta(
      { title: '【4K】晴天', pages: [{ page: 1, cid: 9, part: '晴天 MV' }] },
      9,
      '【4K】晴天'
    )
    assert.equal(meta.name, '【4K】晴天')
    assert.equal(meta.album, '')
    assert.equal(meta.multiPart, false)
  })

  it('多分P按 cid 取分P名，album 放合集标题', () => {
    const meta = pickBiliPartMeta(view, 107, '视频标题兜底')
    assert.equal(meta.name, '07 周杰伦 - 夜曲')
    assert.equal(meta.album, '【Hi-Res无损音质】盘点华语经典100首')
    assert.equal(meta.durationSec, 227)
    assert.equal(meta.multiPart, true)
  })

  it('cid 缺省时取第一个分P', () => {
    const meta = pickBiliPartMeta(view, 0, '视频标题兜底')
    assert.equal(meta.name, '01 周杰伦 - 晴天')
    assert.equal(meta.durationSec, 270)
  })

  it('分P名为空时退化为「标题 · P<序号>」', () => {
    const meta = pickBiliPartMeta(
      {
        title: '合集',
        pages: [
          { page: 1, cid: 1, part: '第一首' },
          { page: 2, cid: 2, part: '  ' },
        ],
      },
      2,
      '兜底'
    )
    assert.equal(meta.name, '合集 · P2')
  })

  it('cid 不在分P列表时回退标题，但仍标记多分P（时长不拿总时长兜底）', () => {
    const meta = pickBiliPartMeta(view, 999, '视频标题兜底')
    assert.equal(meta.name, '视频标题兜底')
    assert.equal(meta.album, '【Hi-Res无损音质】盘点华语经典100首')
    assert.equal(meta.multiPart, true)
    assert.equal(meta.durationSec, 0)
  })

  it('详情缺失或分P非法时按单P处理', () => {
    assert.deepEqual(pickBiliPartMeta(null, 107, '兜底'), {
      name: '兜底',
      album: '',
      durationSec: 0,
      multiPart: false,
    })
    const broken = pickBiliPartMeta(
      {
        title: 't',
        pages: [
          { page: 1, cid: 0 },
          { page: 2, cid: -1 },
        ],
      },
      0,
      '兜底'
    )
    assert.equal(broken.name, '兜底')
    assert.equal(broken.multiPart, false)
  })

  it('分P按 page 升序取首P（接口顺序不可信）', () => {
    const meta = pickBiliPartMeta(
      {
        title: 't',
        pages: [
          { page: 3, cid: 30, part: '第三首' },
          { page: 1, cid: 10, part: '第一首' },
        ],
      },
      0,
      '兜底'
    )
    assert.equal(meta.name, '第一首')
  })

  it('单P时长：分P自身时长优先，缺失时用视频总时长兜底', () => {
    const fromPage = pickBiliPartMeta(
      {
        title: 't',
        duration: 400,
        pages: [{ page: 1, cid: 1, duration: 212 }],
      },
      1,
      '标题'
    )
    assert.equal(fromPage.durationSec, 212)
    const fromVideo = pickBiliPartMeta(
      { title: 't', duration: 400, pages: [{ page: 1, cid: 1 }] },
      1,
      '标题'
    )
    assert.equal(fromVideo.durationSec, 400)
  })

  it('传入已归一化的分P列表时结果与内部归一化一致', () => {
    const normalized = normalizeBiliPages(view)
    assert.deepEqual(
      pickBiliPartMeta(view, 107, '兜底', normalized),
      pickBiliPartMeta(view, 107, '兜底')
    )
  })
})

describe('normalizeBiliPages', () => {
  it('剔除非法 cid、按 cid 去重、按 page 升序', () => {
    const pages = normalizeBiliPages({
      pages: [
        { page: 3, cid: 30, part: 'c' },
        { page: 1, cid: 10, part: 'a' },
        { page: 1, cid: 10, part: 'a 重复' },
        { page: 2, cid: 0 },
        { page: 4, cid: -5 },
      ],
    })
    assert.deepEqual(
      pages.map((p) => p.cid),
      [10, 30]
    )
  })

  it('空详情返回空数组', () => {
    assert.deepEqual(normalizeBiliPages(null), [])
    assert.deepEqual(normalizeBiliPages({ pages: null }), [])
  })
})
