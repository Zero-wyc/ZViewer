// 为体积大、内容高度稳定的静态资源预生成 Brotli 副本（.br）。
//
// 为什么在构建期做而不是运行时压：
//   1. wasm / 模型都是「一次构建、长期不变」的字节流，压一次就够；
//   2. brotli q11 压 10MB 要几十秒，放在请求路径上不可接受；
//   3. EdgeOne 自带的 br 是低质量档（实测 MediaPipe wasm 10.6MB 下发 3.06MB，
//      而 q11 只要 2.17MB）。源站直发高质量副本，CDN 见 Content-Encoding 会
//      透传，不必改 CDN 配置。
//
// 产物只落在 dist/（不进 git、不进 public/），随 Docker COPY 一起发布。
// 由 backend-go 的 servePrecompressed 按 Accept-Encoding 决定是否下发。
// 由 npm 的 postbuild 自动调用；SKIP_PRECOMPRESS=1 可跳过。

import { readdirSync, statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const DIST = join(here, '..', 'dist')

// 只处理这两类：wasm 运行时与 MediaPipe 模型包。
// 不碰 .js/.css —— EdgeOne 已经压得到位，重复劳动只会让产物变大。
const TARGET_EXT = new Set(['.wasm', '.task'])
// 小文件压了不划算（brotli 有固定头开销）
const MIN_BYTES = 64 * 1024

const mb = (n) => `${(n / 1048576).toFixed(2)}MB`

if (process.env.SKIP_PRECOMPRESS === '1') {
  console.log('[precompress] SKIP_PRECOMPRESS=1，跳过')
  process.exit(0)
}

if (!existsSync(DIST)) {
  console.warn('[precompress] dist 不存在，跳过（请先 vite build）')
  process.exit(0)
}

/** 递归收集目标文件 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, out)
    } else if (entry.isFile() && TARGET_EXT.has(extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

const files = collect(DIST).filter((f) => statSync(f).size >= MIN_BYTES)
if (files.length === 0) {
  console.log('[precompress] 没有需要预压缩的资源')
  process.exit(0)
}

let rawTotal = 0
let brTotal = 0
let compressed = 0

for (const file of files) {
  const rel = file.slice(DIST.length + 1)
  const src = statSync(file)
  const out = `${file}.br`

  // 已存在且不比源旧就跳过：连续 build 时不必再等几十秒
  if (existsSync(out) && statSync(out).mtimeMs >= src.mtimeMs) {
    const cached = statSync(out).size
    rawTotal += src.size
    brTotal += cached
    console.log(`[precompress] ${rel} 已有 .br（${mb(cached)}），跳过`)
    continue
  }

  const started = Date.now()
  const buf = brotliCompressSync(readFileSync(file), {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      // 10MB 级文件用 16MB 窗口，跨窗口的长距离重复才吃得下
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: src.size,
    },
  })
  writeFileSync(out, buf)
  rawTotal += src.size
  brTotal += buf.length
  compressed += 1
  console.log(
    `[precompress] ${rel} ${mb(src.size)} → ${mb(buf.length)} ` +
      `(${(buf.length / src.size * 100).toFixed(0)}%, ${((Date.now() - started) / 1000).toFixed(1)}s)`
  )
}

if (compressed > 0) {
  console.log(
    `[precompress] 完成 ${compressed} 个文件：${mb(rawTotal)} → ${mb(brTotal)} ` +
      `(省 ${mb(rawTotal - brTotal)})`
  )
}
