/**
 * 多格式字幕解析器（原生渲染版）
 *
 * 支持 SRT、ASS/SSA、VTT、SMI、SUB(MicroDVD) 格式，
 * 统一解析为 ParsedCue[] 供自定义 HTML/CSS 渲染层直接显示。
 *
 * 设计要点：
 * - 纯前端解析，无需后端参与
 * - 不再转换为 WebVTT，保留各格式的位置/对齐/样式信息
 * - ASS/SSA：保留 \pos 坐标定位、\an 对齐、\c 颜色、\b/\i/\u/\s 样式
 * - VTT：解析 cue settings (line/position/align)
 * - 文本输出为 HTML，支持 <b>/<i>/<u>/<s>/<br>/<span style="color:...">
 */

// ── 公共类型 ──────────────────────────────────────────────

/** 字幕格式类型 */
export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'smi' | 'sub' | 'unknown'

/** 解析后的字幕条目（统一内部格式） */
export interface ParsedCue {
  start: number // 秒
  end: number // 秒
  text: string // HTML 格式文本
  /** 垂直位置百分比 0-100（0=顶部, 100=底部），不设则使用默认底部 */
  line?: number
  /** 水平位置百分比 0-100（0=左, 100=右），不设则使用默认居中 */
  position?: number
  /** 文本对齐方式 */
  align?: 'left' | 'center' | 'right'
  /** PGS bitmap, positioned in the original presentation canvas. PNG data is
   * serializable so the same cue can be sent to room viewers. */
  bitmap?: {
    src: string
    x: number
    y: number
    width: number
    height: number
    canvasWidth: number
    canvasHeight: number
  }
}

// ── 格式检测 ──────────────────────────────────────────────

/** 从文件扩展名推断格式 */
export function detectFormatFromExtension(filename: string): SubtitleFormat {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'vtt':
      return 'vtt'
    case 'srt':
      return 'srt'
    case 'ass':
    case 'ssa':
      return 'ass'
    case 'smi':
    case 'sami':
      return 'smi'
    case 'sub':
      return 'sub'
    default:
      return 'unknown'
  }
}

/** 从内容特征推断格式（当扩展名无法判断时使用） */
export function detectFormatFromContent(content: string): SubtitleFormat {
  const trimmed = content.trim()
  if (trimmed.startsWith('WEBVTT')) return 'vtt'
  if (/^\[Script Info\]/i.test(trimmed) || /^\[Events\]/i.test(trimmed))
    return 'ass'
  if (/<SAMI>/i.test(trimmed) || /<SYNC/i.test(trimmed)) return 'smi'
  // SRT: 以数字序号开头，后跟时间码行
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(trimmed)) return 'srt'
  // MicroDVD: {帧号}{帧号}文本
  if (/^\{\d+\}\{\d+\}/m.test(trimmed)) return 'sub'
  return 'unknown'
}

/** 综合文件名和内容检测格式 */
export function detectFormat(
  filename: string,
  content: string
): SubtitleFormat {
  const byExt = detectFormatFromExtension(filename)
  if (byExt !== 'unknown') return byExt
  return detectFormatFromContent(content)
}

// ── 时间码工具 ─────────────────────────────────────────────

/** 解析 SRT/VTT 时间码 HH:MM:SS,mmm 或 HH:MM:SS.mmm → 秒 */
function parseTime(timeStr: string): number {
  const match = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/)
  if (!match) return 0
  const [, h, m, s, ms] = match
  return (
    parseInt(h) * 3600 +
    parseInt(m) * 60 +
    parseInt(s) +
    parseInt(ms.padEnd(3, '0')) / 1000
  )
}

/** 解析 ASS/SSA 时间码 H:MM:SS.CS（百分秒）→ 秒 */
function parseAssTime(timeStr: string): number {
  const match = timeStr.match(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{1,2})/)
  if (!match) return 0
  const [, h, m, s, cs] = match
  return (
    parseInt(h) * 3600 +
    parseInt(m) * 60 +
    parseInt(s) +
    parseInt(cs.padEnd(2, '0')) / 100
  )
}

// ── SRT 解析 ──────────────────────────────────────────────

function parseSrt(content: string): ParsedCue[] {
  const cues: ParsedCue[] = []
  const blocks = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n\s*\n/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 2) continue

    const timeLineIndex = lines.findIndex((l) => l.includes('-->'))
    if (timeLineIndex < 0) continue

    const timeMatch = lines[timeLineIndex].match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/
    )
    if (!timeMatch) continue

    const start = parseTime(timeMatch[1])
    const end = parseTime(timeMatch[2])
    const text = lines
      .slice(timeLineIndex + 1)
      .join('\n')
      .trim()

    if (text) {
      cues.push({ start, end, text })
    }
  }

  return cues
}

// ── VTT 解析 ──────────────────────────────────────────────

/**
 * 解析 VTT cue settings 为位置和对齐信息。
 *
 * 支持的 settings：line, position, align
 * 示例：line:50% position:50% align:center
 */
function parseVttCueSettings(
  settingsStr: string
): Pick<ParsedCue, 'line' | 'position' | 'align'> {
  const result: Pick<ParsedCue, 'line' | 'position' | 'align'> = {}

  const lineMatch = settingsStr.match(/line:(\d+(?:\.\d+)?)%/)
  if (lineMatch) result.line = parseFloat(lineMatch[1])

  const posMatch = settingsStr.match(/position:(\d+(?:\.\d+)?)%/)
  if (posMatch) result.position = parseFloat(posMatch[1])

  const alignMatch = settingsStr.match(/align:(start|center|end|left|right)/)
  if (alignMatch) {
    const a = alignMatch[1]
    if (a === 'start' || a === 'left') result.align = 'left'
    else if (a === 'end' || a === 'right') result.align = 'right'
    else result.align = 'center'
  }

  return result
}

function parseVtt(content: string): ParsedCue[] {
  const cues: ParsedCue[] = []
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  // 移除 WEBVTT 头部和元数据
  const blocks = normalized.split(/\n\s*\n/)

  for (const block of blocks) {
    const lines = block.trim().split('\n')
    if (lines.length < 2) continue

    // 跳过 WEBVTT 头部和 NOTE 块
    const firstLine = lines[0].trim()
    if (firstLine.startsWith('WEBVTT') || firstLine.startsWith('NOTE')) continue

    // 找到包含 --> 的时间码行
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'))
    if (timeLineIndex < 0) continue

    const timeLine = lines[timeLineIndex]
    const timeMatch = timeLine.match(
      /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{2}:\d{2}[,.]\d{1,3})/
    )
    if (!timeMatch) continue

    const start = parseTime(timeMatch[1])
    const end = parseTime(timeMatch[2])

    // 提取 cue settings（时间码之后的部分）
    const settingsStr = timeLine.slice(timeMatch[0].length)
    const settings = parseVttCueSettings(settingsStr)

    const text = lines
      .slice(timeLineIndex + 1)
      .join('\n')
      .trim()

    if (text) {
      cues.push({ start, end, text, ...settings })
    }
  }

  return cues
}

// ── ASS/SSA 解析 ──────────────────────────────────────────

/**
 * 从 ASS 文本行中提取位置和对齐信息。
 *
 * 支持的 ASS 标签：
 *   {\pos(x,y)}  — 绝对坐标定位（基于 PlayResX/PlayResY 换算为百分比）
 *   {\anN}       — 数字小键盘对齐（1-9），决定水平 align 和垂直 line
 */
function extractAssPosition(
  rawText: string,
  playResX: number,
  playResY: number,
  defaultAlign: number
): { line?: number; position?: number; align?: 'left' | 'center' | 'right' } {
  let line: number | undefined
  let position: number | undefined
  let align: 'left' | 'center' | 'right' | undefined

  // 提取 \pos(x,y) — 绝对坐标
  const posMatch = rawText.match(/\\pos\(([\d.]+),\s*([\d.]+)\)/)
  if (posMatch) {
    const x = parseFloat(posMatch[1])
    const y = parseFloat(posMatch[2])
    if (playResX > 0) position = (x / playResX) * 100
    if (playResY > 0) line = (y / playResY) * 100
  }

  // 提取 \anN — 数字小键盘对齐（优先于样式默认值）
  const anMatch = rawText.match(/\\an(\d)/)
  const an = anMatch ? parseInt(anMatch[1]) : defaultAlign

  if (an >= 1 && an <= 9) {
    // 水平对齐：1/4/7=左, 2/5/8=中, 3/6/9=右
    if (an === 1 || an === 4 || an === 7) align = 'left'
    else if (an === 3 || an === 6 || an === 9) align = 'right'
    else align = 'center'

    // 若无 \pos，按 \an 垂直分量设置 line
    if (line === undefined) {
      if (an <= 3)
        line = 100 // 底部
      else if (an <= 6)
        line = 50 // 中部
      else line = 0 // 顶部
    }
  }

  return { line, position, align }
}

/**
 * 将 ASS 颜色 &HBBGGRR& 或 &HAABBGGRR& 转换为 CSS #RRGGBB。
 *
 * ASS 使用 BGR 顺序，CSS 使用 RGB 顺序，需要反转。
 */
function assColorToCss(assColor: string): string | null {
  // 匹配 &HAABBGGRR& 或 &HBBGGRR&
  const match = assColor.match(/&H([0-9A-Fa-f]{6,8})&?/)
  if (!match) return null
  let hex = match[1]
  // 如果是 8 位（含 alpha），取后 6 位
  if (hex.length === 8) hex = hex.slice(2)
  if (hex.length !== 6) return null
  const bb = hex.slice(0, 2)
  const gg = hex.slice(2, 4)
  const rr = hex.slice(4, 6)
  return `#${rr}${gg}${bb}`.toUpperCase()
}

/**
 * 清理 ASS 文本中的样式覆盖标签，保留基础 HTML 标签和颜色。
 *
 * {\b1}粗体{\b0} → <b>粗体</b>
 * {\i1}斜体{\i0} → <i>斜体</i>
 * {\c&HFFFFFF&}颜色 → <span style="color:#FFFFFF">颜色</span>（到下一个颜色标签或文本结束）
 * {\N} / {\n} → <br>
 * {\h} → 不间断空格
 * {其他标签} → 剥离
 */
function cleanAssText(text: string): string {
  let result = ''
  let i = 0
  let openColorSpan = false

  const closeColorSpan = () => {
    if (openColorSpan) {
      result += '</span>'
      openColorSpan = false
    }
  }

  while (i < text.length) {
    if (text[i] === '{') {
      const end = text.indexOf('}', i)
      if (end < 0) break
      const tagContent = text.slice(i + 1, end)
      const tags = tagContent.split('\\').filter(Boolean)
      for (const tag of tags) {
        // 粗体/斜体/下划线/删除线
        const styleMatch = tag.match(/^([bis])(\d+)$/i)
        if (styleMatch) {
          const [, name, val] = styleMatch
          const isOpen = val !== '0'
          const tagMap: Record<string, string> = {
            b: isOpen ? '<b>' : '</b>',
            i: isOpen ? '<i>' : '</i>',
            s: isOpen ? '<s>' : '</s>',
          }
          if (tagMap[name.toLowerCase()]) {
            closeColorSpan()
            result += tagMap[name.toLowerCase()]
          }
          continue
        }
        // 下划线 \u
        const uMatch = tag.match(/^u(\d+)$/i)
        if (uMatch) {
          closeColorSpan()
          result += uMatch[1] !== '0' ? '<u>' : '</u>'
          continue
        }
        // 颜色 \c 或 \1c
        const cMatch = tag.match(/^1?c(&H[0-9A-Fa-f]{6,8}&?)/i)
        if (cMatch) {
          const cssColor = assColorToCss(cMatch[1])
          if (cssColor) {
            closeColorSpan()
            result += `<span style="color:${cssColor}">`
            openColorSpan = true
          }
          continue
        }
        // 恢复默认颜色 \c 带空值 — 关闭颜色 span
        if (/^1?c$/i.test(tag)) {
          closeColorSpan()
          continue
        }
      }
      i = end + 1
    } else if (
      text[i] === '\\' &&
      (text[i + 1] === 'N' || text[i + 1] === 'n')
    ) {
      // ASS 换行 \N 或 \n
      result += '<br>'
      i += 2
    } else if (text[i] === '\\' && text[i + 1] === 'h') {
      // ASS 硬空格 \h
      result += '\u00A0'
      i += 2
    } else {
      result += text[i]
      i++
    }
  }
  closeColorSpan()
  return result
}

function parseAss(content: string): ParsedCue[] {
  const cues: ParsedCue[] = []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  // 解析 [Script Info] 中的 PlayResX / PlayResY
  let playResX = 0
  let playResY = 0
  // 解析 [V4+ Styles] 中 Default 样式的 Alignment
  let defaultAlign = 2 // ASS 默认底部居中

  let currentSection = ''
  let styleFormatFields: string[] = []

  let inEvents = false
  let formatFields: string[] = []
  let textFieldIndex = -1
  let startFieldIndex = -1
  let endFieldIndex = -1

  for (const line of lines) {
    const trimmed = line.trim()

    // 检测 section
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.toLowerCase()
      inEvents = currentSection === '[events]'
      formatFields = []
      continue
    }

    // [Script Info] 解析分辨率
    if (currentSection === '[script info]') {
      const resXMatch = trimmed.match(/^PlayResX:\s*(\d+)/i)
      if (resXMatch) playResX = parseInt(resXMatch[1])
      const resYMatch = trimmed.match(/^PlayResY:\s*(\d+)/i)
      if (resYMatch) playResY = parseInt(resYMatch[1])
      continue
    }

    // [V4+ Styles] 解析默认对齐方式
    if (currentSection === '[v4+ styles]') {
      if (trimmed.toLowerCase().startsWith('format:')) {
        styleFormatFields = trimmed
          .slice(7)
          .split(',')
          .map((f) => f.trim().toLowerCase())
      } else if (
        trimmed.toLowerCase().startsWith('style:') &&
        styleFormatFields.length > 0
      ) {
        const styleData = trimmed
          .slice(6)
          .split(',')
          .map((s) => s.trim())
        const styleName = styleData[0]?.toLowerCase() ?? ''
        if (styleName === 'default') {
          const alignIdx = styleFormatFields.indexOf('alignment')
          if (alignIdx >= 0 && alignIdx < styleData.length) {
            const alignVal = parseInt(styleData[alignIdx])
            if (alignVal >= 1 && alignVal <= 9) defaultAlign = alignVal
          }
        }
      }
      continue
    }

    if (!inEvents) continue

    // 解析 Format 行
    if (trimmed.toLowerCase().startsWith('format:')) {
      formatFields = trimmed
        .slice(7)
        .split(',')
        .map((f) => f.trim().toLowerCase())
      textFieldIndex = formatFields.indexOf('text')
      startFieldIndex = formatFields.indexOf('start')
      endFieldIndex = formatFields.indexOf('end')
      continue
    }

    // 解析 Dialogue 行
    if (
      trimmed.toLowerCase().startsWith('dialogue:') &&
      formatFields.length > 0
    ) {
      const data = trimmed.slice(9)
      const parts: string[] = []
      let remaining = data
      for (let f = 0; f < formatFields.length - 1; f++) {
        const commaIdx = remaining.indexOf(',')
        if (commaIdx < 0) break
        parts.push(remaining.slice(0, commaIdx).trim())
        remaining = remaining.slice(commaIdx + 1)
      }
      parts.push(remaining.trim())

      if (startFieldIndex < 0 || endFieldIndex < 0 || textFieldIndex < 0)
        continue

      const start = parseAssTime(parts[startFieldIndex] ?? '0')
      const end = parseAssTime(parts[endFieldIndex] ?? '0')
      const rawText = parts[textFieldIndex] ?? ''
      const text = cleanAssText(rawText).trim()

      if (text && end > start) {
        const pos = extractAssPosition(
          rawText,
          playResX,
          playResY,
          defaultAlign
        )
        cues.push({ start, end, text, ...pos })
      }
    }
  }

  return cues
}

// ── SAMI (SMI) 解析 ───────────────────────────────────────

function parseSmi(content: string): ParsedCue[] {
  const cues: ParsedCue[] = []
  const syncRegex = /<SYNC\s+Start=(\d+)[^>]*>([\s\S]*?)(?=<SYNC|<\/BODY|$)/gi
  const matches: { start: number; html: string }[] = []

  let match: RegExpExecArray | null
  while ((match = syncRegex.exec(content)) !== null) {
    matches.push({
      start: parseInt(match[1]) / 1000,
      html: match[2] || '',
    })
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]
    const next = matches[i + 1]
    const end = next ? next.start : current.start + 4

    let text = current.html
    text = text.replace(/<br\s*\/?>/gi, '\n')
    text = text.replace(/<[^>]+>/g, '')
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
    text = text.trim()

    if (text) {
      cues.push({ start: current.start, end, text })
    }
  }

  return cues
}

// ── MicroDVD (SUB) 解析 ───────────────────────────────────

function parseSub(content: string): ParsedCue[] {
  const cues: ParsedCue[] = []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  let fps = 23.976
  const fpsMatch = content.match(/\{1\}\{1\}(\d+(?:\.\d+)?)/)
  if (fpsMatch) {
    const detected = parseFloat(fpsMatch[1])
    if (detected > 0 && detected < 120) fps = detected
  }

  for (const line of lines) {
    const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/)
    if (!m) continue
    const [, startFrame, endFrame, text] = m
    const start = parseInt(startFrame) / fps
    const end = parseInt(endFrame) / fps
    const cleaned = cleanSubText(text)
    if (cleaned && end > start) {
      cues.push({ start, end, text: cleaned })
    }
  }

  return cues
}

/** 清理 MicroDVD 文本中的控制字符 */
function cleanSubText(text: string): string {
  let result = text
  result = result.replace(/\{y:b\}/gi, '<b>')
  result = result.replace(/\{y:i\}/gi, '<i>')
  result = result.replace(/\{y:u\}/gi, '<u>')
  result = result.replace(/\{y:s\}/gi, '<s>')
  result = result.replace(/\{[^}]*\}/g, '')
  result = result.replace(/\|/g, '\n')
  return result.trim()
}

// ── 统一解析入口 ───────────────────────────────────────────

/**
 * 解析字幕内容为 ParsedCue[]。
 *
 * 不再转换为 WebVTT，直接输出统一的内部数据结构，
 * 保留各格式的位置/对齐/样式信息供自定义渲染层使用。
 *
 * @param content 字幕文件原始文本
 * @param format 字幕格式
 * @returns 解析后的字幕条目数组
 */
export function parseSubtitle(
  content: string,
  format: SubtitleFormat
): ParsedCue[] {
  // VTT 格式直接解析（保留 cue settings）
  if (format === 'vtt' || content.trimStart().startsWith('WEBVTT')) {
    return parseVtt(content)
  }

  switch (format) {
    case 'srt':
      return parseSrt(content)
    case 'ass':
      return parseAss(content)
    case 'smi':
      return parseSmi(content)
    case 'sub':
      return parseSub(content)
    default:
      // 未知格式尝试按 SRT 解析（最常见的兜底）
      return parseSrt(content)
  }
}

/**
 * 从文件名生成字幕标签（去掉扩展名）。
 */
export function getSubtitleLabel(filename: string): string {
  return filename.replace(/\.(vtt|srt|ass|ssa|smi|sami|sub)$/i, '')
}
