/**
 * 看「哪些中文没被自动替换、为什么」。
 *
 *   node scripts/i18n-extract.mjs --scope src --report ./i18n-report.json
 *   node scripts/i18n-analyze.mjs <原因> [text]
 *
 * 原因取自报告里的 reason：module-scope / jsx-multi-child / comparison / string-match…
 * 带 text 参数时逐条打印文件、行号与原文。
 */
import fs from 'node:fs'

const report = JSON.parse(fs.readFileSync(new URL('../i18n-report.json', import.meta.url), 'utf8'))
const reason = process.argv[2] ?? 'jsx-multi-child'
const items = report.skipped.filter((item) => item.reason === reason)

const byFile = new Map()
for (const item of items) {
  byFile.set(item.file, (byFile.get(item.file) ?? 0) + 1)
}
const short = (file) => file.split(/[\\/]/).slice(2).join('/')
console.log(`原因 ${reason}：${items.length} 条 / ${byFile.size} 个文件`)
for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${short(file)}`)
}
if (process.argv[3] === 'text') {
  console.log('--- 文本 ---')
  for (const item of items) console.log(`${short(item.file)}:${item.line}  ${item.text}`)
}
