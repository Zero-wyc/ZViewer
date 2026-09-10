/**
 * LRC 歌词解析工具（参考 Hydrogen utils/lyricCore.js 的归一化思路）。
 *
 * 输入为网易云 /lyric 接口的原始 LRC 文本（lrc.lyric 原文 / tlyric.lyric 翻译），
 * 输出按时间升序的歌词行数组，翻译按时间戳合并到对应原文行。
 */

/** 单行歌词（含可选翻译与罗马音） */
export interface LyricLine {
  /** 该行起始时间（秒） */
  time: number
  /** 原文文本 */
  text: string
  /** 翻译文本（无翻译时缺省） */
  translation?: string
  /** 罗马音文本（无罗马音时缺省，/lyric rlyric） */
  roman?: string
}

/** 时间标签：[mm:ss]、[mm:ss.xx]、[mm:ss.xxx]（分最多 3 位，毫秒 1-3 位） */
const TIME_TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\]/g

/** 翻译与原文的时间戳匹配容差（秒） */
const TRANSLATION_MATCH_TOLERANCE_SEC = 0.05

/**
 * 解析单份 LRC 文本为歌词行数组（按时间升序）。
 * - 行首连续多个时间标签（如 `[00:01.0][00:05.0]词`）展开为多行
 * - [ti:] [ar:] 等元数据标签不匹配时间格式，随空文本行一并过滤
 */
function parseLrcText(lrc: string): LyricLine[] {
  if (!lrc) return []
  const lines: LyricLine[] = []
  for (const rawLine of lrc.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    TIME_TAG_RE.lastIndex = 0
    const times: number[] = []
    let consumed = 0
    let match: RegExpExecArray | null
    while ((match = TIME_TAG_RE.exec(line)) !== null) {
      // 仅接受行首连续的时间标签（标签后紧跟非标签内容即视为文本开始）
      if (match.index !== consumed) break
      const minutes = parseInt(match[1], 10)
      const seconds = parseInt(match[2], 10)
      const fractionStr = match[3] ?? ''
      // ".5" → 500ms、".50" → 500ms、".500" → 500ms（按位数右补零）
      const millis = fractionStr ? parseInt(fractionStr.padEnd(3, '0'), 10) : 0
      times.push(minutes * 60 + seconds + millis / 1000)
      consumed = TIME_TAG_RE.lastIndex
    }

    const text = line.slice(consumed).trim()
    if (times.length === 0 || !text) continue
    for (const time of times) {
      lines.push({ time, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

/**
 * 合并辅助歌词（翻译 / 罗马音）到主歌词：按时间戳匹配（容差 50ms），
 * 同一行匹配到多条时以 " / " 拼接。
 */
function mergeAuxLyrics(
  main: LyricLine[],
  auxLrc: string | null | undefined,
  key: 'translation' | 'roman'
): void {
  if (!auxLrc) return
  const aux = parseLrcText(auxLrc)
  if (main.length === 0 || aux.length === 0) return
  for (const t of aux) {
    let best: LyricLine | null = null
    let bestDiff = Number.POSITIVE_INFINITY
    for (const m of main) {
      const diff = Math.abs(m.time - t.time)
      if (diff < bestDiff) {
        bestDiff = diff
        best = m
      }
      // main 已按时间升序，越过容差窗口即可提前结束
      if (m.time > t.time + TRANSLATION_MATCH_TOLERANCE_SEC) break
    }
    if (best && bestDiff <= TRANSLATION_MATCH_TOLERANCE_SEC) {
      const current = best[key]
      best[key] = current ? `${current} / ${t.text}` : t.text
    }
  }
}

/**
 * 合并原文歌词与翻译 / 罗马音歌词（均按时间戳匹配，容差 50ms）。
 */
export function mergeLyrics(
  original: string,
  translation?: string | null,
  roman?: string | null
): LyricLine[] {
  const main = parseLrcText(original)
  mergeAuxLyrics(main, translation, 'translation')
  mergeAuxLyrics(main, roman, 'roman')
  return main
}
