type MessageType = 'success' | 'info' | 'warning' | 'error'

/** 确认类提示的操作按钮（点击后提示窗关闭并执行回调） */
export interface MessageAction {
  label: string
  onClick: () => void
}

interface MessageOptions {
  duration?: number
  /** 操作按钮组（提供时替代右上角关闭按钮，用于非模态确认提示） */
  actions?: MessageAction[]
}

const svgs: Record<MessageType, string> = {
  success:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  info: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  warning:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  error:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
}

const colors: Record<MessageType, string> = {
  success:
    'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)] border-[var(--md-sys-color-secondary)]',
  info: 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]',
  warning:
    'bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)] border-[var(--md-sys-color-tertiary)]',
  error:
    'bg-[var(--md-sys-color-error-container)] text-[var(--md-sys-color-on-error-container)] border-[var(--md-sys-color-error)]',
}

const progressColors: Record<MessageType, string> = {
  success: 'bg-[var(--md-sys-color-secondary)]',
  info: 'bg-[var(--md-sys-color-primary)]',
  warning: 'bg-[var(--md-sys-color-tertiary)]',
  error: 'bg-[var(--md-sys-color-error)]',
}

/* ---------- 多条消息错峰控制 ----------
 * 短时间内连续调用的消息会自动错峰进入，避免多条消息同时从右侧滑入造成视觉混乱。
 * STAGGER_WINDOW_MS 内的调用视为"同时"，每条延迟 STAGGER_DELAY_MS。
 */
const STAGGER_WINDOW_MS = 300
const STAGGER_DELAY_MS = 60
let pendingEnterCount = 0
let lastEnterTime = 0
let staggerResetTimer: ReturnType<typeof setTimeout> | null = null

function getStaggerDelay(): number {
  const now = Date.now()
  if (now - lastEnterTime < STAGGER_WINDOW_MS) {
    pendingEnterCount++
  } else {
    pendingEnterCount = 0
  }
  lastEnterTime = now
  if (staggerResetTimer) clearTimeout(staggerResetTimer)
  // 超过窗口时间后重置计数器，避免长序列调用累计过大延迟
  staggerResetTimer = setTimeout(() => {
    pendingEnterCount = 0
  }, STAGGER_WINDOW_MS + 100)
  return pendingEnterCount * STAGGER_DELAY_MS
}

function createContainer(): HTMLDivElement {
  let container = document.getElementById(
    'message-container'
  ) as HTMLDivElement | null
  if (!container) {
    container = document.createElement('div')
    container.id = 'message-container'
    container.className =
      'fixed top-4 left-1/2 z-[9999] flex -translate-x-1/2 flex-col items-center gap-2 pointer-events-none'
    document.body.appendChild(container)
  }
  return container
}

const EXIT_TRANSITION_MS = 320 // 略大于 0.28s transition，确保过渡完成后再移除节点

function show(
  content: string,
  type: MessageType,
  options: MessageOptions = {}
) {
  const container = createContainer()
  const duration = options.duration ?? 3000
  const staggerDelay = getStaggerDelay()

  const el = document.createElement('div')
  el.className =
    'zen-toast-enter pointer-events-auto relative flex min-w-[200px] items-center gap-2 overflow-hidden rounded-[var(--md-sys-shape-corner)] border px-4 py-2.5 text-sm font-medium shadow-lg ' +
    colors[type]
  el.style.backgroundColor =
    'rgba(var(--md-sys-color-surface-container-rgb), var(--glass-strong-strength))'
  // 使用 --glass-blur 变量，使模糊度跟随主题设置（toast 使用标准玻璃强度）
  el.style.backdropFilter = 'blur(var(--glass-blur))'
  el.style.setProperty('-webkit-backdrop-filter', 'blur(var(--glass-blur))')
  el.style.setProperty('--toast-duration', `${duration}ms`)
  // 错峰延迟：让 enter 动画和 progress 动画同步推迟开始
  if (staggerDelay > 0) {
    el.style.animationDelay = `${staggerDelay}ms`
  }

  const iconWrapper = document.createElement('span')
  iconWrapper.className = 'flex-shrink-0'
  iconWrapper.innerHTML = svgs[type]
  el.appendChild(iconWrapper)

  const text = document.createElement('span')
  text.className = 'flex-1'
  text.textContent = content
  el.appendChild(text)

  if (options.actions?.length) {
    // 确认类提示：操作按钮组替代关闭按钮（描边跟随类型色，非模态不影响其他操作）
    const row = document.createElement('span')
    row.className = 'ml-1 flex shrink-0 items-center gap-1.5'
    for (const action of options.actions) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = action.label
      btn.className =
        'rounded-full px-2.5 py-0.5 text-xs font-bold leading-4 transition-opacity hover:opacity-70'
      btn.style.border = '1px solid currentColor'
      btn.onclick = () => {
        remove(el)
        action.onClick()
      }
      row.appendChild(btn)
    }
    el.appendChild(row)
  } else {
    const closeBtn = document.createElement('button')
    closeBtn.className =
      'ml-2 rounded p-0.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]'
    closeBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
    closeBtn.onclick = () => remove(el)
    el.appendChild(closeBtn)
  }

  const progress = document.createElement('div')
  progress.className =
    'zen-toast-progress absolute bottom-0 left-0 h-[2px] opacity-60 ' +
    progressColors[type]
  progress.style.width = '100%'
  // progress 动画与 enter 动画同步延迟，避免进度条在消息出现前就开始减少
  if (staggerDelay > 0) {
    progress.style.animationDelay = `${staggerDelay}ms`
  }
  el.appendChild(progress)

  container.appendChild(el)

  // enter 动画结束后清除类，便于后续 FLIP/状态判断（避免 both 模式持续覆盖 transform）
  el.addEventListener(
    'animationend',
    () => {
      // 仅在仍处于 enter 阶段时清除（可能已被 remove 提前切换为 exit）
      if (el.dataset.removing !== 'true') {
        el.classList.remove('zen-toast-enter')
        el.style.animationDelay = ''
      }
    },
    { once: true }
  )

  // 持续时间需加上错峰延迟，避免延迟期间就被移除
  const timer = setTimeout(() => remove(el), duration + staggerDelay)

  function remove(node: HTMLDivElement) {
    if (node.dataset.removing === 'true') return
    node.dataset.removing = 'true'
    clearTimeout(timer)

    // 读取实际高度，用于计算负 margin 收起量（高度本身保持不变，内容不会被压扁）
    const actualHeight = node.offsetHeight
    const TOAST_GAP = 8 // 与容器 gap-2 一致

    // 切换到 exit 状态：移除 enter 类，添加 exit 类
    node.classList.remove('zen-toast-enter')
    node.classList.add('zen-toast-exit')
    node.style.animationDelay = ''

    // 目标状态：向左飞出 + 淡出 + 负 margin 平滑收起占位空间
    // 起始值均为当前自然值（opacity:1 / transform:none / margin-bottom:0），
    // 无需先写中间态再等下一帧，规避 rAF 批处理导致的过渡失效竞态
    node.style.opacity = '0'
    node.style.transform = 'translateX(-100vw) scale(0.96)'
    node.style.marginBottom = `-${actualHeight + TOAST_GAP}px`

    // 过渡完成后移除节点（下方消息已通过负 margin 平滑上移，无跳变）
    setTimeout(() => {
      node.remove()
    }, EXIT_TRANSITION_MS)
  }
}

export const message = {
  success: (content: string, options?: MessageOptions) =>
    show(content, 'success', options),
  info: (content: string, options?: MessageOptions) =>
    show(content, 'info', options),
  warning: (content: string, options?: MessageOptions) =>
    show(content, 'warning', options),
  error: (content: string, options?: MessageOptions) =>
    show(content, 'error', options),
  /** 非模态确认提示：与普通提示同窗口样式（顶部居中、不影响其他 UI 操作），
   *  带操作按钮组，停留更久（默认 8s）供用户选择 */
  confirm: (
    content: string,
    actions: MessageAction[],
    options?: MessageOptions
  ) => show(content, 'info', { duration: 8000, ...options, actions }),
}
