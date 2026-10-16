# playsvideo / mediabunny 引用链说明

本文档解释 playsvideo 播放引擎依赖的「垫片」体系：vendored fork 的来源与
维护方式、各层引用机制的职责。改动任何一层前请先读完。

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

## 引用机制总览

两个 vendored fork（`frontend/vendor/mediabunny/` 与
`frontend/vendor/playsvideo/`，源码均入库）通过以下机制接入：

| 层 | 位置 | 作用域 | 职责 |
|---|---|---|---|
| 1. vendored playsvideo | `frontend/package.json` → `"playsvideo": "file:vendor/playsvideo"` | 安装期 | 播放引擎本体（0.4.7 + 5 个本地补丁直接改在源码里），其 package.json 声明 `"mediabunny": "file:../mediabunny"` 指向相邻 fork，安装期不触碰 GitHub/npm registry |
| 2. npm overrides | 根 `package.json` → `overrides.mediabunny = file:frontend/vendor/mediabunny` | 安装期 | 防线：把依赖树中任何 `mediabunny` 解析统一钉到 vendored 副本（vendored playsvideo 已自包含声明，此层为冗余保护） |
| 3. 显式依赖 | `frontend/package.json` → `"mediabunny": "file:vendor/mediabunny"` | 安装期 + 文档化 | 显式声明；防止误删 override 后静默解析到 npm 官方 1.55+（会崩溃的版本） |
| 4. Vite alias | `frontend/vite.config.ts` → `resolve.alias.mediabunny` | 构建/运行期 | dev 与 build 都强制解析到 vendor 源码，不依赖 npm 安装方式与 node_modules 布局 |

**断掉某一层会怎样：**

- 断第 1 层（vendored playsvideo 依赖）：回退 npm registry 版本，本地 5 个
  补丁全部消失（MKV 音视频起点错位、切段静音帧、字幕探测崩溃等回归）。
- 断第 2/3 层（overrides / 显式 mediabunny 依赖）：vendored playsvideo 的
  `file:../mediabunny` 仍能解析；但失去对「任何其他 mediabunny 引入方式」
  的钉死保护，误装官方 1.55+ 会崩溃。
- 断第 4 层（alias）：依赖 node_modules 解析，通常仍工作；但 vendor 目录
  更新后若未重跑 npm install，dev/build 会用到过期的 node_modules 副本。

`file:` 路径写法差异是正常的：`file:vendor/playsvideo` 相对 frontend 包
目录解析，`file:frontend/vendor/mediabunny` 相对仓库根解析；
`file:../mediabunny`（vendored playsvideo 内部）相对其自身目录解析。三者
指向 `frontend/vendor/` 下的同一批目录。

安装后形态：`frontend/node_modules/playsvideo` 为指向 vendor 的 symlink
（npm 对 workspace 内 file: 依赖不做根提升），`node_modules/mediabunny`
为指向 vendor 的 symlink（根提升）。

## vendored mediabunny 的维护

- 源码树：`frontend/vendor/mediabunny/dist/modules/src/**`（含同名 .d.ts，
  供 tsc 解析 playsvideo 的声明文件）。
- 抓取脚本：`node frontend/vendor/fetch-mediabunny.mjs`——从
  `kzahel/mediabunny` 抓取 fork 源码，**已固定 commit SHA**
  （`cd3cd2beb9c122dfa6fa89edbd7a73f2fa9df7a0`，integration 分支 2026-03-08
  HEAD），重新抓取结果与入库副本逐字节一致，不受分支漂移影响。
- **本地补丁已程序化**（`frontend/vendor/local-patches.mjs`）：DTS 支持
  （`codec.js` ×3、`matroska/ebml.js`、`matroska/matroska-demuxer.js`）+
  FLAC 位深修复（`isobmff/isobmff-boxes.js`），共 6 条。抓取脚本抓完会
  **自动重放**全部补丁；也可单独执行 `node frontend/vendor/local-patches.mjs`
  （补丁脚本幂等、行尾无关，`--check` 只校验不改文件）。find/replace 无法
  唯一匹配时脚本会报错退出——这意味着 REF 被更新过或文件被手工改动，必须
  人工重估，绝不静默产出缺补丁的副本。详见 `vendor/mediabunny/LOCAL-PATCHES.md`。
- 源码必须入库（`.gitignore` 已对 `vendor/mediabunny/dist/` 做了强制
  include）：CI 环境无法访问 GitHub 时构建仍可进行。

## vendored playsvideo 的维护（2026-10-16 起，替代 patch-package）

- 源码树：`frontend/vendor/playsvideo/**`——上游 npm 包 0.4.7 的完整副本，
  **6 个本地改动已直接改在 dist 产物里**（前 5 个为行为修复：MKV cue 按
  视频轨过滤、AAC priming 丢帧、字幕探测容错、formatCuesToWebVTT 内联、
  分段 padding 泄漏过滤；第 6 个为功能增强：worker 长耗时阶段心跳——
  probe/index/ffmpeg/seg0 期间每 3s postMessage `progress`，engine 转发为
  `progress` 事件，驱动上层活动超时与加载进度展示，见
  `worker.js` 的 `withHeartbeat` 与 `engine.js` 的 `handleWorkerMessage`）。
  原 `patches/playsvideo+0.4.7.patch` 与根 postinstall 的 patch-package 已
  随 vendor 化移除。
- 依赖声明：vendored package.json 的 `mediabunny` 已从
  `github:kzahel/mediabunny#integration` 改为 `file:../mediabunny`——安装期
  完全自包含，GitHub 不可达时也能装。
- 升级 playsvideo 前：先对照上游（npm / GitHub tag）确认 6 个本地改动是否
  已有等价实现（截至 2026-10 均无），再重新执行「拷贝上游 → 重放改动 →
  更新 vendor」三步。
- 校验补丁已生效：
  `grep "buildMkvKeyframeIndexFromSource(source, demux.videoTrack.id)" node_modules/playsvideo/dist/engine.js`；
  校验心跳已生效：`grep "withHeartbeat" node_modules/playsvideo/dist/worker.js`。
- `.gitignore`（frontend/）已对 `vendor/playsvideo/dist/` 做反忽略放行，
  修改 `.gitignore` 的 `dist` 规则时勿破坏。

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
