/** 临时分析：读 i18n-report.json，按原因/文件统计未自动处理的文案。 */
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
