import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'node:fs'

/**
 * dash.js 5.2.0 上游缺陷运行时补丁。
 *
 * dash.js destroy 后，PlaybackController/ABR 规则（BolaRule、
 * SwitchHistoryRule、DroppedFramesRule、StreamController.onEnded 等）的
 * 残留回调仍挂在 video 元素上；此时 getStreamInfo() 已返回 null，
 * 回调内部直接读 `.id` 抛 "can't access property \"id\", D is null"，
 * 每次引擎切换（清理旧 dash 实例）后随 video 事件刷屏。
 *
 * 处理方式：把包产物中所有未判空的 `getStreamInfo().id` 改写为可选链
 * `getStreamInfo()?.id`，残留回调静默降级（id 为 undefined 不再崩溃）。
 * 通过 vite 插件在加载时转换（dev 走 optimizeDeps 的 esbuild 插件——
 * dashjs 被内联进 .vite/deps 预构建产物，常规 transform 不经过；
 * build 走 rollup transform），不修改物理文件、不影响 lockfile。
 * 上游修复后移除本插件即可。
 */
const DASHJS_NULL_GUARD_RULES = [
  { from: 'getStreamInfo().id', to: 'getStreamInfo()?.id' },
] as const

function applyDashjsNullGuards(code: string): string {
  let out = code
  for (const rule of DASHJS_NULL_GUARD_RULES) {
    out = out.split(rule.from).join(rule.to)
  }
  return out
}

/** 是否为 dashjs 的压缩产物文件（esm/umd、all/mss 变体） */
function isDashjsDistFile(id: string): boolean {
  return /dashjs[/\\]dist[/\\].*dash\.all(\.mss)?\.min\.js$/.test(
    id.replace(/\\/g, '/')
  )
}

const dashjsNullGuardPlugin: Plugin = {
  name: 'dashjs-5-2-0-null-guard',
  // 生产构建（rollup）：转换 dashjs 产物
  transform(code, id) {
    if (isDashjsDistFile(id)) {
      return applyDashjsNullGuards(code)
    }
  },
}

// dev 依赖预构建（esbuild）：dashjs 被内联进 @videojs/dash-video 的
// 预打包产物，必须用 esbuild onLoad 在入管前改写源文件内容
interface EsbuildLikePlugin {
  name: string
  setup: (build: {
    onLoad: (
      options: { filter: RegExp },
      callback: (args: {
        path: string
      }) => { contents: string; loader: string } | undefined
    ) => void
  }) => void
}

const dashjsNullGuardEsbuildPlugin: EsbuildLikePlugin = {
  name: 'dashjs-5-2-0-null-guard-prebundle',
  setup(build) {
    build.onLoad(
      { filter: /dashjs[/\\]dist[/\\].*dash\.all(\.mss)?\.min\.js$/ },
      (args) => {
        const file = args.path.replace(/\\/g, '/')
        if (!isDashjsDistFile(file)) return undefined
        const code = fs.readFileSync(args.path, 'utf8')
        return { contents: applyDashjsNullGuards(code), loader: 'js' }
      }
    )
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [dashjsNullGuardPlugin, react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // playsvideo 0.4.x 依赖 kzahel/mediabunny 的 integration fork（支持字幕轨 API），
      // 该 fork 无法从 npm 正常安装（npm 上的 1.38.1 是旧发布版，与分支源码不一致），
      // 因此 vendored 到 ./vendor/mediabunny（见 vendor/fetch-mediabunny.mjs，含 DTS 本地补丁）。
      // alias 让 'mediabunny' 直接解析到本地副本，dev 与 build 行为一致，
      // 不依赖 npm overrides / lockfile 的解析结果。
      mediabunny: path.resolve(__dirname, './vendor/mediabunny'),
    },
    // vendor 副本是纯 ESM 源码树，保留默认解析即可
    dedupe: ['mediabunny'],
  },
  optimizeDeps: {
    // 关键：playsvideo 内部用 `new Worker(new URL('./worker.js', import.meta.url))` 创建
    // 播放/转码 worker。esbuild 的 dep 预打包会原样保留这个表达式，却不把 worker.js 输出成
    // 独立文件，导致 dev 下请求 /node_modules/.vite/deps/worker.js 404 → worker.onerror
    // → "Playback worker crashed"（生产构建无此问题，Rollup + Vite worker 插件处理正常）。
    // 排除后改由 Vite 自己的管线处理，worker 会被正确单独打包，resolve.alias 也照样生效。
    exclude: ['playsvideo'],
    esbuildOptions: {
      plugins: [dashjsNullGuardEsbuildPlugin as never],
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    assetsInlineLimit: 0, // 不内联 wasm，确保 ffmpeg-core.wasm 作为独立资源正确加载
  },
  server: {
    port: 5174,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        // 后端使用 HTTPS 自签证书时，跳过证书验证
        secure: false,
      },
      '/uploads': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3333',
        changeOrigin: true,
        ws: true,
        secure: false,
      },
      // 开发环境代理 NMS HTTP-FLV 拉流，匹配 /live/<streamKey>.flv
      '/live': {
        target: process.env.VITE_LIVE_TARGET || 'http://localhost:3335',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  // 生产环境由后端统一托管前端静态文件（统一端口 3333），
  // 不再使用 vite preview，因此移除 preview 配置。
})
