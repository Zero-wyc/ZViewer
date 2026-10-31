/**
 * 语音聊天的入口：按后端上报的实现模式选一条线路。
 *
 * 两条实现对外形状完全一致（`VoiceChatController`），面板只认这个接口：
 *   - `process`：伴生 livekit-server（历史行为，默认）
 *   - `sfu`：自建语音（`internal/voicertc` + 共享媒体面）
 *
 * 为什么在 join 之前就先问模式，而不是「先试一条失败了再退另一条」：
 * 失败重试会在用户脸上留一次明确的错误提示，而且两条线路的失败原因
 * 几乎总是同一条（网络），退过去也一样失败。
 */
import { useEffect, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import type { UseVoiceChatOptions, VoiceChatController } from '../types'
import { useLiveKitVoice } from './useLiveKitVoice'
import { useSfuVoice } from './useSfuVoice'

export type VoiceMode = 'process' | 'sfu'

/**
 * 读一次后端的语音实现模式。
 *
 * 失败时按 `process` 处理（历史行为）：状态端点在旧后端上不存在时，
 * 说明它只可能是 LiveKit 那条路。
 */
function useVoiceMode(): VoiceMode {
  const [mode, setMode] = useState<VoiceMode>('process')
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    void (async () => {
      try {
        const res = await fetch('/api/voice/status', {
          signal: controller.signal,
        })
        const data = (await res.json()) as { mode?: string }
        if (!cancelled && data.mode === 'sfu') setMode('sfu')
      } catch {
        /* 保持 process */
      }
    })()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [])
  return mode
}

export function useVoiceChat(
  options: UseVoiceChatOptions
): VoiceChatController {
  const mode = useVoiceMode()
  const { socket } = useSocket()
  // 两个 hook 都必须无条件调用（React 规则）。未选中的那个在 join 之前
  // 没有任何副作用：它们直到 join() 被调用才碰麦克风与 socket。
  const livekit = useLiveKitVoice(options)
  const sfu = useSfuVoice({ ...options, socket })
  return mode === 'sfu' ? sfu : livekit
}

export type {
  VoiceMember,
  VoiceChatController,
  VoiceTransport,
  UseVoiceChatOptions,
} from '../types'
