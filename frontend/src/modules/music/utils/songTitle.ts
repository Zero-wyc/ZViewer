/**
 * 歌曲名提取（纯函数，无运行时依赖，供 NcmSearchModal 与单测共用）。
 */

/**
 * 从 B站 视频标题提取歌曲名（启发式）：
 * 剥离【】[]（）() 括号标签（4K/MV/官方等引流噪声多在其中，书名号《》
 * 内常是歌名故保留）、清洗常见画质/版本噪声词、按 -｜/ 分隔取主段。
 * 提取结果仅作初始关键词，输入框可手动修正。
 */
export function extractSongTitle(rawTitle: string): string {
  let t = rawTitle
  t = t.replace(/【[^】]*】/g, ' ')
  t = t.replace(/\[[^\]]*\]/g, ' ')
  t = t.replace(/《([^》]*)》/g, ' $1 ')
  t = t.replace(/（[^）]*）/g, ' ')
  t = t.replace(/\([^)]*\)/g, ' ')
  // 英文/数字噪声词用 \b 定界（避免误伤含相同字母的英文单词）；
  // 中文噪声词不能套 \b——中文字符非 \w，与相邻非 \w 字符之间词边界
  // 永不成立，空格包围时会静默失效，故直接字面匹配
  t = t.replace(
    /\b(4K|8K|1080P|720P|480P|60FPS|120FPS|Hi-?Res|MV|PV|Live)\b/gi,
    ' '
  )
  t = t.replace(/无损|高清|蓝光|官方|纯享|完整版|正片/g, ' ')
  t = (t.split(/[|｜/／]/)[0] ?? t).split(/\s*[-–—]\s*/)[0] ?? t
  return t.replace(/\s+/g, ' ').trim()
}
