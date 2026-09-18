/**
 * filterByBlockWords / decorateRegionItems / getRegionRules 单测
 * （node:test 原生运行，node --test）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  decorateRegionItems,
  filterByBlockWords,
  getRegionRules,
} from '../biliRegionFilter.ts'
import type { BilibiliVideoItem } from '../../../bilibili/bilibiliApi'
import type { BlockWord, RegionTagEntry } from '../biliRegionFilter.ts'

const item = (title: string, tag?: string): BilibiliVideoItem => ({
  bvid: `BV${Math.random().toString(36).slice(2, 10)}`,
  title,
  pic: '',
  duration: 100,
  upName: 'up',
  tag,
})

describe('filterByBlockWords', () => {
  it('空词表原样返回（同一引用，不做无谓拷贝）', () => {
    const list = [item('晴天')]
    assert.strictEqual(filterByBlockWords(list, []), list)
  })

  it('scope=both 命中标题即剔除', () => {
    const words: BlockWord[] = [{ word: '广告', scope: 'both' }]
    const out = filterByBlockWords([item('晴天 广告'), item('晴天')], words)
    assert.deepEqual(
      out.map((i) => i.title),
      ['晴天']
    )
  })

  it('scope=title 只匹配标题、不误伤 tag 命中的条目', () => {
    const words: BlockWord[] = [{ word: 'remix', scope: 'title' }]
    const out = filterByBlockWords(
      [item('晴天 remix'), item('晴天', 'remix cover')],
      words
    )
    assert.deepEqual(
      out.map((i) => i.title),
      ['晴天']
    )
  })

  it('scope=tag 只匹配标签、不误伤仅标题命中的条目', () => {
    const words: BlockWord[] = [{ word: 'cover', scope: 'tag' }]
    const out = filterByBlockWords(
      [item('晴天', 'cover live'), item('cover 翻唱', '晴天')],
      words
    )
    assert.deepEqual(
      out.map((i) => i.title),
      ['cover 翻唱']
    )
  })

  it('匹配不区分大小写', () => {
    const words: BlockWord[] = [{ word: 'REMIX', scope: 'title' }]
    const out = filterByBlockWords([item('晴天 Remix')], words)
    assert.deepEqual(out, [])
  })

  it('tag 缺省的条目按空标签处理不崩溃', () => {
    const words: BlockWord[] = [{ word: 'x', scope: 'both' }]
    const out = filterByBlockWords([item('晴天')], words)
    assert.deepEqual(
      out.map((i) => i.title),
      ['晴天']
    )
  })
})

describe('getRegionRules', () => {
  it('未自定义规则时回退为分类名单个「搜索」聚合词', () => {
    const rules = getRegionRules({ name: '华语音乐' })
    assert.deepEqual(rules, [
      { word: '华语音乐', source: 'search', role: 'aggregate' },
    ])
  })

  it('自定义规则原样返回', () => {
    const rules = getRegionRules({
      name: 'x',
      tags: [{ word: 'cover', source: 'both', role: 'require' }],
    })
    assert.equal(rules.length, 1)
    assert.equal(rules[0].role, 'require')
  })
})

describe('decorateRegionItems', () => {
  it('require 限定词：视频 tag 必须包含全部限定词', () => {
    const tag: RegionTagEntry = {
      name: 'x',
      tags: [
        { word: 'cover', source: 'search', role: 'require' },
        { word: 'live', source: 'search', role: 'require' },
      ],
    }
    const out = decorateRegionItems(
      [
        item('a', 'cover live'),
        item('b', 'cover'),
        item('c', 'live cover studio'),
        item('d'),
      ],
      tag,
      []
    )
    assert.deepEqual(
      out.map((i) => i.title),
      ['a', 'c']
    )
  })

  it('分区屏蔽词与全局屏蔽词叠加生效', () => {
    const tag: RegionTagEntry = {
      name: 'x',
      blockWords: [{ word: '预告', scope: 'title' }],
    }
    const global: BlockWord[] = [{ word: '广告', scope: 'both' }]
    const out = decorateRegionItems(
      [
        item('晴天'),
        item('晴天 预告'),
        item('游戏 广告'),
        item('广告 素材', '晴天'),
      ],
      tag,
      global
    )
    assert.deepEqual(
      out.map((i) => i.title),
      ['晴天']
    )
  })

  it('无 require 规则时仅做屏蔽词过滤', () => {
    const tag: RegionTagEntry = {
      name: '华语音乐',
      tags: [{ word: '华语音乐', source: 'search', role: 'aggregate' }],
    }
    const out = decorateRegionItems([item('晴天'), item('垃圾广告')], tag, [
      { word: '广告', scope: 'both' },
    ])
    assert.deepEqual(
      out.map((i) => i.title),
      ['晴天']
    )
  })
})
