/**
 * 本地弹幕文件导入：解析本地 XML / JSON 弹幕文件为统一 DanmakuItem 格式。
 *
 * 支持格式（按内容特征自动识别，不依赖文件扩展名）：
 * - B站 XML（`<d p="time,mode,size,color,...">内容</d>`，与
 *   services/bilibili/danmaku.ts 的解析映射一致）
 * - dandanplay JSON（`{ comments: [{ cid, p: "time,mode,color", m }] }`）
 * - B站 protobuf 转 JSON（`{ elements: [{ id, str, time, mode, size, color }] }`）
 * - 通用对象数组（宽松提取 time/content/mode/color/size 字段）
 *
 * mode 语义与 B站 一致（引擎 mapBiliModeToDanmakuJs 消费）：
 * 1-3/6 滚动、4 底部、5 顶部、7/8 高级。8/9（代码/BAS）Web 渲染层
 * 不支持，导入时直接丢弃。
 */
import type { DanmakuItem } from './types'

/** 单文件条目上限：超出截断，防超大文件撑爆 store 与弹幕渲染层 */
export const MAX_LOCAL_DANMAKU_ITEMS = 20000

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCodePoint(parseInt(h, 16))
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseInt(String(value), 10)
  return Number.isFinite(n) ? n : fallback
}

function clampColor(value: unknown): number {
  const n = toInt(value, 0xffffff)
  return Math.max(0, Math.min(0xffffff, n))
}

interface RawItem {
  id?: unknown
  content?: unknown
  time?: unknown
  mode?: unknown
  color?: unknown
  size?: unknown
}

function toDanmakuItem(raw: RawItem, index: number): DanmakuItem | null {
  const time = Number(raw.time)
  if (!Number.isFinite(time) || time < 0) return null
  const content = String(raw.content ?? '').trim()
  if (!content) return null
  const mode = toInt(raw.mode, 1)
  // 8=代码弹幕 9=BAS 弹幕：Web 渲染层不支持，丢弃
  if (mode === 8 || mode === 9) return null
  return {
    id: String(raw.id ?? `local-${index}-${time}`),
    content,
    time,
    mode: Math.max(1, Math.min(7, mode)),
    color: clampColor(raw.color),
    size: Math.max(1, toInt(raw.size, 25)),
  }
}

/** 解析 B站 XML 弹幕（`<d p="...">内容</d>`） */
function parseBiliXml(text: string): DanmakuItem[] {
  const items: DanmakuItem[] = []
  const regex = /<d\b[^>]*?\bp="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const parts = match[1].split(',')
    if (parts.length < 4) continue
    const item = toDanmakuItem(
      {
        id: parts[7] || undefined,
        content: decodeXmlEntities(match[2]),
        time: parseFloat(parts[0]),
        mode: parseInt(parts[1], 10),
        // B站 p 属性顺序：time, mode, size, color
        size: parseInt(parts[2], 10),
        color: parseInt(parts[3], 10),
      },
      items.length
    )
    if (item) items.push(item)
  }
  return items
}

/** 解析 dandanplay JSON（`{ comments: [{ cid, p, m }] }`） */
function parseDandanplayJson(data: unknown): DanmakuItem[] {
  const comments = (data as { comments?: unknown }).comments
  if (!Array.isArray(comments)) return []
  const items: DanmakuItem[] = []
  for (const c of comments) {
    const p = String((c as { p?: unknown }).p ?? '')
    const parts = p.split(',')
    if (parts.length < 2) continue
    const item = toDanmakuItem(
      {
        id: (c as { cid?: unknown }).cid,
        content: (c as { m?: unknown }).m,
        time: parseFloat(parts[0]),
        mode: parseInt(parts[1], 10),
        color: parts[2] !== undefined ? parseInt(parts[2], 10) : 0xffffff,
        // dandanplay 无字号字段，取默认 25
        size: 25,
      },
      items.length
    )
    if (item) items.push(item)
  }
  return items
}

/** 解析 B站 protobuf 转 JSON / 通用对象数组（宽松字段提取） */
function parseGenericJsonItems(list: unknown[]): DanmakuItem[] {
  const items: DanmakuItem[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as Record<string, unknown>
    const item = toDanmakuItem(
      {
        id: o.id ?? o.dmid ?? o.cid,
        content: o.str ?? o.m ?? o.content ?? o.text,
        time: o.time ?? o.stime ?? o.progress,
        mode: o.mode,
        color: o.color,
        size: o.size,
      },
      items.length
    )
    if (item) items.push(item)
  }
  return items
}

export interface LocalDanmakuParseResult {
  items: DanmakuItem[]
  /** 因超出上限被截断的条目数（0 表示未截断） */
  truncated: number
}

/**
 * 解析本地弹幕文件内容。
 *
 * @param text 文件文本内容
 * @param fileName 文件名（仅用于错误提示）
 * @throws 无有效条目 / JSON 解析失败时抛出带用户可读信息的 Error
 */
export function parseLocalDanmaku(
  text: string,
  fileName = '弹幕文件'
): LocalDanmakuParseResult {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error(`「${fileName}」内容为空`)
  }

  let items: DanmakuItem[] = []
  if (trimmed.startsWith('<')) {
    // XML（B站 list.so 格式）
    items = parseBiliXml(trimmed)
  } else {
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch {
      throw new Error(
        `「${fileName}」不是有效的弹幕文件（XML/JSON 解析均失败）`
      )
    }
    if (Array.isArray(data)) {
      items = parseGenericJsonItems(data)
    } else if (
      typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as { comments?: unknown }).comments)
    ) {
      items = parseDandanplayJson(data)
    } else if (
      typeof data === 'object' &&
      data !== null &&
      Array.isArray((data as { elements?: unknown }).elements)
    ) {
      items = parseGenericJsonItems((data as { elements: unknown[] }).elements)
    } else if (typeof data === 'object' && data !== null) {
      items = parseGenericJsonItems([data])
    }
  }

  if (items.length === 0) {
    throw new Error(
      `「${fileName}」中未解析到有效弹幕（支持 B站 XML/JSON 与 dandanplay JSON 格式）`
    )
  }

  items.sort((a, b) => a.time - b.time)
  const truncated = Math.max(0, items.length - MAX_LOCAL_DANMAKU_ITEMS)
  if (truncated > 0) {
    items = items.slice(0, MAX_LOCAL_DANMAKU_ITEMS)
  }
  return { items, truncated }
}
