/**
 * 语音聊天的入口。
 *
 * 两条实现共用一个契约（`VoiceChatController`）：Piik 的 `/signal`（P2P 树，
 * 房主是树根）与旧的 socket.io + 服务端 SFU。走哪条由后端 `/api/voice/status`
 * 的 `backend` 决定——前端自己探测只会得到「点加入一直转圈」这种最难自查的
 * 失败。
 *
 * 两个 hook 都会被调用：React 要求 hook 调用序列稳定，而实现只能在拿到后端
 * 答复之后才确定。未被选中的那条靠 `enabled=false` 保持空转。
 */
import type { UseVoiceChatOptions, VoiceChatController } from '../types'
import { usePiikVoice } from '@/modules/piik-voice/usePiikVoice'
import { useSfuVoice } from './useSfuVoice'
import { useVoiceBackend } from './useVoiceStatus'
import { useSocket } from '@/hooks/useSocket'

export function useVoiceChat(
  options: UseVoiceChatOptions
): VoiceChatController {
  const { socket } = useSocket()
  const backend = useVoiceBackend()
  const piik = usePiikVoice({ ...options, enabled: backend === 'piik' })
  const sfu = useSfuVoice({ ...options, socket, enabled: backend === 'sfu' })
  return backend === 'piik' ? piik : sfu
}

export type {
  VoiceMember,
  VoiceChatController,
  VoiceTransport,
  UseVoiceChatOptions,
} from '../types'
