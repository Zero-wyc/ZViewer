/**
 * 屏幕 Wake Lock（防息屏）管理。
 *
 * 移植自 mirotalk public/js/wakeLock.js，保留其核心健壮性设计：
 * - generation 计数：release 会使 generation++，让迟到的 request 结果
 *   （await 期间状态已翻转）自动失效并补一次释放，杜绝竞态；
 * - requestPending / releasePending 标志：防止并发请求/释放重入；
 * - 50ms debounce 统一同步：所有状态变化都走 syncDebounced，频繁翻转
 *   （如播放器反复暂停/播放）只触发一次真实的 request/release；
 * - visibilitychange / pagehide / pageshow / PiP 全事件兜底：
 *   系统强制释放锁（切后台）后回到前台自动重新获取，页面隐藏时立即释放。
 *
 * 使用方（hooks/useWakeLock.ts）声明「当前是否需要保持常亮」，
 * 本模块内部决定是否真的持有锁：仅移动/平板设备生效（桌面无需防息屏），
 * 浏览器不支持或页面不可见时静默不生效。
 */

interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

type WakeLockAwareNavigator = Navigator & {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>
  }
}

let sentinel: WakeLockSentinelLike | null = null
let requestPending = false
let releasePending = false
let generation = 0
let pageActive = true
let wantKeepAwake = false
let listenersBound = false
let syncTimer: number | null = null

function isSupported(): boolean {
  const nav = navigator as WakeLockAwareNavigator
  return typeof nav.wakeLock?.request === 'function'
}

/** 仅移动/平板设备需要防息屏；桌面端接显示器电源策略，不介入 */
function isMobileDevice(): boolean {
  const ua = navigator.userAgent
  const isIpadOs =
    /Mac/.test(ua) &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || isIpadOs
}

function shouldKeepAwake(): boolean {
  return (
    wantKeepAwake &&
    pageActive &&
    isSupported() &&
    document.visibilityState === 'visible' &&
    !document.pictureInPictureElement
  )
}

async function request(): Promise<void> {
  if (sentinel || requestPending || releasePending || !shouldKeepAwake()) return
  requestPending = true
  const gen = generation
  try {
    const nav = navigator as WakeLockAwareNavigator
    const next = await nav.wakeLock!.request('screen')
    sentinel = next
    // 系统释放锁（如切后台被浏览器收回）时同步状态并尝试重取
    next.addEventListener('release', () => {
      if (sentinel !== next) return
      sentinel = null
      syncDebounced()
    })
    // await 期间状态已翻转（generation 变化/页面隐藏/已被释放）→ 立即补释放
    if (gen !== generation || !shouldKeepAwake() || next.released) {
      await release()
    }
  } catch (err) {
    console.warn('[wakeLock] request failed:', err)
  } finally {
    requestPending = false
    if (gen !== generation && shouldKeepAwake()) syncDebounced()
  }
}

async function release(): Promise<void> {
  generation++
  const current = sentinel
  if (releasePending) return
  if (!current) return
  releasePending = true
  try {
    await current.release()
    if (sentinel === current) sentinel = null
  } catch (err) {
    console.warn('[wakeLock] release failed:', err)
  } finally {
    releasePending = false
    if (!sentinel && shouldKeepAwake()) syncDebounced()
  }
}

function sync(): void {
  void (shouldKeepAwake() ? request() : release())
}

function syncDebounced(): void {
  if (syncTimer !== null) clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    syncTimer = null
    sync()
  }, 50)
}

function bindGlobalListeners(): void {
  if (listenersBound) return
  listenersBound = true
  // 切后台释放/回前台重取（浏览器在页面隐藏时会强制释放锁）
  document.addEventListener('visibilitychange', syncDebounced)
  // PiP 播放时页面本体不可见，无需常亮；退出 PiP 恢复
  document.addEventListener('enterpictureinpicture', () => {
    void release()
  })
  document.addEventListener('leavepictureinpicture', syncDebounced)
  // 页面卸载/进入 bfcache 前立即释放；从 bfcache 恢复时重新同步
  window.addEventListener('pagehide', () => {
    pageActive = false
    if (syncTimer !== null) clearTimeout(syncTimer)
    void release()
  })
  window.addEventListener('pageshow', () => {
    pageActive = true
    syncDebounced()
  })
}

/**
 * 声明「是否需要保持屏幕常亮」。
 * 实际持锁由内部条件决定：移动/平板 + 页面可见 + 浏览器支持。
 * enabled 未变化时也执行一次 debounce 同步，用于页面可见性等
 * 外部条件变化后的补偿（幂等，无副作用）。
 */
export function setWakeLockEnabled(enabled: boolean): void {
  bindGlobalListeners()
  const next = enabled && isMobileDevice()
  wantKeepAwake = next
  syncDebounced()
}
