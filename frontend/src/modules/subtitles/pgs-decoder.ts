import type { ParsedCue } from '../../lib/subtitleParser'

interface Picture {
  width: number
  height: number
  data: Uint8Array
  filled: number
}
interface ObjectRef {
  id: number
  x: number
  y: number
  crop?: { x: number; y: number; width: number; height: number }
}

const u16 = (b: Uint8Array, p: number) => b[p]! * 256 + b[p + 1]!
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

/** Decode the palette-indexed RLE used by HDMV PGS (not text/OCR). */
export function decodePgsRle(
  data: Uint8Array,
  width: number,
  height: number
): Uint8Array {
  if (width <= 0 || height <= 0 || width * height > 4096 * 2160) {
    throw new Error('PGS 图像尺寸无效')
  }
  const pixels = new Uint8Array(width * height)
  let p = 0,
    x = 0,
    y = 0
  const byte = () => {
    if (p >= data.length) throw new Error('PGS RLE 数据截断')
    return data[p++]!
  }
  while (p < data.length && y < height) {
    let color = byte()
    let run = 1
    if (color === 0) {
      const flags = byte()
      if (flags === 0) {
        x = 0
        y++
        continue
      }
      run = flags & 0x3f
      if (flags & 0x40) run = run * 256 + byte()
      color = flags & 0x80 ? byte() : 0
    }
    if (run === 0 || x + run > width) throw new Error('PGS RLE 行长度无效')
    pixels.fill(color, y * width + x, y * width + x + run)
    x += run
  }
  if (y < height && !(y === height - 1 && x === width)) {
    throw new Error('PGS RLE 图像不完整')
  }
  return pixels
}

/** State survives MKV packets, including split ODS and palette-only updates.
 * A display set ends at the next PCS/clear, never at an invented text duration.
 * Wire fields follow the HDMV segment layout documented in FFmpeg pgssubdec. */
export class PgsDecoder {
  private palettes = new Map<number, Uint8ClampedArray>()
  private objects = new Map<number, Picture>()
  private refs: ObjectRef[] = []
  private width = 0
  private height = 0
  private paletteId = 0
  private presentationTime = 0
  private pending: ParsedCue[] = []

  push(data: Uint8Array, timestampMs: number): ParsedCue[] {
    const completed: ParsedCue[] = []
    for (let p = 0; p < data.length;) {
      if (p + 3 > data.length) throw new Error('PGS 段头截断')
      const type = data[p]!
      const size = u16(data, p + 1)
      p += 3
      if (p + size > data.length) throw new Error('PGS 段数据截断')
      const b = data.subarray(p, p + size)
      p += size
      if (type === 0x16) {
        if (b.length < 11) throw new Error('PGS PCS 数据截断')
        for (const cue of this.pending) {
          cue.end = timestampMs / 1000
          if (cue.end > cue.start) completed.push(cue)
        }
        this.pending = []
        this.presentationTime = timestampMs / 1000
        this.width = u16(b, 0)
        this.height = u16(b, 2)
        if (
          !this.width ||
          !this.height ||
          this.width > 4096 ||
          this.height > 2160
        ) {
          throw new Error('PGS 画布尺寸无效')
        }
        if (b[7]! & 0xc0) {
          this.palettes.clear()
          this.objects.clear()
        }
        this.paletteId = b[9]!
        this.refs = []
        let r = 11
        for (let i = 0; i < b[10]!; i++) {
          if (r + 8 > b.length) throw new Error('PGS 对象引用截断')
          const ref: ObjectRef = {
            id: u16(b, r),
            x: u16(b, r + 4),
            y: u16(b, r + 6),
          }
          const cropped = b[r + 3]! & 0x80
          r += 8
          if (cropped) {
            if (r + 8 > b.length) throw new Error('PGS 裁剪数据截断')
            ref.crop = {
              x: u16(b, r),
              y: u16(b, r + 2),
              width: u16(b, r + 4),
              height: u16(b, r + 6),
            }
            r += 8
          }
          this.refs.push(ref)
        }
      } else if (type === 0x14) {
        if (b.length < 2 || (b.length - 2) % 5)
          throw new Error('PGS 调色板无效')
        const palette = this.palettes.get(b[0]!) ?? new Uint8ClampedArray(1024)
        for (let i = 2; i < b.length; i += 5) {
          const index = b[i]! * 4
          const y = (b[i + 1]! - 16) * 1.164383
          const cr = b[i + 2]! - 128,
            cb = b[i + 3]! - 128
          palette[index] = clamp(y + 1.596027 * cr)
          palette[index + 1] = clamp(y - 0.812968 * cr - 0.391762 * cb)
          palette[index + 2] = clamp(y + 2.017232 * cb)
          palette[index + 3] = b[i + 4]!
        }
        this.palettes.set(b[0]!, palette)
      } else if (type === 0x15) {
        if (b.length < 4) throw new Error('PGS ODS 数据截断')
        const id = u16(b, 0)
        let offset = 4
        if (b[3]! & 0x80) {
          if (b.length < 11) throw new Error('PGS ODS 首段截断')
          const length = b[4]! * 65536 + u16(b, 5) - 4
          const width = u16(b, 7),
            height = u16(b, 9)
          if (
            length <= 0 ||
            length > 16 * 1024 * 1024 ||
            !width ||
            !height ||
            width * height > 4096 * 2160
          ) {
            throw new Error('PGS ODS 长度或尺寸无效')
          }
          if (!this.objects.has(id) && this.objects.size >= 64)
            throw new Error('PGS 对象过多')
          this.objects.set(id, {
            width,
            height,
            data: new Uint8Array(length),
            filled: 0,
          })
          offset = 11
        }
        const object = this.objects.get(id)
        if (!object || object.filled + b.length - offset > object.data.length) {
          throw new Error('PGS ODS 分片无效')
        }
        object.data.set(b.subarray(offset), object.filled)
        object.filled += b.length - offset
      } else if (type === 0x80) {
        this.pending = this.render()
      }
    }
    return completed
  }

  finish(endSec: number): ParsedCue[] {
    const cues = this.pending.filter((c) => endSec > c.start)
    for (const cue of cues) cue.end = endSec
    this.pending = []
    return cues
  }

  private render(): ParsedCue[] {
    const palette = this.palettes.get(this.paletteId)
    if (!this.refs.length) return [] // Explicit clear display set.
    if (!palette) throw new Error('PGS 缺少调色板')
    return this.refs.map((ref) => {
      const object = this.objects.get(ref.id)
      if (!object || object.filled !== object.data.length)
        throw new Error('PGS 对象不完整')
      const pixels = decodePgsRle(object.data, object.width, object.height)
      const crop = ref.crop ?? {
        x: 0,
        y: 0,
        width: object.width,
        height: object.height,
      }
      const width = Math.min(
        crop.width,
        object.width - crop.x,
        this.width - ref.x
      )
      const height = Math.min(
        crop.height,
        object.height - crop.y,
        this.height - ref.y
      )
      if (width <= 0 || height <= 0) throw new Error('PGS 字幕位置无效')
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('浏览器无法创建 PGS 画布')
      const image = ctx.createImageData(width, height)
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const color = pixels[(y + crop.y) * object.width + x + crop.x]! * 4
          image.data.set(
            palette.subarray(color, color + 4),
            (y * width + x) * 4
          )
        }
      }
      ctx.putImageData(image, 0, 0)
      return {
        start: this.presentationTime,
        end: this.presentationTime,
        text: '',
        bitmap: {
          src: canvas.toDataURL('image/png'),
          x: ref.x,
          y: ref.y,
          width,
          height,
          canvasWidth: this.width,
          canvasHeight: this.height,
        },
      }
    })
  }
}
