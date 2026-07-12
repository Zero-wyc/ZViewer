// 模拟浏览器 fetch 调用 B站解析接口，检查是否存在连接中断
const token = process.argv[2]
const bvid = process.argv[3] || 'BV1GJ411x7h7'

if (!token) {
  console.error('Usage: node test-resolve.mjs <jwt-token> [bvid]')
  process.exit(1)
}

const url = `http://localhost:3000/api/stream/resolve-bilibili?url=${encodeURIComponent('https://www.bilibili.com/video/' + bvid)}`

console.log('Fetching:', url)

const res = await fetch(url, {
  headers: {
    Authorization: `Bearer ${token}`,
  },
})

console.log('Status:', res.status)
console.log('Content-Type:', res.headers.get('content-type'))

const reader = res.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let lineCount = 0

try {
  while (true) {
    const { done, value } = await reader.read()
    if (value) {
      buffer += decoder.decode(value, { stream: true })
    }
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      lineCount++
      if (lineCount <= 5) {
        console.log('Line', lineCount, line.slice(0, 120))
      }
    }
    if (done) break
  }
  console.log('Total lines:', lineCount)
  console.log('Completed successfully')
} catch (err) {
  console.error('Reader error:', err)
  process.exit(1)
}
