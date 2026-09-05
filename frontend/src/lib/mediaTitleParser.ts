/**
 * 媒体文件名 → 影视名解析器。
 *
 * 用于弹幕搜索等场景：从播放文件的原始文件名中提取「影视名」，
 * 剥离发布组标签、分辨率/编码/音轨/来源等噪声与集数后缀。
 *
 * 支持的常见命名形态：
 * - `[Dont be a simp] Bang Dream Ave Mujica-10 [CR WebRip 1080p HEVC-10bit AAC Multi-Subs].mkv`
 *   → `Bang Dream Ave Mujica`
 * - `The Movie (2023) 1080p BluRay x264-GROUP.mkv` → `The Movie`
 * - `葬送的芙莉莲 第05话 [WebRip 1080p].mkv` → `葬送的芙莉莲`
 * - `Some.Show.S01E05.720p.WEB-DL.mkv` → `Some.Show`（点分名转空格 `Some Show`）
 *
 * 无法解析时返回去扩展名后的原始文件名（保守回退，调用方可直接使用）。
 */

/** 单 token 级噪声词（小写比较）。命中即丢弃该 token。 */
const NOISE_TOKENS = new Set([
  // 分辨率/质量
  '2160p',
  '1080p',
  '1080i',
  '720p',
  '480p',
  '4k',
  '8k',
  'hdr',
  'hdr10',
  'hdr10+',
  'dv',
  'sdr',
  'remux',
  'webdl',
  'web-dl',
  'webrip',
  'webrip.',
  'bluray',
  'blu-ray',
  'bdrip',
  'hdtv',
  'dvdrip',
  'hdrip',
  'cr',
  'funi',
  'atx',
  // 编码
  'hevc',
  'h265',
  'x265',
  'h264',
  'x264',
  'avc',
  'av1',
  'vp9',
  '10bit',
  '8bit',
  'hi10p',
  // 音轨/语言/字幕
  'aac',
  'flac',
  'dts',
  'dtshd',
  'dts-hd',
  'truehd',
  'atmos',
  'ac3',
  'eac3',
  'ddp',
  'dd+',
  '5.1',
  '7.1',
  '2.0',
  'multi',
  'multi-subs',
  'multisubs',
  'subs',
  'sub',
  'chi_jp',
  'chi_jp.',
  'jpn',
  'eng',
  'chs',
  'cht',
  'gb',
  'big5',
  // 来源/介质
  'crwebrip',
  'netflix',
  'nf',
  'amzn',
  'hulu',
  'disney',
  'baha',
  'bilibili',
  'b-global',
  'ma',
  'uyu',
  // 其他常见标记
  'v2',
  'v3',
  'fin',
  'complete',
  'batch',
  'raw',
  'uncensored',
  'censored',
  'repack',
  'proper',
  'extended',
  'remastered',
  'profile',
])

/** 尾部集数/季标记模式（在已拼接的标题字符串上匹配并截断）。 */
const TRAILING_PATTERNS: RegExp[] = [
  // S01E05 / S1E5 / 1x05（含尾随 v2 等）
  /[\s._-]+\d{1,2}x\d{1,3}$/i,
  /[\s._-]+s\d{1,2}\s?e\d{1,3}(?:\s?e\d{1,3})?$/i,
  // EP/E/P/集/话/話：`- 10`、`EP10`、`第10话`、`#10`
  /[\s._-]+(?:e|ep|episode|p|#)\s*\d{1,4}$/i,
  /[\s._-]*第\s*\d{1,4}\s*[集话回話]$/i,
  // 纯数字集数：`- 10`、`_10`。注意不含 `.`——避免把 `dts5.1`
  // 这类文件名的小数点误判为集数分隔符。1900-2099 视为年份保留。
  /[\s_-]+(?!19\d{2}|20\d{2})\d{1,4}(?:v\d)?$/i,
  /[\s_-]+\d{1,4}end$/i,
]

/** 去除文件路径与 URL 包装，返回纯文件名（已解码）。 */
function toFileName(raw: string): string {
  let s = raw.trim()
  try {
    const u = new URL(s)
    s = u.pathname.split('/').pop() || s
  } catch {
    // 非 URL：可能本身是路径
    if (s.includes('/') || s.includes('\\')) {
      s = s.split(/[\\/]/).pop() || s
    }
  }
  try {
    s = decodeURIComponent(s)
  } catch {
    // 含非法百分号序列：保留原样
  }
  return s
}

/** 移除各语言括号段；若全部内容都在括号内则保留第一个括号段内容。 */
function stripBracketSegments(s: string): string {
  const stripped = s.replace(
    /\[[^\]]*\]|\([^)]*\)|（[^）]*）|【[^】]*】|｛[^｝]*｝/g,
    ' '
  )
  const trimmed = stripped.trim()
  if (trimmed) return trimmed
  // 全部在括号里（如「[名字].mkv」）：取第一个括号段内容
  const m = s.match(
    /\[([^\]]*)\]|\(([^)]*)\)|（([^）]*)）|【([^】]*)】/
  )
  const inner = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '') : ''
  return inner.trim()
}

/** 小数点保护占位符：数字.数字 中的点在分词前替换为该占位符，
 *  避免 `dts5.1` / `5.1` 被按点拆碎。 */
const DOT_PLACEHOLDER = '\u0001'

/** 丢弃噪声 token（按空格/点/下划线全拆分）。token 含 `-` 时分段比较——
 *  命中噪声的段说明整个 token 是「编码-发布组」类复合标记，一并丢弃。 */
function dropNoiseTokens(s: string): string {
  const protectedSource = s.replace(
    /(\d)\.(\d{1,2})(?!\d)/g,
    `$1${DOT_PLACEHOLDER}$2`
  )
  const tokens = protectedSource.split(/[\s._]+/).filter(Boolean)
  const kept: string[] = []
  for (const token of tokens) {
    const lower = token.toLowerCase().split(DOT_PLACEHOLDER).join('.')
    if (NOISE_TOKENS.has(lower)) continue
    if (token.includes('-')) {
      const segments = lower.split('-')
      if (segments.some((seg) => NOISE_TOKENS.has(seg))) continue
    }
    kept.push(token.split(DOT_PLACEHOLDER).join('.'))
  }
  return kept.join(' ')
}

/** 截断尾部集数/季标记。 */
function stripTrailingEpisode(s: string): string {
  let out = s
  for (const pattern of TRAILING_PATTERNS) {
    const next = out.replace(pattern, '')
    if (next !== out) {
      out = next.trim()
    }
  }
  return out
}

/**
 * 从文件名解析影视名。
 *
 * @param raw 文件名 / 路径 / URL
 * @returns 解析出的影视名；无法进一步提炼时返回去扩展名的文件名本体
 */
export function extractMediaTitle(raw: string): string {
  if (!raw) return ''
  const filename = toFileName(raw)
  // 去扩展名
  const base = filename.replace(/\.[a-z0-9]{1,5}$/i, '').trim()
  if (!base) return ''
  let title = stripBracketSegments(base)
  title = dropNoiseTokens(title)
  title = stripTrailingEpisode(title)
  // 清理首尾残留分隔符
  title = title.replace(/^[\s\-_.#]+|[\s\-_.#]+$/g, '').trim()
  if (title) return title
  // 噪声清洗后为空：回退括号剥离结果（可能含集数，仍比空好）
  const fallback = stripBracketSegments(base).trim()
  return fallback || base
}
