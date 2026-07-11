type MessageType = 'success' | 'info' | 'warning' | 'error'

interface MessageOptions {
  duration?: number
}

const svgs: Record<MessageType, string> = {
  success:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>',
  info:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
  warning:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
  error:
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>',
}

const colors: Record<MessageType, string> = {
  success:
    'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)] border-[var(--md-sys-color-secondary)]',
  info:
    'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-[var(--md-sys-color-primary)]',
  warning:
    'bg-[var(--md-sys-color-tertiary-container)] text-[var(--md-sys-color-on-tertiary-container)] border-[var(--md-sys-color-tertiary)]',
  error:
    'bg-[var(--md-sys-color-error-container)] text-[var(--md-sys-color-on-error-container)] border-[var(--md-sys-color-error)]',
}

function createContainer(): HTMLDivElement {
  let container = document.getElementById(
    'message-container'
  ) as HTMLDivElement | null
  if (!container) {
    container = document.createElement('div')
    container.id = 'message-container'
    container.className =
      'fixed top-4 left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2 pointer-events-none'
    document.body.appendChild(container)
  }
  return container
}

function show(
  content: string,
  type: MessageType,
  options: MessageOptions = {}
) {
  const container = createContainer()
  const duration = options.duration ?? 3000

  const el = document.createElement('div')
  el.className =
    'pointer-events-auto flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] border px-4 py-2.5 text-sm font-medium shadow-lg backdrop-blur-md transition-all duration-300 translate-y-[-10px] opacity-0 ' +
    colors[type]
  el.style.backgroundColor = 'rgba(var(--md-sys-color-surface-container-rgb), var(--glass-strong-strength))'

  const iconWrapper = document.createElement('span')
  iconWrapper.innerHTML = svgs[type]
  el.appendChild(iconWrapper)

  const text = document.createElement('span')
  text.textContent = content
  el.appendChild(text)

  const closeBtn = document.createElement('button')
  closeBtn.className =
    'ml-2 rounded p-0.5 hover:bg-[var(--md-sys-color-surface-container-highest)]'
  closeBtn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
  closeBtn.onclick = () => remove(el)
  el.appendChild(closeBtn)

  container.appendChild(el)

  requestAnimationFrame(() => {
    el.classList.remove('translate-y-[-10px]', 'opacity-0')
  })

  const timer = setTimeout(() => remove(el), duration)

  function remove(node: HTMLDivElement) {
    clearTimeout(timer)
    node.classList.add('translate-y-[-10px]', 'opacity-0')
    setTimeout(() => {
      node.remove()
    }, 300)
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
}
