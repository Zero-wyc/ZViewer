import {
  DanmakuSourceProvider,
  DanmakuSearchResult,
  DanmakuEpisode,
  DanmakuItem,
} from '../types';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface BahamutSearchResult {
  sn: string;
  title: string;
  animeSN?: string;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      Referer: 'https://ani.gamer.com.tw',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`巴哈姆特请求失败 [${res.status}]: ${url}`);
  }

  return res.text();
}

async function searchBahamutByKeyword(keyword: string): Promise<BahamutSearchResult[]> {
  const html = await fetchHtml(
    `https://ani.gamer.com.tw/search.php?keyword=${encodeURIComponent(keyword)}`,
  );

  const results: BahamutSearchResult[] = [];
  const seen = new Set<string>();

  // 匹配番剧详情页链接 /animeVideo.php?sn=xxxxx 与 /animeVideo.php?sn=xxxxx&name=...
  const linkRegex = /href="\/animeVideo\.php\?sn=(\d+)[^"]*"/g;
  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) !== null) {
    const sn = match[1];
    if (seen.has(sn)) continue;
    seen.add(sn);

    // 尝试从附近提取标题
    const nearby = html.slice(Math.max(0, match.index - 400), match.index);
    const titleMatch = nearby.match(/title="([^"]+)"/);
    const title = titleMatch
      ? decodeHtmlEntities(titleMatch[1])
      : `番剧 SN${sn}`;

    results.push({ sn, title });
  }

  // 如果没有匹配到 video 链接，尝试 animeRef.php 详情页
  if (results.length === 0) {
    const refRegex = /href="\/animeRef\.php\?sn=(\d+)[^"]*"/g;
    while ((match = refRegex.exec(html)) !== null) {
      const sn = match[1];
      if (seen.has(sn)) continue;
      seen.add(sn);
      const nearby = html.slice(Math.max(0, match.index - 400), match.index);
      const titleMatch = nearby.match(/title="([^"]+)"/);
      const title = titleMatch
        ? decodeHtmlEntities(titleMatch[1])
        : `番剧 SN${sn}`;
      results.push({ sn, title, animeSN: sn });
    }
  }

  return results.slice(0, 20);
}

async function getBahamutEpisodesBySn(sn: string): Promise<BahamutSearchResult[]> {
  const html = await fetchHtml(`https://ani.gamer.com.tw/animeVideo.php?sn=${sn}`);

  // 尝试从 season 选择器或集数列表提取
  const episodes: BahamutSearchResult[] = [];
  const seen = new Set<string>();

  // 提取 data-src 或当前页面的 season 链接
  const seasonRegex = /data-src="\/animeVideo\.php\?sn=(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = seasonRegex.exec(html)) !== null) {
    const epSn = match[1];
    if (seen.has(epSn)) continue;
    seen.add(epSn);
    episodes.push({ sn: epSn, title: `第 ${episodes.length + 1} 集` });
  }

  // 如果没有 season 选择器，当前页面本身就是一集
  if (episodes.length === 0) {
    episodes.push({ sn, title: '第 1 集' });
  }

  return episodes;
}

async function getBahamutDanmaku(sn: string): Promise<DanmakuItem[]> {
  const res = await fetch('https://ani.gamer.com.tw/ajax/danmuGet.php', {
    method: 'POST',
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Referer: `https://ani.gamer.com.tw/animeVideo.php?sn=${sn}`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ sn }).toString(),
  });

  if (!res.ok) {
    throw new Error(`获取巴哈姆特弹幕失败 [${res.status}]`);
  }

  const json = (await res.json()) as {
    error?: string;
    msg?: string;
    data?: Array<{
      text?: string;
      time?: number;
      color?: string;
      position?: number;
      sn?: number | string;
      size?: number;
    }>;
  };

  if (json.error) {
    throw new Error(json.msg || '巴哈姆特弹幕接口返回错误');
  }

  const list = Array.isArray(json.data) ? json.data : [];
  return list
    .filter((d) => typeof d.text === 'string' && d.text.trim())
    .map((d) => {
      const colorHex = d.color?.replace('#', '') || 'ffffff';
      const color = parseInt(colorHex, 16) || 0xffffff;
      // position: 0=滚动, 1=顶部, 2=底部, 3=特殊
      const mode = typeof d.position === 'number' ? d.position : 0;
      const time = typeof d.time === 'number' ? d.time : 0;
      return {
        id: String(d.sn ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        content: d.text as string,
        time,
        mode,
        color,
        size: d.size,
      };
    });
}

export const bahamutDanmakuProvider: DanmakuSourceProvider = {
  name: '巴哈姆特动画疯',

  async search(keyword: string): Promise<DanmakuSearchResult[]> {
    const results = await searchBahamutByKeyword(keyword);
    return results.map((r) => ({
      id: r.sn,
      title: r.title,
      source: 'bahamut',
      extra: { sn: r.sn, animeSN: r.animeSN },
    }));
  },

  async getEpisodes(identifier: string): Promise<DanmakuEpisode[]> {
    const sn = identifier.replace(/\D/g, '');
    if (!sn) {
      throw new Error('无法解析巴哈姆特 SN');
    }

    const episodes = await getBahamutEpisodesBySn(sn);
    return episodes.map((ep, idx) => ({
      id: ep.sn,
      title: ep.title,
      episodeNumber: idx + 1,
      playbackParams: { sn: ep.sn },
    }));
  },

  async getDanmaku(episode: DanmakuEpisode): Promise<DanmakuItem[]> {
    const sn = episode.playbackParams.sn;
    if (typeof sn !== 'string' || !sn) {
      throw new Error('缺少巴哈姆特 sn 参数');
    }
    return getBahamutDanmaku(sn);
  },
};
