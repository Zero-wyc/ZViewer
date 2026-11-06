/**
 * 语音是否可用，以及由哪条链路承载。
 *
 * `backend` 是服务端告诉前端的唯一事实：`piik` 走 `/signal` 的 P2P 树，
 * `sfu` 是旧的 socket.io + 服务端媒体面。单独问一次而不是等加入时报错：
 * 媒体面没起来时对端永远不会发 offer，用户点「加入语音」只会看到一直转圈。
 */
import { useEffect, useState } from 'react'

export type VoiceBackend = 'piik' | 'sfu'

interface VoiceStatus {
  available: boolean
  backend: VoiceBackend
}

const FALLBACK: VoiceStatus = { available: true, backend: 'sfu' }

export function useVoiceStatus(): VoiceStatus {
  const [status, setStatus] = useState<VoiceStatus>(FALLBACK)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/voice/status', {
          signal: controller.signal,
        })
        const data = (await res.json()) as {
          available?: unknown
          backend?: unknown
        }
        if (cancelled) return
        setStatus({
          // 字段缺失按可用处理：旧后端没有这个字段时不要把语音入口拦掉。
          available: data.available !== false,
          backend: data.backend === 'piik' ? 'piik' : 'sfu',
        })
      } catch {
        if (!cancelled) setStatus(FALLBACK)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  return status
}

/** 只取后端类型，给选择实现用。 */
export function useVoiceBackend(): VoiceBackend {
  return useVoiceStatus().backend
}
