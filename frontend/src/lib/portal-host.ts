import { useSyncExternalStore } from 'react'
import { getFullscreenElement } from './fullscreen-utils'

/**
 * 弹窗/通知类浮层的挂载宿主。
 *
 * 原生全屏（requestFullscreen）时浏览器只渲染 fullscreenElement 的子树，
 * 挂在 document.body 上的弹窗（Modal、确认框、观众申请通知等）完全不可见；
 * 播放器全屏时用户仍会收到这些提示，必须搬进全屏子树里。
 *
 * 几点约束：
 * - 「网页全屏」按钮把 documentElement 整个全屏，body 子树本来就在里面，无需迁移；
 * - video/img/canvas 等媒体元素不能承载子节点，退回 body（iOS 原生视频全屏无法叠加 DOM）；
 * - 用 useSyncExternalStore 监听 fullscreenchange，宿主元素变化时自动重挂，
 *   避免 setState-in-effect（React Compiler 规则）与首帧读到旧宿主的时序问题。
 */
const MEDIA_TAG_NAMES = new Set(['VIDEO', 'AUDIO', 'IMG', 'CANVAS', 'IFRAME'])

function currentDocument(): Document | null {
  return typeof document === 'undefined' ? null : document
}

/** 同步解析：当前应把浮层挂到哪个元素上（无全屏时是 body） */
export function resolvePortalHost(): HTMLElement {
  const doc = currentDocument()
  if (!doc) return null as unknown as HTMLElement
  const fsEl = getFullscreenElement() as HTMLElement | null
  if (!fsEl || fsEl === doc.documentElement) return doc.body
  if (MEDIA_TAG_NAMES.has(fsEl.tagName)) return doc.body
  return fsEl
}

function subscribe(onChange: () => void): () => void {
  const doc = currentDocument()
  if (!doc) return () => {}
  doc.addEventListener('fullscreenchange', onChange)
  doc.addEventListener('webkitfullscreenchange', onChange)
  return () => {
    doc.removeEventListener('fullscreenchange', onChange)
    doc.removeEventListener('webkitfullscreenchange', onChange)
  }
}

function getServerSnapshot(): HTMLElement {
  return currentDocument()?.body ?? (null as unknown as HTMLElement)
}

/** React 版本：全屏状态变化时返回新的宿主元素 */
export function usePortalHost(): HTMLElement {
  return useSyncExternalStore(subscribe, resolvePortalHost, getServerSnapshot)
}
