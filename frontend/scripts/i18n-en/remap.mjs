/**
 * 一次性工具：把现有 en-US.ts 的译文重新分配到重切后的分块。
 *
 * 为什么要它：改了源码里的文案结构（多出 / 少掉词条）后，`--plan --force`
 * 会重新切块，原来按顺序对齐的 *.en.json 就错位了。这里以「中文原文 → 译文」
 * 为准重新映射，避免重翻。
 *
 *   node scripts/i18n-en/remap.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.resolve(HERE, '../..')
const EN_PATH = path.join(FRONTEND, 'src/i18n/locales/en-US.ts')
const PARTS_DIR = path.join(HERE, 'parts')
const PLAN_PATH = path.join(HERE, 'plan.json')

const RE = /^ {2}'((?:[^\\']|\\.)*)': '((?:[^\\']|\\.)*)',$/

function unescape(text) {
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\') {
      out += text[i]
      continue
    }
    const next = text[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 't') out += '\t'
    else out += next
  }
  return out
}

const known = new Map()
for (const line of fs.readFileSync(EN_PATH, 'utf8').split('\n')) {
  const m = RE.exec(line)
  if (m) known.set(unescape(m[1]), unescape(m[2]))
}
console.log(`已有译文 ${known.size} 条`)

const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'))
const missing = []
let written = 0

for (const part of plan.parts) {
  const zh = JSON.parse(fs.readFileSync(path.join(PARTS_DIR, `${part.id}.zh.json`), 'utf8')).items
  const items = zh.map((key) => {
    const value = known.get(key)
    if (!value) missing.push(`${part.id}: ${key}`)
    return value ?? ''
  })
  fs.writeFileSync(
    path.join(PARTS_DIR, `${part.id}.en.json`),
    `${JSON.stringify({ items }, null, 2)}\n`,
    'utf8'
  )
  written += items.filter((v) => v).length
}

console.log(`已重写 ${plan.parts.length} 个分块，可用译文 ${written} / ${plan.total}`)
if (missing.length > 0) {
  console.log(`缺失 ${missing.length} 条：`)
  for (const item of missing) console.log(`  ${item}`)
}
