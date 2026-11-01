/**
 * 语音是否可用。
 *
 * 只剩一条实现（自建 SFU），这里的 `available` 就是「媒体端口有没有起来」。
 * 单独问一次而不是等加入时报错：媒体面没起来时对端永远不会发 offer，
 * 用户点「加入语音」只会看到一直转圈——那是最难自查的一种失败。
 */
import { useEffect, useState } from 'react'

export function useVoiceStatus(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/voice/status', {
          signal: controller.signal,
        })
        const data = (await res.json()) as { available?: unknown }
        if (cancelled) return
        // 字段缺失按可用处理：旧后端没有这个字段时不要把语音入口拦掉。
        setAvailable(data.available === false ? false : true)
      } catch {
        if (!cancelled) setAvailable(true)
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])

  return available
}
