/**
 * 页面级「这次走哪条共享链路」。
 *
 * 单纯读开关不够：默认已经是 Piik，而 Piik 桥接层起不来时整页共享都是死的。
 * 这里在挂载后探一次服务端能力，探不到就自动退回旧链路，并告诉用户一声——
 * 静默换链路比报错更难排查。
 *
 * 用户显式指定（`?shareBackend=` / localStorage）时不覆盖：他要排查哪条链路，
 * 就该跑哪条，哪怕跑不通。
 */
import { useEffect, useState } from 'react'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'
import { apiFetch, safeJson } from '@/lib/api'
import { shareBackendChoice } from './backend.ts'
import type { ShareBackend } from './backend.ts'

/**
 * 问服务端「Piik 链路起没起来」。
 *
 * 返回 null 表示问不到（断网、老服务端没有这个端点）——调用方应当当作
 * 「不知道」，继续用默认链路，而不是贸然退回旧实现。
 */
async function probeShareCapabilities(): Promise<{ piik: boolean } | null> {
  try {
    const response = await apiFetch('/api/share/capabilities', {
      method: 'GET',
    })
    if (!response.ok) return null
    const payload = await safeJson<{ piik?: boolean }>(response, {})
    if (typeof payload.piik !== 'boolean') return null
    return { piik: payload.piik }
  } catch {
    return null
  }
}

export function useShareBackend(): ShareBackend {
  // 只在首次渲染读一次：后续 render 不该因为 localStorage 变了就换链路。
  const [choice] = useState(shareBackendChoice)
  const [backend, setBackend] = useState<ShareBackend>(choice.backend)

  useEffect(() => {
    if (choice.explicit || choice.backend !== 'piik') return
    let cancelled = false
    void probeShareCapabilities().then((capabilities) => {
      // null = 问不到，按「不知道」处理，继续用默认链路。
      if (cancelled || !capabilities || capabilities.piik) return
      setBackend('sfu')
      message.warning(t('服务端未启用新版共享链路，已切换到兼容模式'))
    })
    return () => {
      cancelled = true
    }
  }, [choice])

  return backend
}
