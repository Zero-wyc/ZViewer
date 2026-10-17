/**
 * Kazumi 独立模块 — API 规则引擎
 *
 * 对齐上游 Predidit/Kazumi apiLevel 9 的 API 规则运行时
 * （lib/services/plugin/api_rule_strategy.dart + api_rule_config.dart）：
 *   - 受限 JSONPath（$.a.b[*]['key']，禁过滤表达式/递归下降）
 *   - @var 模板渲染（搜索 @keyword；详情页 @source；章节 @source +
 *     variables 捕获 + episodePage 的 @episodeUrl/@roadIndex/...）
 *   - nested（JSONPath 结构化）/ delimited（苹果 CMS $$$/#/$ 分隔）两种章节格式
 *   - GET/POST 请求（复用 fetchText，保留 PowerShell TLS 回退与 GBK 解码）
 *
 * 两种模式的最终产物都是播放页 URL，媒体地址解析仍由 scraper.resolveVideoUrl 完成。
 */

import { fetchText } from '../anisubs/httpClient';
import type {
  KazumiApiChapterConfig,
  KazumiApiEpisodePageConfig,
  KazumiApiRequestConfig,
  KazumiApiSearchConfig,
  KazumiRule,
} from './types';
import { normalizeEpisodeUrl } from './scraper';

// ── 模式归一化 ─────────────────────────────────────

export function normalizeRuleMode(value: unknown): 'xpath' | 'api' {
  return value === 'api' ? 'api' : 'xpath';
}

/** 规则是否使用 API 搜索（需 searchMode=api 且配置了请求地址） */
export function usesApiSearch(rule: KazumiRule): boolean {
  return (
    normalizeRuleMode(rule.searchMode) === 'api' &&
    typeof rule.searchApiConfig?.request?.url === 'string' &&
    rule.searchApiConfig.request.url.trim() !== ''
  );
}

/** 规则是否使用 API 选集 */
export function usesApiChapters(rule: KazumiRule): boolean {
  return (
    normalizeRuleMode(rule.chapterMode) === 'api' &&
    typeof rule.chapterApiConfig?.request?.url === 'string' &&
    rule.chapterApiConfig.request.url.trim() !== ''
  );
}

// ── 受限 JSONPath ──────────────────────────────────

type PathToken =
  | { type: 'prop'; name: string }
  | { type: 'key'; key: string }
  | { type: 'index'; index: number }
  | { type: 'wildcard' };

export class ApiRuleFormatException extends Error {}

/** 解析受限 JSONPath 为 token 序列（语法白名单对齐上游 RestrictedJsonPath） */
function parseJsonPath(expression: string): PathToken[] {
  if (!expression.startsWith('$')) {
    throw new ApiRuleFormatException(`JSONPath 必须以 $ 开头: ${expression}`);
  }
  const tokens: PathToken[] = [];
  let i = 1;
  while (i < expression.length) {
    const char = expression[i];
    if (char === '.') {
      i++;
      const start = i;
      while (i < expression.length && /[A-Za-z0-9_$-]/.test(expression[i])) {
        i++;
      }
      if (i === start) {
        throw new ApiRuleFormatException(`不支持的 JSONPath: ${expression}`);
      }
      tokens.push({ type: 'prop', name: expression.slice(start, i) });
      continue;
    }
    if (char === '[') {
      const end = findBracketEnd(expression, i);
      const content = expression.slice(i + 1, end).trim();
      if (/^\d+$/.test(content)) {
        tokens.push({ type: 'index', index: parseInt(content, 10) });
      } else if (content === '*') {
        tokens.push({ type: 'wildcard' });
      } else if (
        content.length >= 2 &&
        ((content.startsWith("'") && content.endsWith("'")) ||
          (content.startsWith('"') && content.endsWith('"')))
      ) {
        tokens.push({ type: 'key', key: content.slice(1, -1) });
      } else {
        throw new ApiRuleFormatException(
          `不支持的 JSONPath 片段: [${content}]`,
        );
      }
      i = end + 1;
      continue;
    }
    throw new ApiRuleFormatException(`不支持的 JSONPath: ${expression}`);
  }
  return tokens;
}

function findBracketEnd(expression: string, start: number): number {
  let quote: string | null = null;
  let escaped = false;
  for (let i = start + 1; i < expression.length; i++) {
    const char = expression[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote != null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ']') return i;
  }
  throw new ApiRuleFormatException(`JSONPath 缺少 ]: ${expression}`);
}

function readTokens(value: unknown, tokens: PathToken[], out: unknown[]): void {
  if (tokens.length === 0) {
    out.push(value);
    return;
  }
  const [head, ...rest] = tokens;
  if (head.type === 'wildcard') {
    if (Array.isArray(value)) {
      for (const item of value) readTokens(item, rest, out);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value as Record<string, unknown>)) {
        readTokens(item, rest, out);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    // 标准语义：prop/index/key 作用于数组时按元素展开
    for (const item of value) readTokens(item, tokens, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (head.type === 'prop') {
    const v = obj[head.name];
    if (v !== undefined) readTokens(v, rest, out);
  } else if (head.type === 'key') {
    const v = obj[head.key];
    if (v !== undefined) readTokens(v, rest, out);
  } else {
    // index 对对象无意义，跳过
  }
}

/** 受限 JSONPath 读取，返回全部匹配值 */
export function jsonPathRead(document: unknown, expression: string): unknown[] {
  const tokens = parseJsonPath(expression);
  const out: unknown[] = [];
  readTokens(document, tokens, out);
  return out;
}

function jsonPathReadFirst(document: unknown, expression: string): unknown {
  const values = jsonPathRead(document, expression);
  return values.length > 0 ? values[0] : undefined;
}

// ── 模板渲染 ───────────────────────────────────────

const TEMPLATE_VAR_RE = /(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9_]*)/g;
const EXACT_VAR_RE = /^@([A-Za-z_][A-Za-z0-9_]*)$/;

function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
  encode = false,
): string {
  return template.replace(TEMPLATE_VAR_RE, (_match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(variables, name)) {
      throw new ApiRuleFormatException(`缺少模板变量 @${name}`);
    }
    const value = variables[name];
    const str = value == null ? '' : String(value);
    return encode ? encodeURIComponent(str) : str;
  });
}

/** 值渲染：整串恰为 @var 时原样返回（不编码），对象/数组递归 */
function renderValue(
  value: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const exact = EXACT_VAR_RE.exec(value);
    if (exact) {
      const name = exact[1];
      if (!Object.prototype.hasOwnProperty.call(variables, name)) {
        throw new ApiRuleFormatException(`缺少模板变量 @${name}`);
      }
      return variables[name];
    }
    return renderTemplate(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, variables));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[renderTemplate(key, variables)] = renderValue(item, variables);
    }
    return out;
  }
  return value;
}

function renderMap(
  input: Record<string, unknown> | undefined,
  variables: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [key, value] of Object.entries(input)) {
    out[renderTemplate(key, variables)] = String(renderValue(value, variables));
  }
  return out;
}

// ── 请求执行 ───────────────────────────────────────

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 20000;

interface PreparedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  contentType?: string;
}

function prepareRequest(
  config: KazumiApiRequestConfig,
  variables: Record<string, unknown>,
  defaults: { userAgent?: string; referer?: string },
): PreparedRequest {
  const method = String(config.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    throw new ApiRuleFormatException(`仅支持 GET/POST，当前为 ${method}`);
  }
  const rawUrl = String(config.url ?? '').trim();
  if (!rawUrl) {
    throw new ApiRuleFormatException('API 请求 URL 不能为空');
  }
  const renderedUrl = renderTemplate(rawUrl, variables, true);
  let url: URL;
  try {
    url = new URL(renderedUrl);
  } catch {
    throw new ApiRuleFormatException(`API 请求 URL 无效: ${renderedUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiRuleFormatException(`API 请求 URL 无效: ${renderedUrl}`);
  }

  const headers: Record<string, string> = {
    'User-Agent': defaults.userAgent || DEFAULT_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
  };
  if (defaults.referer) headers.Referer = defaults.referer;

  for (const [key, value] of Object.entries(
    renderMap(config.headers, variables),
  )) {
    headers[key] = value;
  }
  for (const [key, value] of Object.entries(renderMap(config.query, variables))) {
    url.searchParams.set(key, value);
  }

  let body: string | undefined;
  let contentType: string | undefined;
  const bodyType = String(config.bodyType ?? 'none');
  if (method === 'POST' && bodyType !== 'none') {
    const rendered = renderValue(config.body, variables);
    if (bodyType === 'json') {
      body = JSON.stringify(rendered);
      contentType = 'application/json';
    } else {
      const params = new URLSearchParams();
      if (rendered && typeof rendered === 'object') {
        for (const [key, value] of Object.entries(
          rendered as Record<string, unknown>,
        )) {
          params.set(key, value == null ? '' : String(value));
        }
      }
      body = params.toString();
      contentType = 'application/x-www-form-urlencoded';
    }
  }

  return { method, url: url.toString(), headers, body, contentType };
}

async function executeRequest(prepared: PreparedRequest): Promise<unknown> {
  const result = await fetchText(prepared.url, {
    headers: prepared.headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
    method: prepared.method,
    body: prepared.body,
    contentType: prepared.contentType,
  });
  if (!result.ok) {
    throw new ApiRuleFormatException(
      `API 请求失败 [${result.status}]: ${prepared.url}${result.error ? ` (${result.error})` : ''}`,
    );
  }
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new ApiRuleFormatException('API 响应不是有效 JSON');
  }
}

function stringValue(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value.trim() : String(value);
}

// ── 搜索 ───────────────────────────────────────────

export interface ApiSearchItem {
  name: string;
  /** 详情页地址（sourceTemplate 渲染后；可能为裸 id，由调用方归一化） */
  src: string;
}

/** 执行 API 搜索，返回条目列表 */
export async function apiSearch(
  rule: KazumiRule,
  keyword: string,
): Promise<ApiSearchItem[]> {
  const config = (rule.searchApiConfig ?? {}) as KazumiApiSearchConfig;
  const prepared = prepareRequest(
    (config.request ?? {}) as KazumiApiRequestConfig,
    { keyword },
    { userAgent: rule.userAgent || undefined, referer: rule.referer || rule.baseURL },
  );
  const document = await executeRequest(prepared);

  const listPath = stringValue(config.listPath) || '$.data[*]';
  const namePath = stringValue(config.namePath) || '$.name';
  const sourcePath = stringValue(config.sourcePath) || '$.url';
  const template = stringValue(config.sourceTemplate);

  const nodes = jsonPathRead(document, listPath);
  const results: ApiSearchItem[] = [];
  for (const node of nodes) {
    const name = stringValue(jsonPathReadFirst(node, namePath));
    const source = stringValue(jsonPathReadFirst(node, sourcePath));
    if (!name || !source) continue;
    // 对齐上游：模板为普通替换（@source 可紧跟字母），来源值 URL 编码
    const src = template
      ? template.split('@source').join(encodeURIComponent(source))
      : source;
    results.push({ name, src });
  }
  return results;
}

// ── 选集 ───────────────────────────────────────────

export interface ApiChapterRoad {
  name: string;
  /** 每集播放页 URL（已归一化） */
  urls: string[];
  /** 每集标题（与 urls 对齐） */
  titles: string[];
}

/** 执行 API 选集，返回线路列表 */
export async function apiChapters(
  rule: KazumiRule,
  source: string,
): Promise<ApiChapterRoad[]> {
  const config = (rule.chapterApiConfig ?? {}) as KazumiApiChapterConfig;
  const rootVariables: Record<string, unknown> = { source };

  const prepared = prepareRequest(
    (config.request ?? {}) as KazumiApiRequestConfig,
    rootVariables,
    { userAgent: rule.userAgent || undefined, referer: rule.referer || rule.baseURL },
  );
  const document = await executeRequest(prepared);

  for (const [name, path] of Object.entries(config.variables ?? {})) {
    const value = jsonPathReadFirst(document, String(path));
    if (value === undefined) {
      throw new ApiRuleFormatException(
        `章节响应变量 ${name} 未匹配到值: ${path}`,
      );
    }
    rootVariables[name] = value;
  }

  const format = stringValue(config.format) || 'nested';
  const roads =
    format === 'delimited'
      ? parseDelimited(document, config, rootVariables, rule.baseURL)
      : parseNested(document, config, rootVariables, rule.baseURL);
  return roads;
}

function resolveEpisodeUrl(
  config: KazumiApiChapterConfig,
  rootVariables: Record<string, unknown>,
  rawUrl: string,
  roadIndex: number,
  episodeIndex: number,
  baseUrl: string,
): string {
  const page = config.episodePage as KazumiApiEpisodePageConfig | undefined;
  if (!page) return normalizeEpisodeUrl(baseUrl, rawUrl);
  const pageUrl = stringValue(page.url);
  if (!pageUrl) {
    throw new ApiRuleFormatException('播放页地址模板不能为空');
  }
  // 上游语义：0/1 基索引都提供；@episodeUrl 携带 episodeUrlPath 提取的原值
  const variables: Record<string, unknown> = {
    ...rootVariables,
    episodeUrl: rawUrl,
    roadIndex,
    roadNumber: roadIndex + 1,
    episodeIndex,
    episodeNumber: episodeIndex + 1,
  };
  const path = renderTemplate(pageUrl, variables, true);
  let uri: URL;
  try {
    uri = new URL(path);
  } catch {
    throw new ApiRuleFormatException(`剧集页面 URL 无效: ${path}`);
  }
  const query = page.query;
  if (query && typeof query === 'object') {
    for (const [key, value] of Object.entries(renderMap(query, variables))) {
      uri.searchParams.set(key, value);
    }
  }
  return normalizeEpisodeUrl(baseUrl, uri.toString());
}

function parseNested(
  document: unknown,
  config: KazumiApiChapterConfig,
  rootVariables: Record<string, unknown>,
  baseUrl: string,
): ApiChapterRoad[] {
  const roadsPath = stringValue(config.roadsPath);
  const roadNamePath = stringValue(config.roadNamePath);
  const episodesPath = stringValue(config.episodesPath) || '$.episodes[*]';
  const episodeNamePath = stringValue(config.episodeNamePath) || '$.name';
  const episodeUrlPath = stringValue(config.episodeUrlPath);

  const roadNodes = roadsPath ? jsonPathRead(document, roadsPath) : [document];
  const roads: ApiChapterRoad[] = [];

  for (let roadIndex = 0; roadIndex < roadNodes.length; roadIndex++) {
    const roadNode = roadNodes[roadIndex];
    const roadName = roadNamePath
      ? stringValue(jsonPathReadFirst(roadNode, roadNamePath))
      : '';
    const episodeNodes = jsonPathRead(roadNode, episodesPath);
    const urls: string[] = [];
    const titles: string[] = [];
    for (let episodeIndex = 0; episodeIndex < episodeNodes.length; episodeIndex++) {
      const episodeNode = episodeNodes[episodeIndex];
      const episodeName = stringValue(
        jsonPathReadFirst(episodeNode, episodeNamePath),
      );
      const rawUrl = episodeUrlPath
        ? stringValue(jsonPathReadFirst(episodeNode, episodeUrlPath))
        : '';
      const pageUrl = resolveEpisodeUrl(
        config,
        rootVariables,
        rawUrl,
        roadIndex,
        episodeIndex,
        baseUrl,
      );
      if (!pageUrl) continue;
      urls.push(pageUrl);
      titles.push(episodeName || `第${episodeIndex + 1}集`);
    }
    if (urls.length === 0) continue;
    roads.push({
      name: roadName || `播放线路${roads.length + 1}`,
      urls,
      titles,
    });
  }
  return roads;
}

function parseDelimited(
  document: unknown,
  config: KazumiApiChapterConfig,
  rootVariables: Record<string, unknown>,
  baseUrl: string,
): ApiChapterRoad[] {
  const roadNamesPath = stringValue(config.roadNamesPath);
  const roadEpisodesPath = stringValue(config.roadEpisodesPath);
  const roadSeparator = stringValue(config.roadSeparator) || '$$$';
  const episodeSeparator = stringValue(config.episodeSeparator) || '#';
  const fieldSeparator = stringValue(config.fieldSeparator) || '$';

  const namesValue = roadNamesPath
    ? stringValue(jsonPathReadFirst(document, roadNamesPath))
    : '';
  const episodesValue = roadEpisodesPath
    ? stringValue(jsonPathReadFirst(document, roadEpisodesPath))
    : '';
  if (!episodesValue) return [];

  const roadNames = namesValue.split(roadSeparator);
  const roadGroups = episodesValue.split(roadSeparator);
  const roads: ApiChapterRoad[] = [];

  for (let roadIndex = 0; roadIndex < roadGroups.length; roadIndex++) {
    const urls: string[] = [];
    const titles: string[] = [];
    const entries = roadGroups[roadIndex].split(episodeSeparator);
    for (let episodeIndex = 0; episodeIndex < entries.length; episodeIndex++) {
      const entry = entries[episodeIndex].trim();
      if (!entry) continue;
      const separatorIndex = entry.indexOf(fieldSeparator);
      if (separatorIndex < 0) continue;
      const name = entry.slice(0, separatorIndex).trim();
      const rawUrl = entry
        .slice(separatorIndex + fieldSeparator.length)
        .trim();
      const pageUrl = resolveEpisodeUrl(
        config,
        rootVariables,
        rawUrl,
        roadIndex,
        episodeIndex,
        baseUrl,
      );
      if (!pageUrl) continue;
      urls.push(pageUrl);
      titles.push(name || `第${episodeIndex + 1}集`);
    }
    if (urls.length === 0) continue;
    const configuredName =
      roadIndex < roadNames.length ? roadNames[roadIndex].trim() : '';
    roads.push({
      name: configuredName || `播放线路${roads.length + 1}`,
      urls,
      titles,
    });
  }
  return roads;
}
