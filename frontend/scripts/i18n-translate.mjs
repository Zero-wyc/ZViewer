#!/usr/bin/env node
/**
 * en-US 译文的分块流程：导出待翻清单 → 逐块填译文 → 合成 `locales/en-US.ts`。
 *
 * 为什么分块：词条两千多条，一次性给出译文既难核对也容易漏。
 * 这里把 `zh-CN.ts` 按分组切成若干块，每块单独一个「中文数组 + 英文数组」，
 * 合成时按顺序一一对应——翻译过程不需要重复抄写中文 key，少一类手误。
 *
 * 用法：
 *   node scripts/i18n-translate.mjs --plan            # 生成待翻清单与分块
 *   node scripts/i18n-translate.mjs --plan --force    # 重新切块（会覆盖清单）
 *   node scripts/i18n-translate.mjs --status          # 看覆盖率
 *   node scripts/i18n-translate.mjs --build           # 合成 en-US.ts
 *
 * 目录约定：
 *   scripts/i18n-en/plan.json          分块索引（每块的分组、条数）
 *   scripts/i18n-en/parts/<id>.zh.json 中文原文（生成物，不要手改）
 *   scripts/i18n-en/parts/<id>.en.json 英文译文（{ "items": [...] }，与 zh 等长）
 *
 * 译文可以只做一部分：`--build` 会跳过缺失或长度不符的块，
 * 对应的词条在运行时回退成中文原文，界面不会出现占位符。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '..')
const ZH_PATH = path.join(FRONTEND, 'src/i18n/locales/zh-CN.ts')
const EN_PATH = path.join(FRONTEND, 'src/i18n/locales/en-US.ts')
const OUT_DIR = path.join(HERE, 'i18n-en')
const PARTS_DIR = path.join(OUT_DIR, 'parts')
const PLAN_PATH = path.join(OUT_DIR, 'plan.json')
const OVERRIDES_PATH = path.join(OUT_DIR, 'overrides.json')

const DEFAULT_CHUNK = 120

/** 词典里一行一条：`  '中文': '中文',` */
const ENTRY_RE = /^ {2}'((?:[^\\']|\\.)*)': '((?:[^\\']|\\.)*)',$/
const GROUP_RE = /^ {2}\/\/ ===== (.+?)（\d+ 条） =====$/

function unescape(text) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = text[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === '\\') out += '\\'
    else if (next === "'") out += "'"
    else out += next ?? ''
  }
  return out
}

function quote(text) {
  return `'${text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`
}

/** 读 zh-CN.ts → [{ bucket, key }]（保持文件顺序） */
function readZh() {
  const lines = fs.readFileSync(ZH_PATH, 'utf8').split('\n')
  const entries = []
  let bucket = 'other'
  for (const line of lines) {
    const group = GROUP_RE.exec(line)
    if (group) {
      bucket = group[1]
      continue
    }
    const entry = ENTRY_RE.exec(line)
    if (entry) entries.push({ bucket, key: unescape(entry[1]) })
  }
  return entries
}

function slug(bucket) {
  return bucket
    .replace(/^modules\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function commandPlan({ chunk, force }) {
  const entries = readZh()
  if (fs.existsSync(PLAN_PATH) && !force) {
    const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
    console.log(`清单已存在：${plan.parts.length} 块 / ${plan.total} 条（用 --force 重新切块）`)
    return
  }
  fs.mkdirSync(PARTS_DIR, { recursive: true })
  // 清掉上一次的清单文件（译文 .en.json 保留）
  for (const name of fs.readdirSync(PARTS_DIR)) {
    if (name.endsWith('.zh.json')) fs.rmSync(path.join(PARTS_DIR, name))
  }

  const parts = []
  let index = 0
  for (let i = 0; i < entries.length; ) {
    const bucket = entries[i].bucket
    const items = []
    while (i < entries.length && entries[i].bucket === bucket && items.length < chunk) {
      items.push(entries[i].key)
      i += 1
    }
    index += 1
    const id = `${String(index).padStart(2, '0')}-${slug(bucket)}`
    writeJson(path.join(PARTS_DIR, `${id}.zh.json`), { bucket, items })
    parts.push({ id, bucket, count: items.length })
  }

  writeJson(PLAN_PATH, { total: entries.length, chunk, parts })
  console.log(`切块完成：${parts.length} 块 / ${entries.length} 条 → ${path.relative(FRONTEND, PARTS_DIR)}`)
  for (const part of parts) console.log(`  ${part.id}  ${part.count} 条`)
}

function commandStatus() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
  let done = 0
  const pending = []
  for (const part of plan.parts) {
    const file = path.join(PARTS_DIR, `${part.id}.en.json`)
    if (!fs.existsSync(file)) {
      pending.push(part)
      continue
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const count = Array.isArray(data) ? data.length : (data.items?.length ?? 0)
    if (count !== part.count) {
      pending.push({ ...part, mismatch: count })
      continue
    }
    done += part.count
  }
  const percent = ((done / plan.total) * 100).toFixed(1)
  console.log(`已翻 ${done} / ${plan.total} 条（${percent}%），待翻 ${plan.total - done} 条`)
  for (const part of pending) {
    console.log(
      part.mismatch === undefined
        ? `  待翻 ${part.id}（${part.count} 条）`
        : `  条数不符 ${part.id}：期望 ${part.count}，实际 ${part.mismatch}`
    )
  }
}

function commandBuild() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
  const entries = readZh()
  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'))
    : {}
  const byBucket = new Map()
  let missing = 0
  let same = 0
  let cursor = 0

  for (const part of plan.parts) {
    const zh = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, `${part.id}.zh.json`), 'utf8')).items
    const enFile = path.join(PARTS_DIR, `${part.id}.en.json`)
    let en = null
    if (fs.existsSync(enFile)) {
      const data = JSON.parse(fs.readFileSync(enFile, 'utf8'))
      en = Array.isArray(data) ? data : data.items
      if (en.length !== zh.length) {
        console.warn(`跳过 ${part.id}：译文 ${en.length} 条与原文 ${zh.length} 条不一致`)
        en = null
      }
    }
    if (!byBucket.has(part.bucket)) byBucket.set(part.bucket, new Map())
    const group = byBucket.get(part.bucket)
    for (let i = 0; i < zh.length; i += 1) {
      const key = zh[i]
      if (!entries[cursor] || entries[cursor].key !== key) {
        throw new Error(`清单与 zh-CN.ts 不一致（第 ${cursor + 1} 条）：${key}`)
      }
      cursor += 1
      const value = en?.[i]
      if (typeof value !== 'string' || !value.trim()) {
        missing += 1
        continue
      }
      if (value === key) same += 1
      group.set(key, value)
    }
  }

  // overrides.json：先落到已有分组（覆盖该条译文），剩下的作为「只对英文有效」的补充条目。
  const extra = []
  for (const [key, value] of Object.entries(overrides)) {
    const hit = [...byBucket.values()].find((group) => group.has(key))
    if (hit) hit.set(key, value)
    else extra.push([key, value])
  }

  const lines = []
  let total = 0
  for (const [bucket, group] of byBucket) {
    if (group.size === 0) continue
    lines.push(`  // ===== ${bucket}（${group.size} 条） =====`)
    for (const [key, value] of group) lines.push(`  ${quote(key)}: ${quote(value)},`)
    lines.push('')
    total += group.size
  }

  if (extra.length > 0) {
    lines.push(`  // ===== extra（${extra.length} 条，见 overrides.json） =====`)
    for (const [key, value] of extra) lines.push(`  ${quote(key)}: ${quote(value)},`)
    lines.push('')
    total += extra.length
  }

  const output = `/**
 * 英文词条。
 *
 * key 是**中文原文**（与 \`zh-CN.ts\` 完全一致），value 是对应英文。
 * 当前 ${total} 条；没有条目的地方自动显示中文原文（i18next 找不到就返回 key）。
 *
 * 生成方式：\`node scripts/i18n-translate.mjs --build\`
 * 译文源文件在 \`scripts/i18n-en/parts/*.en.json\`（与中文清单等长、顺序一一对应），
 * 少数只对英文有效的条目在 \`scripts/i18n-en/overrides.json\`。
 * 不要直接改本文件：重新 build 会覆盖。
 *
 * 文案变更流程：改代码里的中文 → \`npm run i18n:dict\`（重建 zh-CN.ts）→
 * \`node scripts/i18n-translate.mjs --plan --force\` → 补新条目的译文 → \`--build\`。
 */
const enUS: Record<string, string> = {
${lines.join('\n').trimEnd()}
}

export default enUS
`
  fs.writeFileSync(EN_PATH, output, 'utf8')
  console.log(`已生成 en-US.ts：${total} 条`)
  if (missing > 0) console.log(`未翻译 ${missing} 条（运行时回退中文）`)
  if (same > 0) console.log(`提示：${same} 条译文与中文完全相同（纯符号/专名可以忽略）`)
  if (total - extra.length + missing !== entries.length) {
    console.warn(`注意：清单 ${entries.length} 条，本次处理 ${total - extra.length + missing} 条`)
  }
}

function commandCheck() {
  if (!fs.existsSync(EN_PATH)) {
    console.error('en-US.ts 不存在，先跑 --build')
    process.exit(1)
  }
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
  const zhKeys = new Set(readZh().map((entry) => entry.key))
  const overrides = fs.existsSync(OVERRIDES_PATH)
    ? JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'))
    : {}
  const extraKeys = new Set(Object.keys(overrides))

  const pairs = []
  for (const line of fs.readFileSync(EN_PATH, 'utf8').split('\n')) {
    const m = ENTRY_RE.exec(line)
    if (m) pairs.push([unescape(m[1]), unescape(m[2])])
  }

  const placeholders = (text) =>
    [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',')
  const tagNames = (text) => [...text.matchAll(/<(\w+)>/g)].map((m) => m[1]).sort().join(',')

  const problems = []

  // 分块是否还跟当前 zh-CN.ts 对得上：改过文案却没重切块时，译文会整体错位。
  const entries = readZh()
  let cursor = 0
  let mismatched = false
  for (const part of plan.parts) {
    const zh = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, `${part.id}.zh.json`), 'utf8')).items
    for (const key of zh) {
      if (entries[cursor]?.key !== key) {
        problems.push(
          `分块与 zh-CN.ts 不一致（第 ${cursor + 1} 条应为「${entries[cursor]?.key ?? '—'}」）：${part.id}`
        )
        mismatched = true
        break
      }
      cursor += 1
    }
    if (mismatched) break
  }
  if (!mismatched && cursor !== entries.length) {
    problems.push(`分块只覆盖了 ${cursor} / ${entries.length} 条，需要重跑 --plan --force`)
  }

  for (const [key, value] of pairs) {
    if (!zhKeys.has(key) && !extraKeys.has(key)) problems.push(`孤儿词条（中文清单里没有）：${key}`)
    if (placeholders(key) !== placeholders(value)) {
      problems.push(`占位符不一致：${key} → ${value}`)
    }
    if (tagNames(key) !== tagNames(value)) problems.push(`标签不一致：${key} → ${value}`)
  }
  const translated = pairs.filter(([key, value]) => zhKeys.has(key) && value.trim()).length
  const percent = ((translated / plan.total) * 100).toFixed(1)

  if (problems.length > 0) {
    console.error(`en-US 校验失败（${problems.length} 项）：`)
    for (const item of problems.slice(0, 40)) console.error(`  ${item}`)
    process.exit(1)
  }
  console.log(
    `en-US 校验通过：${translated} / ${plan.total} 条（${percent}%），另有 ${pairs.length - translated} 条 only-en 补充`
  )
}

function main() {
  const args = process.argv.slice(2)
  const chunkIndex = args.indexOf('--chunk')
  const chunk = chunkIndex === -1 ? DEFAULT_CHUNK : Number(args[chunkIndex + 1])
  if (args.includes('--plan')) commandPlan({ chunk, force: args.includes('--force') })
  else if (args.includes('--status')) commandStatus()
  else if (args.includes('--build')) commandBuild()
  else if (args.includes('--check')) commandCheck()
  else {
    console.log('用法：--plan [--force] [--chunk N] | --status | --build | --check')
  }
}

main()
