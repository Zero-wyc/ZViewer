/**
 * P2P 连接日志：把 ICE 协商的现场记成一行人话。
 *
 * 观众看不到浏览器内部的候选交换，出问题时只能描述「一直转圈」。这里把
 * 收集到的候选、STUN 是否可达、最终选中哪一对地址都记下来，报障时直接复制
 * 这段文字就能分清是「根本没拿到公网候选」还是「拿到了但打洞被 NAT 挡住」。
 *
 * 只做记录，不参与协商：状态机与编解码完全不受影响。
 */

export type ConnectionLogLevel = 'info' | 'ok' | 'warn' | 'error'

export interface ConnectionLogEntry {
  /** 递增序号，React key 用；重连后也不重复。 */
  id: number
  /** 毫秒时间戳。 */
  at: number
  level: ConnectionLogLevel
  /** i18n key（中文原文，可含 `{{...}}`）。 */
  message: string
  /** 插值参数，渲染时交给 `t(message, vars)`。 */
  vars?: Record<string, string | number>
  /** 不翻译的原始细节（连接 ID、错误码），复制日志时附在行尾。 */
  detail?: string
}

/**
 * 面板最多保留的条数。一次协商二十来条，200 条够回溯几轮重连；
 * 再多既占内存也没人往下翻。
 */
export const CONNECTION_LOG_LIMIT = 200

/** 追加一条并把长度压回上限。返回新数组，交给 React 判等。 */
export function appendConnectionLog(
  entries: ConnectionLogEntry[],
  entry: ConnectionLogEntry
): ConnectionLogEntry[] {
  const overflow = entries.length + 1 - CONNECTION_LOG_LIMIT
  return overflow > 0
    ? [...entries.slice(overflow), entry]
    : [...entries, entry]
}

export interface CandidateLike {
  type?: string | null
  protocol?: string | null
  address?: string | null
  port?: number | null
}

/**
 * 把候选压成 `srflx/udp 1.2.3.4:54321`。
 *
 * `type` 是判断打洞的关键：`host` 只在同网段有用，`srflx` 才是 STUN 换来的
 * 公网地址，`relay` 说明已经在走中继。三者都拿不到时返回 null，让调用方
 * 不要记一行空日志。
 */
export function describeCandidate(
  candidate: CandidateLike | null | undefined
): string | null {
  if (!candidate) return null
  const kind = [candidate.type, candidate.protocol]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join('/')
  const address =
    typeof candidate.address === 'string' && candidate.address !== ''
      ? `${candidate.address}${
          typeof candidate.port === 'number' && candidate.port > 0
            ? `:${candidate.port}`
            : ''
        }`
      : ''
  if (kind === '' && address === '') return null
  if (kind === '') return address
  return address === '' ? kind : `${kind} ${address}`
}

export interface SelectedPairSummary {
  local: string
  remote: string
  rttMs: number | null
}

/**
 * 从 stats 里读出最终选中的那对地址。
 *
 * 浏览器只在 `transport.selectedCandidatePairId` 上标出「正在用哪条」；
 * 少数实现（旧 Safari）没有这个字段，退回按 `nominated + succeeded` 找。
 * 都找不到就返回 null——刚 connected 时 stats 还没补齐，属正常。
 */
export function describeSelectedPair(
  report: RTCStatsReport | null | undefined
): SelectedPairSummary | null {
  if (!report) return null
  const stats = new Map<string, Record<string, unknown>>()
  report.forEach((entry: unknown) => {
    if (!entry || typeof entry !== 'object') return
    const id = (entry as { id?: unknown }).id
    if (typeof id !== 'string') return
    stats.set(id, entry as Record<string, unknown>)
  })

  let pair: Record<string, unknown> | null = null
  for (const entry of stats.values()) {
    if (entry.type !== 'transport') continue
    const selected = entry.selectedCandidatePairId
    if (typeof selected !== 'string') continue
    pair = stats.get(selected) ?? null
    if (pair) break
  }
  if (!pair) {
    for (const entry of stats.values()) {
      if (entry.type !== 'candidate-pair') continue
      if (entry.state !== 'succeeded' || entry.nominated !== true) continue
      pair = entry
      break
    }
  }
  if (!pair) return null

  const summarize = (id: unknown): string => {
    if (typeof id !== 'string') return '-'
    const entry = stats.get(id)
    if (!entry) return '-'
    return (
      describeCandidate({
        type:
          typeof entry.candidateType === 'string' ? entry.candidateType : null,
        protocol: typeof entry.protocol === 'string' ? entry.protocol : null,
        address: typeof entry.address === 'string' ? entry.address : null,
        port: typeof entry.port === 'number' ? entry.port : null,
      }) ?? '-'
    )
  }

  const rtt =
    typeof pair.currentRoundTripTime === 'number'
      ? Math.round(pair.currentRoundTripTime * 1000)
      : null

  return {
    local: summarize(pair.localCandidateId),
    remote: summarize(pair.remoteCandidateId),
    rttMs: rtt,
  }
}

/**
 * 把信令里收到的 `RTCIceCandidateInit` 转成可读摘要。
 *
 * 下行候选只有一串 `candidate:...` 文本，`type`/`address` 要浏览器解析后
 * 才有。这里借 `RTCIceCandidate` 解析一次；跑在没有 WebRTC 的环境（单测、
 * 老浏览器）时直接返回 null，只是少一行日志，不影响协商。
 */
export function candidateFromInit(
  init: RTCIceCandidateInit | null | undefined
): string | null {
  if (!init) return null
  try {
    const candidate = new RTCIceCandidate(init)
    return describeCandidate({
      type: candidate.type,
      protocol: candidate.protocol,
      address: candidate.address,
      port: candidate.port,
    })
  } catch {
    return null
  }
}
