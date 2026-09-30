/**
 * 媒体元素诊断探针（临时工具，localStorage 开关启用）。
 *
 * 背景：一起看房间页出现「同一声音的回声」，但 document.querySelectorAll
 * 只能找到单个 <video>——第二个声源不在文档树里（脱离 DOM 的游离元素
 * 或 new Audio() 创建的游离对象），常规手段不可见。
 *
 * 启用方式：控制台执行
 *   localStorage.setItem('zviewer-media-debug', '1'); location.reload()
 * 复现后执行 __mediaDump() 并粘贴输出。
 *
 * 记录内容：
 * - 每次 play/pause/load：元素标签、是否连接文档树、当前 src、调用堆栈
 * - new Audio() 创建（游离音频对象的唯一可见途径）
 * - 引擎级 loadUrl / MediaSource attach 由引擎自身日志覆盖，不在此重复
 */

let installed = false

export function installMediaDebugProbe(): void {
  if (installed || typeof window === 'undefined') return
  if (localStorage.getItem('zviewer-media-debug') !== '1') return
  installed = true

  const log: unknown[] = []
  const ts = () => new Date().toISOString().slice(11, 23)
  const srcOf = (el: HTMLMediaElement) =>
    (el.currentSrc || el.src || '').slice(0, 110) || '(empty/MSE)'
  const push = (entry: Record<string, unknown>) => {
    log.push({ t: ts(), ...entry })

    console.info(
      '%c[media-debug]',
      'color:#e91e63;font-weight:bold',
      entry.ev,
      entry.tag,
      `connected=${String(entry.connected)}`,
      entry.src,
      entry.stack ? `\n  ${entry.stack}` : ''
    )
    // 上限保护：超量后停止记录避免内存膨胀
    if (log.length > 500) log.splice(0, log.length - 500)
  }
  const stackOf = () =>
    (new Error().stack ?? '')
      .split('\n')
      .slice(2, 8)
      .map((l) => l.trim().replace(/^at /, ''))
      .join(' <= ')

  // ── play / pause / load ──
  const origPlay = HTMLMediaElement.prototype.play
  HTMLMediaElement.prototype.play = function (...args: unknown[]) {
    push({
      ev: 'play',
      tag: this.tagName,
      connected: this.isConnected,
      src: srcOf(this),
      stack: stackOf(),
    })
    return origPlay.apply(this, args as [])
  } as typeof HTMLMediaElement.prototype.play

  const origPause = HTMLMediaElement.prototype.pause
  HTMLMediaElement.prototype.pause = function (...args: unknown[]) {
    push({
      ev: 'pause',
      tag: this.tagName,
      connected: this.isConnected,
      src: srcOf(this),
      stack: stackOf(),
    })
    return origPause.apply(this, args as [])
  } as typeof HTMLMediaElement.prototype.pause

  // ── src 赋值（抓 MSE blob / 直链切换顺序）──
  const srcDesc = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    'src'
  )
  if (srcDesc?.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: srcDesc.get,
      set(this: HTMLMediaElement, v: string) {
        push({
          ev: 'src=',
          tag: this.tagName,
          connected: this.isConnected,
          src: String(v ?? '').slice(0, 110),
          stack: stackOf(),
        })
        srcDesc.set.call(this, v)
      },
      configurable: true,
    })
  }

  // ── new Audio()：游离音频对象的唯一创建途径 ──
  const OrigAudio = window.Audio
  function ProbeAudio(
    this: HTMLAudioElement,
    ...args: ConstructorParameters<typeof Audio>
  ) {
    const el = new OrigAudio(...args)
    push({
      ev: 'new Audio',
      tag: 'AUDIO',
      connected: el.isConnected,
      src: (args[0] ?? '').slice(0, 110),
      stack: stackOf(),
    })
    return el
  }
  ProbeAudio.prototype = OrigAudio.prototype
  // 保留静态属性（CAN_PLAY 等常量，若存在）
  Object.assign(ProbeAudio, OrigAudio)
  window.Audio = ProbeAudio as unknown as typeof Audio

  // ── 结果导出：控制台 __mediaDump() 输出全部记录 ──
  ;(window as unknown as Record<string, unknown>).__mediaDump = () => {
    console.info(`[media-debug] 共 ${log.length} 条记录`)
    console.table(log.map((e) => e as Record<string, unknown>))
    return log
  }

  console.info(
    '%c[media-debug]',
    'color:#e91e63;font-weight:bold',
    '探针已启用。复现后执行 __mediaDump() 查看全部媒体调用记录。'
  )
}
