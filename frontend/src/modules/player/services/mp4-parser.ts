/**
 * MP4 Box 解析器
 *
 * 用于解析 fragmented MP4 (fMP4) 文件结构，支持：
 * - 找到 init segment 边界（ftyp + moov 连续区域的结束位置）
 * - 解析 mvhd 获取视频时长（秒）
 * - 在数据中扫描第一个完整的 moof box 边界
 *
 * 用于 MSE seek 到未缓冲区域时，通过 Range 请求从目标位置附近开始下载，
 * 避免从头下载导致的长时间等待。
 */

interface BoxInfo {
  type: string
  offset: number
  size: number
  end: number
}

/** 读取大端 uint32 */
function readU32(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) |
      (data[offset + 1] << 16) |
      (data[offset + 2] << 8) |
      data[offset + 3]) >>>
    0
  )
}

/** 读取大端 uint64（返回 number，对于时间戳够用） */
function readU64(data: Uint8Array, offset: number): number {
  const hi = readU32(data, offset)
  const lo = readU32(data, offset + 4)
  return hi * 0x100000000 + lo
}

/** 读取 4 字节 ASCII type */
function readType(data: Uint8Array, offset: number): string {
  return String.fromCharCode(
    data[offset],
    data[offset + 1],
    data[offset + 2],
    data[offset + 3]
  )
}

/**
 * 解析单个 box header。
 * @returns box 信息，或 null 如果数据不足
 */
function parseBox(data: Uint8Array, offset: number): BoxInfo | null {
  if (offset + 8 > data.length) return null

  let size = readU32(data, offset)
  const type = readType(data, offset + 4)
  let headerSize = 8

  if (size === 1) {
    // extended size（64 位）
    if (offset + 16 > data.length) return null
    size = readU64(data, offset + 8)
    headerSize = 16
  } else if (size === 0) {
    // box 延伸到文件末尾
    size = data.length - offset
  }

  if (size < headerSize) return null

  return { type, offset, size, end: offset + size }
}

/**
 * 遍历顶层数据中的所有 box。
 */
function* iterBoxes(data: Uint8Array, start: number = 0): Generator<BoxInfo> {
  let offset = start
  while (offset < data.length) {
    const box = parseBox(data, offset)
    if (!box) break
    yield box
    offset = box.end
  }
}

/**
 * 找到 init segment 的字节大小（ftyp + moov 连续区域的结束位置）。
 *
 * fMP4 文件的 init segment 由 ftyp + moov 组成，在文件开头连续排列。
 * moov 之后是 sidx（可选）和 moof + mdat（媒体分片）。
 *
 * @param data 文件头部数据（至少包含完整的 ftyp + moov）
 * @returns init segment 大小，或 null 如果未找到 moov
 */
export function findInitSegmentSize(data: Uint8Array): number | null {
  let initEnd = 0
  for (const box of iterBoxes(data, 0)) {
    if (box.type === 'ftyp') {
      initEnd = box.end
    } else if (box.type === 'moov') {
      initEnd = box.end
      return initEnd
    } else {
      // ftyp 和 moov 应该是连续的前两个 box
      break
    }
  }
  return null
}

/**
 * 从 moov box 中解析 mvhd，获取媒体时长（秒）。
 *
 * mvhd（Movie Header Box）包含 timescale 和 duration，
 * duration（秒）= duration / timescale。
 *
 * @param data 文件头部数据（至少包含完整的 moov）
 * @returns { duration, timescale } 或 null 如果解析失败
 */
export function parseMvhdDuration(
  data: Uint8Array
): { duration: number; timescale: number } | null {
  // 找到 moov box
  let moovBox: BoxInfo | null = null
  for (const box of iterBoxes(data, 0)) {
    if (box.type === 'moov') {
      moovBox = box
      break
    }
  }
  if (!moovBox) return null

  // 在 moov 内部找 mvhd（mvhd 通常是 moov 的第一个子 box）
  const moovData = data.subarray(moovBox.offset + 8, moovBox.end)
  for (const box of iterBoxes(moovData, 0)) {
    if (box.type === 'mvhd') {
      const mvhdData = moovData.subarray(box.offset + 8, box.end)
      if (mvhdData.length < 4) return null
      const version = mvhdData[0]
      let offset = 4 // version(1) + flags(3)

      if (version === 1) {
        // version 1: creation_time(8) + modification_time(8) + timescale(4) + duration(8)
        if (mvhdData.length < offset + 28) return null
        offset += 16 // creation_time + modification_time
        const timescale = readU32(mvhdData, offset)
        const duration = readU64(mvhdData, offset + 4)
        return { duration: duration / timescale, timescale }
      } else {
        // version 0: creation_time(4) + modification_time(4) + timescale(4) + duration(4)
        if (mvhdData.length < offset + 16) return null
        offset += 8 // creation_time + modification_time
        const timescale = readU32(mvhdData, offset)
        const duration = readU32(mvhdData, offset + 4)
        return { duration: duration / timescale, timescale }
      }
    }
  }
  return null
}

/**
 * 在数据中查找第一个完整的 moof box 的起始偏移量。
 *
 * 当从文件中间位置开始下载时，数据开头可能不是完整的 box。
 * 此函数扫描数据，找到 'moof' 标记并验证其完整性。
 *
 * @param data 从中间位置开始下载的数据
 * @returns moof box 起始偏移量，或 null 如果未找到完整 moof
 */
export function findFirstMoof(data: Uint8Array): number | null {
  // 'moof' 的 ASCII 码：0x6D 0x6F 0x6F 0x66
  for (let i = 4; i <= data.length - 8; i++) {
    if (
      data[i] === 0x6d && // 'm'
      data[i + 1] === 0x6f && // 'o'
      data[i + 2] === 0x6f && // 'o'
      data[i + 3] === 0x66 // 'f'
    ) {
      // size 字段在 type 之前 4 字节
      const boxOffset = i - 4
      if (boxOffset < 0) continue

      // 验证 box header 的有效性
      const box = parseBox(data, boxOffset)
      if (box && box.type === 'moof' && box.end <= data.length) {
        return boxOffset
      }
    }
  }
  return null
}
