import type { VoiceTransport } from '../types'

/**
 * 从 RTCPeerConnection 解析当前生效的媒体传输协议。
 *
 * 取 getStats 里被选中的 candidate-pair（Chrome 的 `selected`、规范的
 * `nominated + succeeded`），再读它本地候选的 protocol。经 TURN 中继时
 * 得到的就是中继出线协议——这正是用户想知道的那条。
 *
 * 两条语音实现（LiveKit / 自建 SFU）共用：不管谁建的 PC，判定口径必须一致，
 * 否则同一个界面上徽标会随实现漂移。
 */
export async function detectTransportProtocol(
  pc: RTCPeerConnection | undefined | null
): Promise<VoiceTransport | null> {
  if (!pc || pc.connectionState === 'closed') return null
  try {
    const stats = await pc.getStats()
    let localId: string | null = null
    const protocols = new Map<string, string>()
    stats.forEach((report) => {
      const r = report as unknown as {
        type: string
        id: string
        state?: string
        selected?: boolean
        nominated?: boolean
        localCandidateId?: string
        protocol?: string
      }
      if (r.type === 'candidate-pair') {
        if (
          r.selected === true ||
          (r.state === 'succeeded' && r.nominated === true)
        ) {
          localId = r.localCandidateId ?? null
        }
      } else if (
        r.type === 'local-candidate' &&
        typeof r.protocol === 'string'
      ) {
        protocols.set(r.id, r.protocol)
      }
    })
    if (!localId) return null
    const protocol = protocols.get(localId)
    return protocol === 'tcp' ? 'tcp' : protocol === 'udp' ? 'udp' : null
  } catch {
    return null
  }
}
