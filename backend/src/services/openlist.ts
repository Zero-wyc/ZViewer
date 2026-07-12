export interface OpenListEntry {
  name: string;
  url: string;
  type?: string;
  size?: number;
}

export interface OpenListIndex {
  title?: string;
  items: OpenListEntry[];
}

interface RawOpenListItem {
  name?: string;
  title?: string;
  url?: string;
  link?: string;
  src?: string;
  playUrl?: string;
  type?: string;
  ext?: string;
  size?: number | string;
}

function isMediaUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.endsWith('.mp4') ||
    lower.endsWith('.mkv') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.mov') ||
    lower.endsWith('.avi') ||
    lower.endsWith('.m3u8') ||
    lower.endsWith('.mp3') ||
    lower.includes('/video') ||
    lower.includes('/media')
  );
}

function normalizeUrl(baseUrl: string, url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

function extractItems(data: unknown, baseUrl: string): OpenListEntry[] {
  let rawItems: RawOpenListItem[] = [];

  if (Array.isArray(data)) {
    rawItems = data as RawOpenListItem[];
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.list)) rawItems = obj.list as RawOpenListItem[];
    else if (Array.isArray(obj.items)) rawItems = obj.items as RawOpenListItem[];
    else if (Array.isArray(obj.data)) rawItems = obj.data as RawOpenListItem[];
    else if (Array.isArray(obj.files)) rawItems = obj.files as RawOpenListItem[];
    else if (Array.isArray(obj.videos)) rawItems = obj.videos as RawOpenListItem[];
  }

  const entries: OpenListEntry[] = [];
  for (const item of rawItems) {
    const name = (item.name || item.title || '未命名').trim();
    const rawUrl = item.url || item.link || item.src || item.playUrl || '';
    if (!rawUrl) continue;
    const url = normalizeUrl(baseUrl, rawUrl);
    if (url) {
      entries.push({
        name,
        url,
        type: item.type || item.ext,
        size: typeof item.size === 'number' ? item.size : Number(item.size) || undefined,
      });
    }
  }

  return entries;
}

const DEFAULT_TIMEOUT = 10000; // 10 秒

export async function fetchOpenListIndex(indexUrl: string): Promise<OpenListIndex> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  try {
    const response = await fetch(indexUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`获取 OpenList 索引失败: ${response.status}`);
    }

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // 尝试从文本中提取 URL（每行一个）
      const lines = text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (lines.some((line) => isMediaUrl(line))) {
        data = lines.map((line) => ({ name: line.split('/').pop() || '未命名', url: line }));
      } else {
        throw new Error('OpenList 索引格式错误');
      }
    }

    const items = extractItems(data, indexUrl);
    if (items.length === 0) {
      throw new Error('未从 OpenList 索引中解析到媒体条目');
    }

    let title: string | undefined;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const obj = data as Record<string, unknown>;
      title = typeof obj.title === 'string' ? obj.title : undefined;
    }

    return { title, items };
  } finally {
    clearTimeout(timer);
  }
}
