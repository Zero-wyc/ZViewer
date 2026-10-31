/**
 * 语音协议里客户端的纯函数部分。
 *
 * 抽出来是因为这三条约束错了不会报错，只会「没声音」：
 *  1. answer 必须原样带回 offer 的 `revision`（服务端拿它判过期）；
 *  2. answer 的 `tracks[]` 只能列**自己真正发**的那一条（多列判非法）；
 *  3. 「自己发」的那条 m-line 要按 publicationId 认，不能按顺序猜。
 */

export interface VoiceTrackRef {
  mid: string
  publicationId: string
}

export interface VoiceDescription {
  revision: number
  sdp: RTCSessionDescriptionInit
  tracks: VoiceTrackRef[]
}

/** 发布身份与服务端派生规则一致（`voice_<peerId>`）。 */
export function publicationOf(peerID: string): string {
  return `voice_${peerID}`
}

/** 从发布身份取回 peerId；不是本方案的发布返回 null。 */
export function peerOfPublication(publicationID: string): string | null {
  return publicationID.startsWith('voice_')
    ? publicationID.slice('voice_'.length)
    : null
}

/**
 * 找出「我往哪条 m-line 发」。
 *
 * 认 publicationId 而不是取第一条：offer 里既有我发的（服务端 recvonly），
 * 也有我收的（服务端 sendonly），顺序由服务端的槽位分配决定，不能猜。
 */
export function ownSendMid(
  description: VoiceDescription,
  selfPeerID: string | null
): string {
  if (!selfPeerID) return ''
  const own = publicationOf(selfPeerID)
  for (const track of description.tracks) {
    if (track.publicationId === own) return track.mid
  }
  return ''
}

/**
 * 组装 answer 的载荷。
 *
 * `bound` 表示麦克风是否真的挂到了那条 m-line 上——没挂上就不能在 tracks
 * 里声明「我在发」，否则服务端会把一条永远没数据的轨道当成发布资源。
 */
export function buildAnswerPayload(options: {
  description: VoiceDescription
  sdp: string
  selfPeerID: string | null
  sendMid: string
  bound: boolean
}): {
  revision: number
  sdp: RTCSessionDescriptionInit
  tracks: VoiceTrackRef[]
} {
  const tracks: VoiceTrackRef[] =
    options.bound && options.sendMid && options.selfPeerID
      ? [
          {
            mid: options.sendMid,
            publicationId: publicationOf(options.selfPeerID),
          },
        ]
      : []
  return {
    // 原样带回：服务端拿它跟 pending 比，不等就整条拒绝。
    revision: options.description.revision,
    sdp: { type: 'answer', sdp: options.sdp },
    tracks,
  }
}
