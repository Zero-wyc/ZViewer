// 把 MediaPipe 的 WASM 运行时从 node_modules 分发到 frontend/public。
//
// 为什么要复制而不是直接引用 node_modules：
//   FilesetResolver 按「目录」去找 vision_wasm_internal.js/.wasm，Vite 没有
//   「把一个目录当静态资源」的入口；而这三个文件合计 30MB+，提交进仓库会让
//   每次改前端都多背一份二进制。
//
// 只复制 SIMD 版（约 11MB）：Chrome 91+ / Safari 16.4+ / WebView2 都支持 wasm
// SIMD，桌面端就是 WebView2。nosimd 版只在 2021 年前的浏览器上才用得上，
// 为它多背 10MB 不值得——真遇到老浏览器，动捕会走到「加载失败」而不是白屏
// （见 face-tracker 的 SIMD 探测）。
//
// 由 npm 的 predev / prebuild 自动调用，失败不阻断构建。

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = join(root, '..', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const dest = join(root, 'public', 'live2d', 'face', 'wasm')

const FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']

if (!existsSync(src)) {
  console.warn(
    '[live2d] 跳过摄像头动捕运行时：未安装 @mediapipe/tasks-vision'
  )
  process.exit(0)
}

mkdirSync(dest, { recursive: true })
let copied = 0
for (const name of FILES) {
  const from = join(src, name)
  const to = join(dest, name)
  if (!existsSync(from)) {
    console.warn(`[live2d] 缺少 ${name}，摄像头动捕可能不可用`)
    continue
  }
  // 已存在且大小一致就跳过：这个目录每次 build 都会被访问一次
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue
  copyFileSync(from, to)
  copied += 1
}

console.log(
  copied > 0
    ? `[live2d] 已分发摄像头动捕运行时（${copied} 个文件 → public/live2d/face/wasm）`
    : '[live2d] 摄像头动捕运行时已是最新'
)
