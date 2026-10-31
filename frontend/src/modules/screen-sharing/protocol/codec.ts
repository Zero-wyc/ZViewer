/**
 * 屏幕共享协议的信封编解码。
 *
 * 规则与服务端一致（Piik protocol/codec.go 的语义）：
 * - 未知 `t`、未知字段、缺必填字段一律**拒绝**，不做宽容解码；
 * - 单帧上限 64KiB。
 *
 * 这里刻意不引 zod 之类的运行时 schema 库：协议只有 6 种下行消息，
 * 手写校验比多一个依赖更容易与 Go 侧逐字段对齐。
 */
import type {
  ShareClientMessage,
  ShareErrorCode,
  ShareServerMessage,
} from './types'

/** 上下行共用的 socket.io 事件名。 */
export const SHARE_EVENT = 'share'

/**
 * 单帧上限，对齐 Piik 的 64KiB。
 *
 * SDP 与 ICE 都是小对象，超过这个体量说明构造出了畸形数据。
 */
export const SHARE_MAX_FRAME_BYTES = 64 * 1024

/** 协议错误。`code` 与服务端的 `ShareErrorCode` 同集合。 */
export class ShareProtocolError extends Error {
  readonly code: ShareErrorCode = 'INVALID_MESSAGE'

  constructor(message: string) {
    super(message)
    this.name = 'ShareProtocolError'
  }
}

/** 每种服务器消息允许出现的键（required 与 optional 的并集）。 */
const SERVER_MESSAGE_FIELDS: Record<
  ShareServerMessage['t'],
  { required: readonly string[]; optional: readonly string[] }
> = {
  'share.snapshot': {
    required: [
      't',
      'roomId',
      'shareGeneration',
      'revision',
      'paused',
      'sharing',
      'qualitySettings',
      'participants',
    ],
    optional: ['assignment'],
  },
  'share.route': {
    required: ['t', 'roomId', 'revision', 'phase', 'assignment'],
    optional: ['candidate'],
  },
  'share.status': {
    required: ['t', 'roomId', 'revision', 'state', 'reason'],
    optional: [],
  },
  'share.sfu-config': {
    required: [
      't',
      'roomId',
      'revision',
      'publicationGeneration',
      'connectionId',
    ],
    optional: [],
  },
  'share.signal-relay': {
    required: ['t', 'roomId', 'fromPeerId', 'connectionId', 'kind', 'payload'],
    optional: [],
  },
  'share.error': {
    required: ['t', 'code', 'message'],
    optional: ['roomId'],
  },
}

const PHASES = new Set(['prepare', 'active'])
const STATUS_STATES = new Set(['waiting', 'failed'])
const SIGNAL_KINDS = new Set(['offer', 'answer', 'candidate'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把一帧原始值解码成服务器消息。
 *
 * @throws {ShareProtocolError} 结构不合法、未知 `t`、未知字段、缺必填字段
 */
export function decodeServerMessage(raw: unknown): ShareServerMessage {
  if (!isRecord(raw)) {
    throw new ShareProtocolError('share frame must be a JSON object')
  }
  const type = raw.t
  if (typeof type !== 'string' || !(type in SERVER_MESSAGE_FIELDS)) {
    throw new ShareProtocolError(`unknown share message type: ${String(type)}`)
  }
  const fields = SERVER_MESSAGE_FIELDS[type as ShareServerMessage['t']]
  const allowed = new Set([...fields.required, ...fields.optional])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ShareProtocolError(`${type} has unknown field: ${key}`)
    }
  }
  for (const key of fields.required) {
    if (!(key in raw) || raw[key] === null) {
      throw new ShareProtocolError(`${type} is missing field: ${key}`)
    }
  }
  validateTypedFields(type as ShareServerMessage['t'], raw)
  return raw as unknown as ShareServerMessage
}

/** 逐类型校验会被 UI 直接消费的字段。 */
function validateTypedFields(
  type: ShareServerMessage['t'],
  raw: Record<string, unknown>
): void {
  switch (type) {
    case 'share.snapshot': {
      requireString(raw, 'roomId')
      requireString(raw, 'shareGeneration')
      requireNumber(raw, 'revision')
      requireBoolean(raw, 'paused')
      requireBoolean(raw, 'sharing')
      if (!isRecord(raw.qualitySettings)) {
        throw new ShareProtocolError('qualitySettings must be an object')
      }
      const participants = raw.participants
      if (!Array.isArray(participants)) {
        throw new ShareProtocolError('participants must be an array')
      }
      for (const item of participants) {
        validateParticipant(item)
      }
      if (raw.assignment !== undefined && !isRecord(raw.assignment)) {
        throw new ShareProtocolError('assignment must be an object')
      }
      return
    }
    case 'share.route': {
      requireNumber(raw, 'revision')
      if (typeof raw.phase !== 'string' || !PHASES.has(raw.phase)) {
        throw new ShareProtocolError(
          `invalid route phase: ${String(raw.phase)}`
        )
      }
      if (!isRecord(raw.assignment)) {
        throw new ShareProtocolError('assignment must be an object')
      }
      return
    }
    case 'share.status': {
      requireNumber(raw, 'revision')
      if (typeof raw.state !== 'string' || !STATUS_STATES.has(raw.state)) {
        throw new ShareProtocolError(
          `invalid route status: ${String(raw.state)}`
        )
      }
      requireString(raw, 'reason')
      return
    }
    case 'share.sfu-config': {
      requireNumber(raw, 'revision')
      requireString(raw, 'publicationGeneration')
      requireString(raw, 'connectionId')
      return
    }
    case 'share.signal-relay': {
      requireString(raw, 'fromPeerId')
      requireString(raw, 'connectionId')
      if (typeof raw.kind !== 'string' || !SIGNAL_KINDS.has(raw.kind)) {
        throw new ShareProtocolError(`invalid signal kind: ${String(raw.kind)}`)
      }
      return
    }
    case 'share.error': {
      requireString(raw, 'code')
      requireString(raw, 'message')
      return
    }
  }
}

function validateParticipant(value: unknown): void {
  if (!isRecord(value)) {
    throw new ShareProtocolError('participants item must be an object')
  }
  requireString(value, 'peerId')
  requireString(value, 'socketId')
  if (value.role !== 'host' && value.role !== 'viewer') {
    throw new ShareProtocolError(
      `invalid participant role: ${String(value.role)}`
    )
  }
  requireBoolean(value, 'mediaReady')
}

function requireString(raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] !== 'string') {
    throw new ShareProtocolError(`${key} must be a string`)
  }
}

function requireNumber(raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
    throw new ShareProtocolError(`${key} must be a finite number`)
  }
}

function requireBoolean(raw: Record<string, unknown>, key: string): void {
  if (typeof raw[key] !== 'boolean') {
    throw new ShareProtocolError(`${key} must be a boolean`)
  }
}

/**
 * 把一条客户端消息编码成线上字符串。
 *
 * @throws {ShareProtocolError} 超过 64KiB 单帧上限
 */
export function encodeClientMessage(message: ShareClientMessage): string {
  const text = JSON.stringify(message)
  if (frameBytes(text) > SHARE_MAX_FRAME_BYTES) {
    throw new ShareProtocolError(
      `share frame exceeds ${SHARE_MAX_FRAME_BYTES} bytes`
    )
  }
  return text
}

/** 计算一帧的 UTF-8 字节数（服务端按字节判上限）。 */
export function frameBytes(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 解析一个 socket.io 参数，失败时返回 null（供事件回调用）。 */
export function decodeServerMessageOrNull(
  raw: unknown
): ShareServerMessage | null {
  try {
    return decodeServerMessage(raw)
  } catch {
    return null
  }
}
