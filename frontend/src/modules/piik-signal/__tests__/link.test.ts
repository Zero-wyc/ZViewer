/**
 * 房间连接的复用与引用计数。
 *
 * 这条规则的来由很具体：Piik 每个房间只认一个 host 连接，共享与语音各开
 * 一条会撞 `HOST_ALREADY_CONNECTED`，语音直接不可用。复用之后又必须保证
 * 「一边停了另一边不能断」，否则关掉共享会把还开着的语音一起掐掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireLink, linkKey, resetLinks } from '../link.ts'
import type { PiikSignalClient, PiikSignalHandlers } from '../client.ts'

class FakeClient {
  stopped = false
  listeners: Array<(message: unknown) => void> = []
  statusListeners: Array<(status: string) => void> = []

  subscribe(handlers: PiikSignalHandlers): () => void {
    this.listeners.push(handlers.onMessage as (message: unknown) => void)
    if (handlers.onStatus) {
      this.statusListeners.push(handlers.onStatus as (status: string) => void)
    }
    return () => {
      this.listeners = this.listeners.filter(
        (item) => item !== (handlers.onMessage as unknown)
      )
    }
  }

  stop(): void {
    this.stopped = true
  }

  emit(message: unknown): void {
    for (const listener of this.listeners) listener(message)
  }
}

const handlers = (tag: string, seen: string[]): PiikSignalHandlers => ({
  onMessage: () => seen.push(tag),
})

test('同房间第二次取到的是同一条连接', () => {
  resetLinks()
  const created: FakeClient[] = []
  const make = () => {
    const client = new FakeClient()
    created.push(client)
    return client as unknown as PiikSignalClient
  }
  const first = acquireLink('room:1', handlers('share', []), make)
  const second = acquireLink('room:1', handlers('voice', []), make)

  assert.equal(created.length, 1, '只应建一条连接')
  assert.equal(first.client, second.client)
  first.release()
  second.release()
})

test('两个订阅者都能收到消息', () => {
  resetLinks()
  const seen: string[] = []
  // 真实客户端的构造函数会把 handlers 注册进去，假件用 subscribe 等价表达。
  const make = (initial: PiikSignalHandlers) => {
    const client = new FakeClient()
    client.subscribe(initial)
    return client as unknown as PiikSignalClient
  }
  const share = acquireLink('room:2', handlers('share', seen), make)
  const voice = acquireLink('room:2', handlers('voice', seen), make)

  ;(share.client as unknown as FakeClient).emit({ type: 'route-update' })
  assert.deepEqual(seen.sort(), ['share', 'voice'])
  share.release()
  voice.release()
})

test('还有一方持有时不断连接，归零才断', () => {
  resetLinks()
  const make = () => new FakeClient() as unknown as PiikSignalClient
  const share = acquireLink('room:3', handlers('share', []), make)
  const voice = acquireLink('room:3', handlers('voice', []), make)
  const client = share.client as unknown as FakeClient

  share.release()
  assert.equal(client.stopped, false, '语音还开着，连接不能断')

  voice.release()
  assert.equal(client.stopped, true, '引用归零后应当断连')
})

test('重复 release 不会把别人的引用一起减掉', () => {
  resetLinks()
  const make = () => new FakeClient() as unknown as PiikSignalClient
  const share = acquireLink('room:4', handlers('share', []), make)
  const voice = acquireLink('room:4', handlers('voice', []), make)
  const client = share.client as unknown as FakeClient

  share.release()
  share.release()
  assert.equal(client.stopped, false)
  voice.release()
  assert.equal(client.stopped, true)
})

test('释放后重新取会建立新连接', () => {
  resetLinks()
  const created: FakeClient[] = []
  const make = () => {
    const client = new FakeClient()
    created.push(client)
    return client as unknown as PiikSignalClient
  }
  const first = acquireLink('room:5', handlers('a', []), make)
  first.release()
  const second = acquireLink('room:5', handlers('b', []), make)

  assert.equal(created.length, 2)
  assert.notEqual(first.client, second.client)
  second.release()
})

test('不同房间互不影响', () => {
  resetLinks()
  const make = () => new FakeClient() as unknown as PiikSignalClient
  const a = acquireLink(linkKey('roomA'), handlers('a', []), make)
  const b = acquireLink(linkKey('roomB'), handlers('b', []), make)
  assert.notEqual(a.client, b.client)
  a.release()
  assert.equal((b.client as unknown as FakeClient).stopped, false)
  b.release()
})
