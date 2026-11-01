/** 语音聊天对外暴露的类型。两条实现（LiveKit / 自建 SFU）共用同一份形状。 */

export interface VoiceMember {
  /** 成员 id：LiveKit 是 participant identity，自建 SFU 是 socketId。 */
  id: string
  username: string
}

/** 语音媒体实际生效的传输协议（ICE 选中候选的线路协议）。 */
export type VoiceTransport = 'udp' | 'tcp'

/**
 * 面板消费的控制器。
 *
 * 刻意定义成接口而不是让面板直接依赖某个 hook：语音有两条实现
 * 与「谁在实现它」解耦：面板不该知道媒体是走哪条线路。
 */
export interface VoiceChatController {
  joined: boolean
  joining: boolean
  micEnabled: boolean
  /** 媒体通道是否真正建立（ICE connected）；join 成功但 ICE 失败时为 false。 */
  mediaConnected: boolean
  /** 自己的成员 id，面板用它判定「我」。 */
  selfId: string | null
  members: VoiceMember[]
  transport: VoiceTransport | null
  globalVolume: number
  peerVolumes: Map<string, number>
  micVolume: number
  monitorEnabled: boolean
  audioLevels: Map<string, number>
  /** 被管理员禁言的成员 id。 */
  voiceMutedIds: Set<string>
  join: () => Promise<void>
  leave: () => void
  toggleMic: () => void
  toggleMonitor: () => void
  setGlobalVolume: (value: number) => void
  setPeerVolume: (id: string, value: number) => void
  setMicVolume: (value: number) => void
  muteVoiceMember: (
    id: string,
    muted: boolean
  ) => Promise<{ success: boolean; message?: string }>
  kickVoiceMember: (
    id: string
  ) => Promise<{ success: boolean; message?: string }>
}

export interface UseVoiceChatOptions {
  roomId: string | undefined
  username?: string
}
