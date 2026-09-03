import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
