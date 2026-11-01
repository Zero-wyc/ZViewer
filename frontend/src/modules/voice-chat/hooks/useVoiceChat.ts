/**
 * 语音聊天的入口。
 *
 * 只有一条实现（自建 SFU，`voice` 事件 + 服务端媒体面）。这个文件保留下来
 * 是因为面板按 useVoiceChat 调用、类型也从这里导出；把实现直接挂出去可以让
 * 调用方不关心目录结构。
 */
import type { UseVoiceChatOptions, VoiceChatController } from '../types'
import { useSfuVoice } from './useSfuVoice'
import { useSocket } from '@/hooks/useSocket'

export function useVoiceChat(
  options: UseVoiceChatOptions
): VoiceChatController {
  const { socket } = useSocket()
  return useSfuVoice({ ...options, socket })
}

export type {
  VoiceMember,
  VoiceChatController,
  VoiceTransport,
  UseVoiceChatOptions,
} from '../types'
