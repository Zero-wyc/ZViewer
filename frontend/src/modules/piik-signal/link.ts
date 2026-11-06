/**
 * 同一房间只留一条 `/signal` 连接。
 *
 * Piik 的 `signal.Server` 每个房间只认一个 host 连接：同一个 host token 再
 * 连一条会被回 `HOST_ALREADY_CONNECTED`，而且它会**顶替**前一条的 session。
 * 共享与语音本来是两件独立的事，各自建连接就会互踢——真实表现是「开播后
 * 点加入语音，语音一直停在媒体连接中」，服务端那边还留着一条被拒的循环。
 *
 * 所以连接按房间共享，而不是按用途。谁先来谁建，后来者挂上去收消息；消息
 * 按 `type` 各自收窄，不认识的自然忽略（两边本来就各有判别联合）。
 *
 * 引用计数是必须的：共享停了但语音还开着，连接不能断。
 */
import type { PiikSignalClient, PiikSignalHandlers } from './client.ts'

interface LinkEntry {
  client: PiikSignalClient
  refs: number
}

const links = new Map<string, LinkEntry>()

/** 连接池的 key：一个 ZViewer 房间一条 Piik 连接。 */
export function linkKey(roomID: string): string {
  return `room:${roomID}`
}

export interface PiikLink {
  readonly client: PiikSignalClient
  /** 释放自己那一份引用；归零时断开连接。重复调用无副作用。 */
  release: () => void
}

/**
 * 取（或建立）这个房间的连接。
 *
 * `create` 只在第一次调用时执行，后续复用同一条；`handlers` 会在新建时
 * 直接交给 `create`，复用时通过 `subscribe` 挂上去。两种路径都保证只收
 * 到一份消息——`create` 里不要自己再 subscribe。
 */
export function acquireLink(
  key: string,
  handlers: PiikSignalHandlers,
  create: (handlers: PiikSignalHandlers) => PiikSignalClient
): PiikLink {
  let entry = links.get(key)
  let unsubscribe = () => {}
  if (!entry) {
    entry = { client: create(handlers), refs: 0 }
    links.set(key, entry)
  } else {
    unsubscribe = entry.client.subscribe(handlers)
  }
  const target = entry
  target.refs += 1
  let released = false

  return {
    client: target.client,
    release: () => {
      if (released) return
      released = true
      unsubscribe()
      target.refs -= 1
      if (target.refs > 0) return
      // 只删自己那一份：期间可能已经被别人替换过。
      if (links.get(key) === target) links.delete(key)
      target.client.stop()
    },
  }
}

/** 仅供测试：清空注册表，避免用例之间互相污染。 */
export function resetLinks(): void {
  for (const entry of links.values()) entry.client.stop()
  links.clear()
}
