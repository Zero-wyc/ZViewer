/**
 * NAT 端口预测（对称 NAT 下的直连抢救）。
 *
 * 逐段搬 Piik `src/client/webrtc/nat-prediction.ts` + `src/shared/nat-candidate.ts`
 * （MIT）。只删掉 Piik 原生客户端特有的那部分（`candidate:nsN` 的 survey 候选、
 * 原生 trickle 的 generation 归属），保留全部判定与节流逻辑。
 *
 * ## 它到底在解决什么
 *
 * 对称 NAT / CGNAT 会**按目的地址**分配映射端口：朝 STUN A 得到的公网端口，
 * 拿到对端 B 上去用是不通的。但绝大多数实现在分配新映射时是**顺序**的
 * （+1、+2 或某个固定步长）。于是：
 *
 *  1. 让同一个本地 socket 向多个 STUN 服务器各打一次 Binding Request，
 *     得到同一公网 IP 上的多个公网端口；
 *  2. 如果这些端口呈**等差**（步长恒定，且至少 3 个观测点），就能推出
 *     「下一个映射大概是多少」；
 *  3. 按最高点往上、最低点往下各预测 4 个端口，作为额外的 srflx 候选**追加**
 *     到正常候选流里（不延迟、不替换 stock ICE）；
 *  4. 对端收到这些候选时照常 addIceCandidate——错的预测会被 ICE 直接丢弃，
 *     所以整条链路是「多花几个包，换一次可能的直连」。
 *
 * ## 三条不可动的纪律
 *
 *  1. **不改 stock ICE**：普通候选必须按原时序照发，预测只是追加。
 *  2. **预测有预算**：最多 8 个（`NAT_PREDICTION_STEPS × 2`），不能挤占正常
 *     候选的 ICE 预算。
 *  3. **证据必须同源**：只有「同一个本地 socket + 同一个公网 IP + 同一个
 *     m-line/foundation」的观测，才允许拼成一条端口序列。混着算会把不同
 *     socket 的偏移误当成 NAT 的步长——预测全错，还白烧预算。
 *
 * 本文件**不允许有运行时 import**：测试用 node --experimental-strip-types 直接
 * 加载它（Piik 把候选来源判定放在 `shared/nat-candidate.ts`，这里合并进同一个
 * 文件，就是为了这条约束）。
 */

/**
 * 一个候选的线上形态（ZViewer 的 `HostSignal` / `ViewerSignal` 都用它）。
 *
 * `candidate` 允许缺省：这样它同时能接 `RTCIceCandidateInit`（线上解出来的
 * 形态）与 `NatPredictionCandidateEmitter` 自己拼出来的完整候选。
 */
export type SignalCandidate = {
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
} | null

/** 候选的来源：`end` = 收集结束标记，`predicted` = 我们推算出来的。 */
export type CandidateSignalOrigin = 'end' | 'ordinary' | 'predicted'

/** 预测候选的 foundation 前缀：`spN`（往上第 N 个）/ `smN`（往下第 N 个）。 */
export function isPredictedCandidateFoundation(
  foundation: string | null
): boolean {
  return foundation !== null && /^s[pm]\d+$/.test(foundation)
}

/**
 * 从候选字符串判断来源。
 *
 * 只认 foundation：预测候选是我们自己拼出来的，foundation 写成 `sp1`/`sm1`
 * 这种形式（Piik 同口径），接收侧据此决定「被拒了要不要当错误」。
 */
export function candidateSignalOrigin(
  candidate: string | null
): CandidateSignalOrigin {
  if (candidate === null || candidate.trim() === '') return 'end'
  return /^candidate:s[pm]\d+\s/i.test(candidate) ? 'predicted' : 'ordinary'
}

const DEFAULT_STUN_PORT = 3478
const MIN_PREDICTABLE_PORT = 1
const MAX_PREDICTABLE_PORT = 65_535

/** 每个方向预测几步。 */
export const NAT_PREDICTION_STEPS = 4
/** 一次预测最多发几个候选（两个方向合计）。 */
export const MAX_NAT_PREDICTION_CANDIDATES = NAT_PREDICTION_STEPS * 2

interface SrflxObservation {
  candidate: NonNullable<SignalCandidate>
  fields: string[]
  address: string
  port: number
  groupKey: string
}

function urlsOf(server: RTCIceServer): readonly string[] {
  return Array.isArray(server.urls) ? server.urls : [server.urls]
}

function cloneIceServer(server: RTCIceServer): RTCIceServer {
  return {
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  }
}

/**
 * `stun:` URL 归一化。
 *
 * 两个坑：`new URL()` 会把 `stun:host` 解析成一团（所以要借 `http://` 解析
 * authority），以及它会把显式的 `:80` 吃掉——而 STUN 的默认端口是 3478
 * （RFC 7064），不能拿 80 当缺省。
 */
function normalizedStunUrl(url: string): string | null {
  if (!/^stun:/i.test(url)) return null
  const authority = url.slice(url.indexOf(':') + 1)
  let parsed: URL
  try {
    parsed = new URL(`http://${authority}`)
  } catch {
    return null
  }
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    return null
  }
  const hostname = parsed.hostname.startsWith('[')
    ? parsed.hostname.toLowerCase()
    : parsed.hostname.includes(':')
      ? `[${parsed.hostname.toLowerCase()}]`
      : parsed.hostname.toLowerCase()
  const explicitPort = /:(\d+)$/.exec(authority)?.[1]
  const port =
    explicitPort === undefined ? DEFAULT_STUN_PORT : Number(explicitPort)
  return `stun:${hostname}:${port}`
}

/**
 * 哪几个 STUN 目的地可以充当「survey 证据」。
 *
 * 需要**恰好两个**辅助目的地（`auxiliaryStunUrls`）加一个基准：辅助的两个
 * 是服务端/配置指定的「同一批观测」，基准取普通列表里第一个 :3478 的
 * （不依赖发现顺序，Piik `Hosted` 的既有口径）。
 *
 * 辅助数量不是 2 就返回空集——那表示这个部署没打算做预测，调用方据此关闭。
 */
export function natPredictionSurveyUrls(
  iceServers: readonly RTCIceServer[] | undefined,
  auxiliaryStunUrls: readonly string[] = []
): ReadonlySet<string> {
  const configuredAuxiliaryUrls = new Set(
    auxiliaryStunUrls.flatMap((url) => {
      const normalized = normalizedStunUrl(url)
      return normalized ? [normalized] : []
    })
  )
  if (configuredAuxiliaryUrls.size !== 2) return new Set()
  const ordinary = (iceServers ?? [])
    .flatMap(urlsOf)
    .map(normalizedStunUrl)
    .filter(
      (url): url is string => url !== null && !configuredAuxiliaryUrls.has(url)
    )
  const base =
    ordinary.find((url) => url.endsWith(`:${DEFAULT_STUN_PORT}`)) ?? ordinary[0]
  return base ? new Set([base, ...configuredAuxiliaryUrls]) : new Set()
}

/**
 * 把缺失的 survey 目的地补进 ICE 配置。
 *
 * 只**追加**，不改顺序、不删已有的：普通 STUN 列表是服务端/配置给的事实，
 * 预测只是借其中几个多打两次 Binding Request（Piik `nat-prediction.ts:135-163`）。
 */
export function iceServersWithNatPrediction(
  iceServers: readonly RTCIceServer[] | undefined,
  enabled: boolean,
  auxiliaryStunUrls: readonly string[] = []
): RTCIceServer[] {
  const base = (iceServers ?? []).map(cloneIceServer)
  if (!enabled) return base
  const additions = new Set<string>()
  const existing = new Set(
    (iceServers ?? [])
      .flatMap((server) => urlsOf(server))
      .map((url) => normalizedStunUrl(url) ?? url)
  )
  for (const url of auxiliaryStunUrls) {
    const normalized = normalizedStunUrl(url)
    if (normalized && !existing.has(normalized)) {
      additions.add(url)
      existing.add(normalized)
    }
  }
  return [...base, ...Array.from(additions, (url) => ({ urls: url }))]
}

/**
 * 解析一条 srflx 候选。
 *
 * 只接受 UDP + `typ srflx` + 合法端口：host/relay 候选的公网端口不反映 NAT
 * 的分配规律，拿它们算步长只会得到垃圾。
 */
function parseSrflxCandidate(
  candidate: SignalCandidate
): SrflxObservation | null {
  const raw = candidate?.candidate?.trim() ?? ''
  if (!raw) return null
  const fields = raw.split(/\s+/)
  const typeIndex = fields.findIndex((field) => field.toLowerCase() === 'typ')
  if (
    fields.length < 8 ||
    !fields[0]?.toLowerCase().startsWith('candidate:') ||
    fields[2]?.toLowerCase() !== 'udp' ||
    typeIndex < 0 ||
    fields[typeIndex + 1]?.toLowerCase() !== 'srflx'
  ) {
    return null
  }
  const address = fields[4]
  const port = Number(fields[5])
  if (
    !address ||
    !Number.isInteger(port) ||
    port < MIN_PREDICTABLE_PORT ||
    port > MAX_PREDICTABLE_PORT
  ) {
    return null
  }
  const related = (name: string): string => {
    const index = fields.findIndex((field) => field.toLowerCase() === name)
    return index < 0 ? '' : (fields[index + 1] ?? '')
  }
  // 一个公网 IP 背后可能有多个本地 socket。这里把「本地基数」也编进分组键，
  // 避免把不同 socket 的端口偏移混成一条序列——那会让步长判断全错。
  // 缺字段（浏览器打码/省字段）时退化成「按 m-line + foundation + 公网 IP」
  // 分组，也就是 Piik 的「有界 Browser 假设」。
  const groupKey = [
    candidate.sdpMid ?? '',
    candidate.sdpMLineIndex ?? '',
    fields[1],
    related('raddr'),
    related('rport'),
    address,
  ].join('/')
  return {
    candidate: { ...candidate, candidate: raw },
    fields,
    address,
    port,
    groupKey,
  }
}

function distinctObservations(
  observations: readonly SrflxObservation[]
): SrflxObservation[] {
  const seen = new Set<string>()
  return observations.filter((observation) => {
    const key = `${observation.groupKey}/${observation.port}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 取出等差的步长；不是等差（或观测点不足 3 个）返回 null。
 *
 * 3 个点是最低要求：两个点永远能连成一条线，那不叫规律。
 */
function stableStep(observations: readonly SrflxObservation[]): number | null {
  if (observations.length < 3) return null
  const sorted = [...observations].sort((left, right) => left.port - right.port)
  const step = sorted[1]!.port - sorted[0]!.port
  if (
    step <= 0 ||
    sorted.some(
      (observation, index) =>
        index > 0 && observation.port - sorted[index - 1]!.port !== step
    )
  ) {
    return null
  }
  return step
}

/**
 * 从最高点往上、最低点往下各推 `NAT_PREDICTION_STEPS` 个端口。
 *
 * foundation 写成 `spN` / `smN`：既让接收侧能识别「这是预测的，被拒不算错」，
 * 也让这些候选在 ICE 眼里是不同的 foundation（不会被当成同一候选去重）。
 */
function predictedAround(
  low: SrflxObservation,
  high: SrflxObservation,
  step: number
): NonNullable<SignalCandidate>[] {
  const predicted: NonNullable<SignalCandidate>[] = []
  for (const [anchor, direction] of [
    [high, 1],
    [low, -1],
  ] as const) {
    for (let index = 1; index <= NAT_PREDICTION_STEPS; index += 1) {
      const port = anchor.port + direction * step * index
      if (port < MIN_PREDICTABLE_PORT || port > MAX_PREDICTABLE_PORT) continue
      const fields = [...anchor.fields]
      fields[0] = `candidate:s${direction > 0 ? 'p' : 'm'}${index}`
      fields[5] = String(port)
      predicted.push({ ...anchor.candidate, candidate: fields.join(' ') })
    }
  }
  return predicted
}

/**
 * 给一组观测算出预测候选。
 *
 * 只对**第一组**形成等差形状的观测做预测，然后直接返回：一次 ICE 代际只赌
 * 一个假设，赌错了也不该继续烧预算（Piik 同口径）。
 */
export function predictSrflxCandidates(
  candidates: readonly SignalCandidate[]
): NonNullable<SignalCandidate>[] {
  const groups = new Map<string, SrflxObservation[]>()
  for (const candidate of candidates) {
    const observation = parseSrflxCandidate(candidate)
    if (!observation) continue
    const group = groups.get(observation.groupKey) ?? []
    group.push(observation)
    groups.set(observation.groupKey, group)
  }
  for (const group of groups.values()) {
    const distinct = distinctObservations(group)
    const step = stableStep(distinct)
    if (step === null) continue
    const ordered = [...distinct].sort((left, right) => left.port - right.port)
    return predictedAround(ordered[0]!, ordered.at(-1)!, step).slice(
      0,
      MAX_NAT_PREDICTION_CANDIDATES
    )
  }
  return []
}

/**
 * 一条 ICE 代际的候选出口。
 *
 * 普通候选**立刻**转发（时序不能变），srflx 候选额外记一份用于推断；一旦
 * 观测凑出等差序列，就把预测候选追加进去，且只追加一次。
 */
export class NatPredictionCandidateBatch {
  private readonly observedSrflx: NonNullable<SignalCandidate>[] = []
  private predictionsSent = false
  private completed = false
  private readonly send: (candidate: SignalCandidate) => void

  constructor(send: (candidate: SignalCandidate) => void) {
    this.send = send
  }

  add(
    candidate: NonNullable<SignalCandidate>,
    predictionEligible = true
  ): void {
    if (this.completed) return
    if (!parseSrflxCandidate(candidate)) {
      this.send(candidate)
      return
    }
    if (predictionEligible) {
      this.observedSrflx.push(candidate)
      this.trySendPredictions()
    }
    this.send(candidate)
  }

  complete(end: SignalCandidate = null): void {
    if (this.completed) return
    this.trySendPredictions()
    this.send(end)
    this.completed = true
  }

  discard(): void {
    this.completed = true
    this.observedSrflx.length = 0
  }

  private trySendPredictions(): void {
    if (this.predictionsSent) return
    const predictions = predictSrflxCandidates(this.observedSrflx)
    if (predictions.length === 0) return
    for (const candidate of predictions) this.send(candidate)
    this.predictionsSent = true
  }
}

function signalCandidate(
  candidate: RTCIceCandidate
): NonNullable<SignalCandidate> {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid,
    sdpMLineIndex: candidate.sdpMLineIndex,
    usernameFragment: candidate.usernameFragment,
  }
}

/**
 * 本地 ICE 代际的所有者：包住发送函数，负责「哪些候选能当证据」与代际切换。
 *
 * 代际用 `usernameFragment` 认：ICE restart 会换 ufrag，此时旧观测一律作废
 * （否则会拿上一代的端口序列去预测这一代）。
 */
export class NatPredictionCandidateEmitter {
  private batch: NatPredictionCandidateBatch | null = null
  private generation: NonNullable<SignalCandidate> | null = null
  private endSent = false
  private surveyUrls = new Set<string>()
  private readonly enabled: boolean
  private readonly send: (candidate: SignalCandidate) => void

  constructor(
    enabled: boolean,
    send: (candidate: SignalCandidate) => void,
    surveyUrls: ReadonlySet<string> = new Set()
  ) {
    this.enabled = enabled
    this.send = send
    this.setSurveyUrls(surveyUrls)
  }

  setSurveyUrls(urls: ReadonlySet<string>): void {
    this.surveyUrls = new Set(
      [...urls].flatMap((url) => {
        const normalized = normalizedStunUrl(url)
        return normalized ? [normalized] : []
      })
    )
  }

  /**
   * 喂一条本地候选（`RTCIceCandidate` 原对象，**不要先 toJSON()**）。
   *
   * 只有 `url` 落在 survey 集合里的 srflx 才算证据——那是「同一个 socket 朝
   * 指定目的地打出来的映射」。其它服务器给的 srflx 照样转发，但不参与推断。
   */
  add(candidate: RTCIceCandidate | null): void {
    const serverUrl = (
      candidate as (RTCIceCandidate & { url?: string | null }) | null
    )?.url
    const candidateUrl = serverUrl ? normalizedStunUrl(serverUrl) : null
    this.addSignal(
      candidate ? signalCandidate(candidate) : null,
      candidateUrl !== null && this.surveyUrls.has(candidateUrl)
    )
  }

  /** 原生 trickle 与浏览器 trickle 共用同一个代际所有者。 */
  addSignal(next: SignalCandidate, predictionEligible: boolean): void {
    if (!next || next.candidate === '') {
      // 迟到的 end 可能属于上一代：只转发，不去结算新一代的批。
      if (
        next?.usernameFragment &&
        this.generation?.usernameFragment &&
        next.usernameFragment !== this.generation.usernameFragment
      ) {
        this.send(next)
      } else {
        this.completeBatch(next)
      }
      return
    }
    if (
      this.batch &&
      this.generation?.usernameFragment &&
      next.usernameFragment &&
      next.usernameFragment !== this.generation.usernameFragment
    ) {
      // ICE restart：旧观测作废；这里若发一个 end 标记，会把新代际在候选到达
      // 之前就结算掉。
      this.discard()
    }
    if (!this.batch) {
      this.generation = next
      this.endSent = false
      this.batch = new NatPredictionCandidateBatch(this.send)
    }
    this.batch.add(next, this.enabled && predictionEligible)
  }

  gatheringComplete(): void {
    this.completeBatch()
  }

  discard(): void {
    this.batch?.discard()
    this.batch = null
    this.generation = null
    this.endSent = false
  }

  private completeBatch(end: SignalCandidate = null): void {
    if (!this.batch) {
      if (!this.endSent && end?.usernameFragment) {
        this.send(end)
        this.generation = end
        this.endSent = true
      }
      return
    }
    // 未带 ufrag 的 end 归属最新一代：把它挂到真正结束收集的那批候选上。
    const marker = end?.usernameFragment
      ? end
      : this.generation?.usernameFragment
        ? { ...this.generation, candidate: '' }
        : null
    this.batch.complete(marker)
    this.batch = null
    this.endSent = true
  }
}

/**
 * 加远端候选。
 *
 * 预测候选被拒是**正常事件**（猜错端口而已），不能让它变成「连接错误」；
 * 普通候选被拒才是真问题，照旧抛出（Piik `nat-prediction.ts:35-54`）。
 */
export async function addRemoteIceCandidate(
  connection: RTCPeerConnection,
  candidate: SignalCandidate
): Promise<void> {
  try {
    await connection.addIceCandidate(candidate)
  } catch (error) {
    if (
      !(error instanceof DOMException && error.name === 'OperationError') &&
      candidateSignalOrigin(candidate?.candidate ?? null) !== 'predicted'
    ) {
      throw error
    }
  }
}
