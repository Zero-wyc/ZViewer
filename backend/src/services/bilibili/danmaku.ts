export interface BilibiliDanmakuItem {
  id: string;
  content: string;
  time: number;
  mode: number;
  color: number;
  size: number;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * 获取并解析 B站 弹幕 XML。
 * @param cid 视频分 P 的 cid。
 */
export async function getDanmaku(cid: number): Promise<BilibiliDanmakuItem[]> {
  const response = await fetch(
    `https://api.bilibili.com/x/v1/dm/list.so?oid=${encodeURIComponent(String(cid))}`,
    {
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Referer: 'https://www.bilibili.com',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`获取 B站 弹幕失败 [${response.status}]`);
  }

  const xml = await response.text();
  const danmaku: BilibiliDanmakuItem[] = [];
  const regex = /<d p="([^"]+)">([^<]*)<\/d>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(xml)) !== null) {
    const parts = match[1].split(',');
    if (parts.length < 4) continue;

    const time = parseFloat(parts[0]);
    const mode = parseInt(parts[1], 10);
    const size = parseInt(parts[2], 10);
    const color = parseInt(parts[3], 10);
    const id = parts[7] ?? `${Date.now()}-${danmaku.length}`;
    const content = decodeXmlEntities(match[2]);

    danmaku.push({ id, content, time, mode, color, size });
  }

  return danmaku;
}
