/**
 * DASH 引擎真实浏览器测试:Playwright + 系统 Chrome 打开测试页,
 * 读取 window.__TEST_RESULT 与控制台日志。
 */
import { chromium } from 'playwright'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:5199/test-dash-engine.html'

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()

const consoleLogs = []
page.on('console', (msg) => {
  consoleLogs.push(`[${new Date().toISOString().slice(11, 23)}][${msg.type()}] ${msg.text()}`)
})
page.on('pageerror', (err) => {
  consoleLogs.push(`[${new Date().toISOString().slice(11, 23)}][pageerror] ${err.message}`)
})
page.on('requestfailed', (req) => {
  consoleLogs.push(
    `[${new Date().toISOString().slice(11, 23)}][requestfailed] ${req.url().slice(0, 150)} → ${req.failure()?.errorText}`
  )
})

// 实验模式:MPD 走 HTTP URL(绕开 blob manifest)。通过环境变量开关
const MPD_VIA_HTTP = process.env.MPD_VIA_HTTP === '1'
const BLOB_NO_CRED = process.env.BLOB_NO_CRED === '1'
const SKIP_EXP = process.env.SKIP_EXP === '1'
if (SKIP_EXP) {
  await page.addInitScript(() => { window.__SKIP_EXP = true })
  console.log('>>> 纯净模式:跳过 exp3/exp4,仅引擎单实例')
}
if (MPD_VIA_HTTP) {
  await page.addInitScript(() => { window.__MPD_VIA_HTTP = true })
  await page.route('**/test-mpd-rewrite.mpd', async (route) => {
    const mpdText = await page.evaluate(() => window.__MPD_TEXT)
    if (mpdText) {
      await route.fulfill({ status: 200, contentType: 'application/dash+xml', body: mpdText })
    } else {
      await route.abort()
    }
  })
  console.log('>>> 实验模式:MPD 走 HTTP(Playwright route)')
}
if (BLOB_NO_CRED) {
  await page.addInitScript(() => { window.__BLOB_NO_CREDENTIALS = true })
  console.log('>>> 实验模式:blob XHR 去除 credentials')
}

await page.goto(URL, { waitUntil: 'domcontentloaded' })

// CDP 抓请求 initiator(完整异步堆栈)
const cdp = await page.context().newCDPSession(page)
await cdp.send('Network.enable')
const initiatorStacks = []
cdp.on('Network.requestWillBeSent', (e) => {
  if (e.request.url.startsWith('blob:')) {
    const frames = e.initiator?.stack?.callFrames?.map((f) => `${(f.functionName || '(anon)').slice(0, 40)} @ ${f.url.split('/').pop()}:${f.lineNumber}`) ?? []
    initiatorStacks.push({
      url: e.request.url.slice(-14),
      type: e.initiator?.type,
      stack: frames.slice(0, 12),
    })
  }
})

// 等测试完成(最多 40s)
await page.waitForFunction(() => window.__TEST_RESULT, null, { timeout: 40000 })
const result = await page.evaluate(() => window.__TEST_RESULT)

console.log('===== 页面日志 =====')
for (const l of result.logs ?? []) console.log(l)
console.log('\n===== 控制台(全部,不过滤) =====')
for (const l of consoleLogs) console.log(l.slice(0, 500))
console.log('\n===== 汇总 =====')
console.log(JSON.stringify({ ok: result.ok, finalState: result.finalState, error: result.error, cause: result.cause }, null, 2))
console.log('\n===== BLOB 生命周期 =====')
for (const l of result.blobLog ?? []) console.log(l)
console.log('\n===== XHR =====')
for (const l of result.xhrLog ?? []) console.log(l)
console.log('\n===== FETCH =====')
for (const l of result.fetchLog ?? []) console.log(l)
console.log('\n===== 资源请求 =====')
for (const r of (result.reqLog ?? []).slice(0, 30)) console.log(r.slice(0, 200))
console.log('\n===== CDP blob 请求 initiator 堆栈 =====')
for (const s of initiatorStacks) {
  console.log(`\nblob ...${s.url} (initiator type=${s.type})`)
  for (const f of s.stack) console.log(`  ${f}`)
}

await browser.close()
process.exit(0)
