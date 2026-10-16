# playsvideo / mediabunny 引用链说明

本文档解释 playsvideo 播放引擎依赖的「垫片」体系：为什么存在三层 mediabunny
引用、为什么 playsvideo 版本必须锁定、补丁如何维护。改动任何一层前请先读完。

## 背景事实（2026-10 查证）

- **playsvideo 0.4.7 就是上游最新版**：npm 与 GitHub tag 均停在 0.4.7
  （2026-03-14）。上游 main 分支之后的提交全部是作者站点功能（app/、
  extension 等），播放管线核心零更新。
- **ZViewer 的 5 个本地补丁上游均不存在**（逐文件核对过 main 分支）：
  1. MKV cue 索引按视频轨过滤（`mkv-keyframe-index`），否则音视频起点错位数秒
  2. AAC 转码 priming 丢帧（`audio-transcode`），否则每次切分段开头有静音帧
  3. 字幕探测容错（`demux`），探测失败不得拖垮整个 demux 导致无声
  4. `formatCuesToWebVTT` 内联（`subtitle`），摆脱对 mediabunny fork 私有 API 的直接依赖
  5. 分段转码 padding 泄漏过滤（`segment-processor`）
- **mediabunny 生态割裂**：官方 npm mediabunny（1.40+）重写了 Input API、
  移除了 playsvideo 依赖的字幕轨方法，直接装官方版会让 playsvideo 崩溃
  （`getSubtitleTracks is not a function` → DemuxResult 丢失 → 无声）。
  playsvideo（含 main 分支）绑死在作者的 fork `kzahel/mediabunny#integration`，
  该分支 HEAD 冻结于 2026-03-08：
  `cd3cd2beb9c122dfa6fa89edbd7a73f2fa9df7a0`。

结论：不存在「升级到最新版」这条路。策略是锁定 + vendor 化，等上游适配
官方 mediabunny 后再重估。

## 三层 mediabunny 引用机制

同一个 vendored fork（`frontend/vendor/mediabunny/`，源码入库）被三层机制
引用，各层职责不同、互为防线：

| 层 | 位置 | 作用域 | 职责 |
|---|---|---|---|
| 1. npm overrides | 根 `package.json` → `overrides.mediabunny = file:frontend/vendor/mediabunny` | 安装期 | 把 playsvideo 内部声明的 `github:kzahel/mediabunny#integration` 重定向到 vendored 副本，保证提升到根 node_modules 的 `mediabunny` 就是 fork（含 DTS 补丁） |
| 2. 显式依赖 | `frontend/package.json` → `"mediabunny": "file:vendor/mediabunny"` | 安装期 + 文档化 | 显式声明依赖；若第 1 层被误删，防止解析到 npm 官方 1.55+（会崩溃的那个版本） |
| 3. Vite alias | `frontend/vite.config.ts` → `resolve.alias.mediabunny` | 构建/运行期 | dev 与 build 都强制解析到 vendor 源码，不依赖 npm 安装方式与 node_modules 布局 |

**断掉某一层会怎样：**

- 断第 1 层（overrides）：npm 直接安装 GitHub fork tarball——内容与 vendor
  副本不一致（丢失本地 DTS 补丁），且每次安装结果随上游分支漂移。
- 断第 2 层（显式依赖）：短期内仍能工作（第 1 层已把包提升到根
  node_modules），但失去「误删 override 后静默解析到官方 1.55+」的保护。
- 断第 3 层（alias）：依赖 node_modules 解析，通常仍工作；但 vendor 目录
  更新后若未重跑 npm install，dev/build 会用到过期的 node_modules 副本。

两处 `file:` 路径写法不同是正常的：`file:vendor/mediabunny` 相对 frontend
包目录解析，`file:frontend/vendor/mediabunny` 相对仓库根解析，指向同一目录。

## vendored mediabunny 的维护

- 源码树：`frontend/vendor/mediabunny/dist/modules/src/**`（含同名 .d.ts，
  供 tsc 解析 playsvideo 的声明文件）。
- 抓取脚本：`node frontend/vendor/fetch-mediabunny.mjs`——从
  `kzahel/mediabunny` 抓取 fork 源码。**建议固定 commit SHA 而非分支名**
  （当前 integration HEAD：`cd3cd2beb9c122dfa6fa89edbd7a73f2fa9df7a0`），
  否则分支漂移会让重抓结果与入库副本不一致。
- **DTS 补丁是手工的**：抓取后需按 `vendor/mediabunny/package.json`
  description 中的说明，在 `matroska/ebml.js`、
  `matroska/matroska-demuxer.js`、`codec.js` 重打 `[本地补丁]` 标记处的
  DTS 支持（A_DTS demux，供 playsvideo 转码 DTS 音轨）。重新抓取时务必执行。
- 源码必须入库（`.gitignore` 已对 `vendor/mediabunny/dist/` 做了强制
  include）：CI 环境无法访问 GitHub 时构建仍可进行。

## playsvideo 补丁的维护

- 补丁文件：`patches/playsvideo+0.4.7.patch`，经根 `postinstall` 的
  **patch-package** 应用（`npm install` 时自动执行）。
- 版本**必须锁定精确版本**（`"playsvideo": "0.4.7"`，无 caret）：补丁是对
  dist 产物的逐行 diff，上游任何版本变动都会导致 apply 失败。
- 升级 playsvideo 前：先对照上游确认 5 个补丁是否已有等价修复，再重做
  patch（对 dist 打补丁意味着每次升级都要人工重放）。
- 校验补丁已生效：`grep "buildMkvKeyframeIndexFromSource(source, demux.videoTrack.id)" node_modules/playsvideo/dist/engine.js`。

## Vite 侧的配套配置（勿随手清理）

- `optimizeDeps.exclude: ['playsvideo']`：esbuild 依赖预打包会原样保留
  `new Worker(new URL('./worker.js', import.meta.url))` 却不输出独立
  worker 文件 → dev 下 404 → "Playback worker crashed"。排除后由 Vite
  自己的管线正确打包。
- `worker.format: 'es'`：worker 以 ESM 输出。
- `build.assetsInlineLimit: 0`：ffmpeg-core.wasm（约 1.8MB，音轨转码用，
  位于 playsvideo 包内 `dist/vendor/ffmpeg-core-audio/`）不得内联，必须
  作为独立资源随构建产物分发。构建后应能在 `dist/assets/ffmpeg-core-*.wasm`
  确认存在。
