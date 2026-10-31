import fs from 'node:fs'

// 按分组抽样打印中英对照，人工过一遍语感与错位
const zh = fs.readFileSync('src/i18n/locales/zh-CN.ts', 'utf8').split('\n')
const en = fs.readFileSync('src/i18n/locales/en-US.ts', 'utf8')
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
    else out += next
  }
  return out
}

const enMap = new Map()
for (const line of en.split('\n')) {
  const m = RE.exec(line)
  if (m) enMap.set(unescape(m[1]), unescape(m[2]))
}

const samples = process.argv.slice(2)
for (const key of samples) {
  console.log(`  ${key}\n    → ${enMap.get(key) ?? '<未翻译>'}`)
}
