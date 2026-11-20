/**
 * 跨平台全屏工具函数。
 *
 * iOS Safari 不支持标准 Fullscreen API（Element.requestFullscreen()）对非 video
 * 元素（如 div 容器）的全屏。在 iOS 上需要降级为网页全屏（CSS 模拟全屏），
 * 以保留自定义控制栏、弹幕层等 UI。
 *
 * 本模块提供：
 * - isIOSDevice()：检测 iOS / iPadOS 设备
 * - supportsNativeFullscreen()：检测标准 Fullscreen API 是否可用
 * - 跨平台全屏状态查询与事件监听
 */

/** 检测当前设备是否为 iOS / iPadOS */
export function isIOSDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined')
    return false
  const ua = navigator.userAgent
  // iPhone / iPod / iPad（iOS 12 及更早版本）
  if (/iPhone|iPad|iPod/.test(ua)) return true
  // iPadOS 13+：Safari 将 userAgent 伪装为 macOS，但具有触摸支持
  // 排除 Windows 触屏设备和 Edge
  if (
    navigator.maxTouchPoints > 0 &&
    /Macintosh/.test(ua) &&
    !(window as unknown as { MSStream?: unknown }).MSStream
  ) {
    return true
  }
  return false
}

/**
 * 检测浏览器是否支持对任意元素（非 video）的原生全屏。
 * iOS Safari 即使 document.fullscreenEnabled 为 true，
 * 对 div 容器调用 requestFullscreen 也不会生效。
 */
export function supportsContainerFullscreen(): boolean {
  if (typeof document === 'undefined') return false
  // iOS 设备不支持容器全屏（仅支持 video.webkitEnterFullscreen）
  if (isIOSDevice()) return false
  // 检测标准 Fullscreen API
  if (document.fullscreenEnabled) return true
  // 检测带前缀的 Fullscreen API（旧版 WebKit）
  const doc = document as Document & {
    webkitFullscreenEnabled?: boolean
  }
  if (doc.webkitFullscreenEnabled) return true
  return false
}

/** 获取当前全屏元素（跨平台） */
export function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null
  if (document.fullscreenElement) return document.fullscreenElement
  const doc = document as Document & {
    webkitFullscreenElement?: Element | null
    webkitCurrentFullScreenElement?: Element | null
  }
  return (
    doc.webkitFullscreenElement ?? doc.webkitCurrentFullScreenElement ?? null
  )
}

/**
 * 判断某个元素（通常是播放器舞台）自身是否处于原生全屏。
 *
 * 右上角的「网页全屏」按钮会把 `documentElement` 整个全屏，此时
 * getFullscreenElement() 同样非空，但播放器并没有真正全屏——若把它当成
 * 播放器全屏处理，语音/音乐等浮层就会被 portal 进播放器内部（表现为
 * 浮球"跳进"播放器）。这里显式排除 `documentElement`。
 */
export function isElementFullscreen(el: Element | null): boolean {
  if (!el) return false
  const fsEl = getFullscreenElement()
  if (!fsEl) return false
  if (fsEl === document.documentElement) return false
  return fsEl === el || el.contains(fsEl)
}

/** 退出全屏（跨平台） */
export function exitFullscreen(): Promise<void> {
  if (typeof document === 'undefined') return Promise.resolve()
  if (document.exitFullscreen) {
    return document.exitFullscreen().catch(() => {})
  }
  const doc = document as Document & {
    webkitExitFullscreen?: () => void
    webkitCancelFullScreen?: () => void
  }
  if (doc.webkitExitFullscreen) {
    doc.webkitExitFullscreen()
    return Promise.resolve()
  }
  if (doc.webkitCancelFullScreen) {
    doc.webkitCancelFullScreen()
    return Promise.resolve()
  }
  return Promise.resolve()
}

/**
 * 请求元素进入原生全屏（跨平台）。
 * 仅在 supportsContainerFullscreen() 为 true 时调用。
 * 返回 Promise，失败时 reject。
 */
export function requestFullscreen(el: HTMLElement): Promise<void> {
  // 标准 API
  if (el.requestFullscreen) {
    return el.requestFullscreen()
  }
  // WebKit 前缀（Safari < 16.4 等旧版本）
  const webkitEl = el as HTMLElement & {
    webkitRequestFullscreen?: () => void
    webkitRequestFullScreen?: () => void
  }
  if (webkitEl.webkitRequestFullscreen) {
    webkitEl.webkitRequestFullscreen()
    return Promise.resolve()
  }
  if (webkitEl.webkitRequestFullScreen) {
    webkitEl.webkitRequestFullScreen()
    return Promise.resolve()
  }
  return Promise.reject(new Error('Fullscreen API not supported'))
}

/** 全屏状态变化事件名称（跨平台） */
export function getFullscreenChangeEvent(): string {
  if (typeof document === 'undefined') return 'fullscreenchange'
  if ('onfullscreenchange' in document) return 'fullscreenchange'
  if ('onwebkitfullscreenchange' in document) return 'webkitfullscreenchange'
  return 'fullscreenchange'
}

/**
 * 注册全屏状态变化监听器。
 * 返回取消监听的清理函数。
 */
export function onFullscreenChange(callback: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  const eventName = getFullscreenChangeEvent()
  document.addEventListener(eventName, callback)
  // 同时监听两种事件以防万一
  if (eventName !== 'fullscreenchange') {
    document.addEventListener('fullscreenchange', callback)
  }
  if (eventName !== 'webkitfullscreenchange') {
    document.addEventListener('webkitfullscreenchange', callback)
  }
  return () => {
    document.removeEventListener(eventName, callback)
    document.removeEventListener('fullscreenchange', callback)
    document.removeEventListener('webkitfullscreenchange', callback)
  }
}
