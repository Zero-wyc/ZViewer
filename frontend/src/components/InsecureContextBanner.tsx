import { useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'
import { t } from '@/i18n'

/**
 * 非安全上下文（HTTP 且非 localhost）提示横幅。
 *
 * 浏览器在 HTTP 来源下会禁用以下 API：
 * - navigator.mediaDevices.getDisplayMedia（屏幕共享）
 * - navigator.mediaDevices.getUserMedia（麦克风 / 摄像头）
 * - WebRTC RTCPeerConnection 的媒体流通道
 *
 * 这些 API 屏幕共享、语音聊天、WebRTC 直连共享功能依赖，因此 HTTP 下这些功能不可用。
 * 其他功能（房间管理、视频播放、弹幕、评论、OBS 推流拉流）不受影响。
 *
 * 仅在非安全上下文且非 localhost 下显示，localhost 被浏览器视为安全上下文无需提示。
 */
export function InsecureContextBanner() {
  // 初始可见性在挂载时一次性计算（lazy initializer），避免 effect 内 setState 触发额外渲染
  const [dismissed, setDismissed] = useState(false)
  const [visible] = useState(() => {
    if (typeof window === 'undefined') return false
    const isLocalhost =
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]'
    return !window.isSecureContext && !isLocalhost
  })

  if (!visible || dismissed) return null

  return (
    <div
      className="zen-toast-enter pointer-events-auto fixed top-4 left-1/2 z-[9998] flex w-[min(680px,calc(100vw-2rem))] -translate-x-1/2 items-start gap-3 rounded-xl border px-4 py-3 shadow-lg"
      style={{
        borderColor: 'var(--md-sys-color-error)',
        backgroundColor:
          'rgba(var(--md-sys-color-error-container-rgb, 249, 233, 232), 0.95)',
        color: 'var(--md-sys-color-on-error-container)',
        backdropFilter: 'blur(var(--glass-blur))',
        WebkitBackdropFilter: 'blur(var(--glass-blur))',
      }}
      role="alert"
    >
      <ShieldAlert
        className="mt-0.5 h-5 w-5 flex-shrink-0"
        style={{ color: 'var(--md-sys-color-error)' }}
      />
      <div className="flex-1 text-sm leading-relaxed">
        <div className="font-semibold">
          {t('当前为 HTTP 连接，部分功能不可用')}
        </div>
        <div
          className="mt-1 text-xs"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {t(
            '屏幕共享、语音聊天等需要安全上下文的功能已被浏览器禁用。其他功能（房间管理、视频播放、弹幕、OBS 推流）可正常使用。配置 HTTPS 后可解锁全部功能。'
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="rounded p-1 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
        aria-label={t('关闭提示')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
