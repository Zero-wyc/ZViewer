/**
 * EBML 二进制读取原语。
 *
 * Matroska/MKV 以 EBML（Extensible Binary Meta Language）编码：
 * - Element = ID(VINT) + Size(VINT) + Data
 * - ID 与 Size 都是「可变长度整数」，首字节前导 1 的个数决定总字节数
 *
 * 提供流式友好的读取器：数据不完整时精确报告需要多少字节，
 * 由上层 demuxer 追加数据后重试。
 */

/**
 * 读取 EBML VINT（DataSize 形式，不带长度位保留）。
 *
 * @returns value 与消耗字节数；字节不足时返回 null 并给出需要的字节数
 */
export function readVint(
  view: DataView,
  offset: number,
  available: number
): { value: number; length: number } | null | 'need-more' {
  if (available < 1) return 'need-more'
  const first = view.getUint8(offset)
  if (first === 0) {
    // 长度超过 8 字节的 VINT（理论上 ID 不可能），按 need-more 处理避免死循环
    return 'need-more'
  }
  let length = 0
  let mask = 0x80
  while (mask !== 0 && !(first & mask)) {
    length++
    mask >>= 1
  }
  length += 1
  if (available < length) return 'need-more'
  // 清除首字节的前导标志位后累加后续字节
  let value = first & (mask ? mask - 1 : 0xff)
  for (let i = 1; i < length; i++) {
    value = value * 256 + view.getUint8(offset + i)
  }
  return { value, length }
}

/**
 * 读取 EBML Element ID（保留前导位本身，用于与已知常量比较）。
 * 与 readVint 的区别：不清除标记位，ID 直接按整字节拼接比较。
 */
export function readElementId(
  view: DataView,
  offset: number,
  available: number
): { id: number; length: number } | null | 'need-more' {
  if (available < 1) return 'need-more'
  const first = view.getUint8(offset)
  if (first === 0) return 'need-more'
  let length = 1
  let mask = 0x80
  while (!(first & mask)) {
    length++
    mask >>= 1
    if (length > 4) return null // ID 最长 4 字节，超出视为坏数据
  }
  if (available < length) return 'need-more'
  let id = first
  for (let i = 1; i < length; i++) {
    id = id * 256 + view.getUint8(offset + i)
  }
  return { id, length }
}

/** EBML 元素解析结果 */
export interface EbmlElement {
  /** 元素 ID（含前导位的原始值） */
  id: number
  /** 数据区相对 dataStart 的字节长度（unknown 时为 -1） */
  size: number
  /** 数据区起始绝对偏移 */
  dataStart: number
  /** 整个元素的结束偏移（unknown 元素为 -1） */
  end: number
}

/** ID 常量（Matroska 规范） */
export const EBML_IDS = {
  EBML_HEADER: 0x1a45dfa3,
  VOID: 0xec,
  CRC32: 0xbf,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  TRACK_NAME: 0x536e,
  TRACK_LANGUAGE: 0x22b59e,
  CONTENT_ENCODINGS: 0x6240,
  CONTENT_ENCODING: 0x2240,
  CONTENT_COMPRESSION: 0x5034,
  CONTENT_COMP_ALGO: 0x4254,
  AUDIO: 0xe1,
  SAMPLING_FREQ: 0xb5,
  CHANNELS: 0x9f,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  CLUSTER: 0x1f43b675,
  TIMECODE: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
} as const

/** TrackType 枚举值 */
export const TRACK_TYPE = { VIDEO: 1, AUDIO: 2, SUBTITLE: 17 } as const

/** 判断是否 unknown-size（全 1 的 Size VINT） */
export function isUnknownSize(firstByteOfSize: number): boolean {
  return firstByteOfSize === 0xff
}
