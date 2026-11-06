import fs from 'node:fs'

// 按分组抽样打印中英对照，人工过一遍语感与错位
// 统一归一化 CRLF：Windows 检出时每行尾巴带 \r，下面的正则（以 ,$ 收尾）会一条都匹配不到
const readLines = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
const zh = readLines('src/i18n/locales/zh-CN.ts')
const en = readLines('src/i18n/locales/en-US.ts')
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
for (const line of en) {
  const m = RE.exec(line)
  if (m) enMap.set(unescape(m[1]), unescape(m[2]))
}

const samples = process.argv.slice(2)
for (const key of samples) {
  console.log(`  ${key}\n    → ${enMap.get(key) ?? '<未翻译>'}`)
}
