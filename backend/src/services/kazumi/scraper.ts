/**
 * Kazumi 独立模块 — HTML 抓取与 XPath 解析工具层
 *
 * 复用 anisubs/httpClient.ts 的 PowerShell fallback 绕过 TLS 指纹拦截。
 */

import { DOMParser } from '@xmldom/xmldom';
import * as xpath from 'xpath';
import { parseDocument } from 'htmlparser2';
import { render } from 'dom-serializer';
import { fetchText } from '../anisubs/httpClient';
import type { KazumiMediaFormat, KazumiRule } from './types';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function toAbsoluteUrl(url: string, baseUrl: string): string {
  if (!url) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

export function resolveBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

/** 获取 HTML 页面内容（经 PowerShell fallback 绕过 TLS 拦截） */
export async function fetchHtml(
  url: string,
  options: { userAgent?: string; referer?: string } = {},
): Promise<string> {
  const headers: Record<string, string> = {
    'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  };
  if (options.referer) {
    headers.Referer = options.referer;
  }
  const result = await fetchText(url, { headers });
  if (!result.ok) {
    throw new Error(
      `请求失败 [${result.status}]: ${url}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  return result.body;
}

/**
 * 用 htmlparser2 容错解析 HTML，再序列化为 XML 交给 xmldom。
 * htmlparser2 能自动修复标签不匹配等真实 HTML 问题，
 * 序列化后的 XML 可被 xmldom 无错解析，供 xpath 库查询。
 */
export function parseHtmlDocument(html: string): unknown {
  // 1. htmlparser2 容错解析（自动修复标签不匹配）
  const doc = parseDocument(html, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });
  // 2. 序列化为 XML 字符串（xmlMode 产生自闭合标签和合法 XML）
  const xhtml = render(doc, { xmlMode: true, encodeEntities: false });
  // 3. 包裹在 <root> 中确保单根，xmldom 解析为可被 xpath 查询的文档
  return new DOMParser().parseFromString(`<root>${xhtml}</root>`, 'text/xml');
}

export function selectXPath(
  doc: unknown,
  expression: string,
): xpath.SelectedValue[] {
  if (!expression) return [];
  try {
    return xpath.select(expression, doc as Node) as xpath.SelectedValue[];
  } catch (err) {
    console.error('[kazumi] xpath select error:', expression, err);
    return [];
  }
}

export function extractText(node: xpath.SelectedValue): string {
  if (!node) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (node && typeof (node as Node).textContent === 'string') {
    return ((node as Node).textContent || '').trim();
  }
  return '';
}

export function extractAttr(
  node: xpath.SelectedValue,
  attr: string,
): string | undefined {
  if (!node) return undefined;
  if (typeof node === 'object' && 'getAttribute' in (node as Node)) {
    return ((node as Element).getAttribute(attr) || undefined) as
      | string
      | undefined;
  }
  return undefined;
}

export function extractEpisodeNumber(name: string): number {
  const m = name.match(/第\s*(\d+(?:\.\d+)?)\s*[话集]|(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  const n = Number(m[1] || m[2]);
  return Number.isNaN(n) ? 0 : n;
}

export function detectMediaFormat(url: string): KazumiMediaFormat {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.flv')) return 'flv';
  if (lower.endsWith('.mp4')) return 'mp4';
  if (lower.includes('.m3u8')) return 'hls';
  if (lower.includes('.flv')) return 'flv';
  if (lower.includes('.mp4')) return 'mp4';
  return 'unknown';
}

/**
 * 解析剧集页面的真实视频地址。
 * 三级回退：直接正则匹配 → 播放器配置 url 字段 → iframe 嵌套递归。
 */
export async function resolveVideoUrl(
  episodeUrl: string,
  rule: KazumiRule,
): Promise<{ url: string; format?: KazumiMediaFormat } | null> {
  const html = await fetchHtml(episodeUrl, {
    userAgent: rule.userAgent,
    referer: rule.referer || rule.baseURL,
  });

  const absolute = (url: string) => toAbsoluteUrl(url, resolveBaseUrl(episodeUrl));

  // 1. 优先匹配常见视频地址
  const videoPatterns = [
    /(https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)/gi,
    /(https?:\/\/[^"'\s]+?\.mp4[^"'\s]*)/gi,
    /(https?:\/\/[^"'\s]+?\.flv[^"'\s]*)/gi,
    /["'](https?:\/\/[^"'\s]+?\/[^"'\s]*?(?:\.m3u8|\.mp4|\.flv)[^"'\s]*)["']/gi,
  ];
  for (const pattern of videoPatterns) {
    const matches = [...html.matchAll(pattern)];
    for (const match of matches) {
      const url = absolute(match[1] || match[0]);
      if (url && (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.flv'))) {
        return { url, format: detectMediaFormat(url) };
      }
    }
  }

  // 2. 匹配 DPlayer / 常见播放器配置中的 url 字段
  const configPatterns = [
    /["']url["']\s*[:=]\s*["'](https?:\/\/[^"']+)["']/gi,
    /video\s*:\s*\{[^}]*url\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
    /player\([^{]*\{[^}]*url\s*:\s*["'](https?:\/\/[^"']+)["']/gi,
  ];
  for (const pattern of configPatterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      const url = absolute(match[1]);
      return { url, format: detectMediaFormat(url) };
    }
  }

  // 3. 匹配 iframe src，部分站点通过 iframe 嵌套播放器
  const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (iframeMatch?.[1]) {
    const iframeUrl = absolute(iframeMatch[1]);
    try {
      const iframeHtml = await fetchHtml(iframeUrl, {
        userAgent: rule.userAgent,
        referer: episodeUrl,
      });
      for (const pattern of videoPatterns) {
        const matches = [...iframeHtml.matchAll(pattern)];
        for (const match of matches) {
          const url = absolute(match[1] || match[0]);
          if (url && (url.includes('.m3u8') || url.includes('.mp4') || url.includes('.flv'))) {
            return { url, format: detectMediaFormat(url) };
          }
        }
      }
    } catch {
      // ignore iframe fetch errors
    }
  }

  return null;
}
