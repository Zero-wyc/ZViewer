/**
 * 弹窗 / 通知类浮层的挂载宿主。
 *
 * 问题：原生全屏（requestFullscreen）时浏览器只渲染 fullscreenElement 的子树，
 * 挂在我们习惯的 document.body 上的 Modal、确认框、观众申请通知、toast
 * 完全不可见——而播放器全屏时用户恰恰还会收到这些提示。
 *
 * 几点约束：
 * - 「网页全屏」是 CSS 模拟的全屏（不动 Fullscreen API），无需迁移；
 *   只有真的把 `documentElement` 全屏时才算整页，此时 body 子树本来就在里面；
 * - video / img / canvas 等媒体元素不能承载子节点，退回 body
 *   （iOS 原生视频全屏同样无法叠加 DOM）；
 * - 用 useSyncExternalStore 监听 fullscreenchange，宿主变化时自动重挂，
 *   避免 setState-in-effect（React Compiler 规则）与首帧读到旧宿主的时序问题。
 */
import { useSyncExternalStore } from 'react'
import { getFullscreenElement } from './fullscreen-utils'

/** 不能承载子节点的媒体元素：即使被全屏，浮层也必须留在 body 上 */
const MEDIA_TAG_NAMES = new Set(['VIDEO', 'AUDIO', 'IMG', 'CANVAS', 'IFRAME'])

function currentDocument(): Document | null {
  return typeof document === 'undefined' ? null : document
}

/** 同步解析：当前应把浮层挂到哪个元素上（无全屏时是 body） */
export function resolvePortalHost(): HTMLElement | null {
  const doc = currentDocument()
  if (!doc) return null
  const fullscreenElement = getFullscreenElement() as HTMLElement | null
  if (!fullscreenElement) return doc.body
  if (fullscreenElement === doc.documentElement) return doc.body
  if (MEDIA_TAG_NAMES.has(fullscreenElement.tagName)) return doc.body
  return fullscreenElement
}

function subscribe(onChange: () => void): () => void {
  const doc = currentDocument()
  if (!doc) return () => {}
  // Safari < 16.4 只派发 webkit 前缀事件，两个都听（重复触发由 useSyncExternalStore 去重）
  doc.addEventListener('fullscreenchange', onChange)
  doc.addEventListener('webkitfullscreenchange', onChange)
  return () => {
    doc.removeEventListener('fullscreenchange', onChange)
    doc.removeEventListener('webkitfullscreenchange', onChange)
  }
}

function getServerSnapshot(): HTMLElement | null {
  return currentDocument()?.body ?? null
}

/** React 版本：全屏状态变化时返回新的宿主元素（null 表示无 document，调用方退回 body） */
export function usePortalHost(): HTMLElement | null {
  return useSyncExternalStore(subscribe, resolvePortalHost, getServerSnapshot)
}
