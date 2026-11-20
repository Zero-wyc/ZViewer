# Local Patches (vendored mediabunny)

`vendor/mediabunny/` 是**官方 npm 发布产物**的逐字节副本：`mediabunny@1.66.2`
（2026-11-19）。本文件放在 `vendor/` 而非 `vendor/mediabunny/`，因为抓取脚本
会整目录清理重建，写在里面会被删掉。

```
node frontend/vendor/fetch-mediabunny.mjs        # 按 jsDelivr 清单抓取 + 自动重放补丁
node frontend/vendor/local-patches.mjs           # 单独重放补丁
node frontend/vendor/local-patches.mjs --check   # 只校验，不写文件
```

抓取脚本用 jsDelivr 的**文件清单**驱动（而不是 import 图递归），保证
`dist/modules` 下全部 `.js` / `.d.ts` 与官方包逐字节一致——包内存在无人
import 的独立模块（如 `dist/modules/shared/dts-misc.js`），递归会静默漏抓。
升级版本只需改 `fetch-mediabunny.mjs` 里的 `PKG` 常量，然后重跑
`local-patches.mjs --check`。

## Patch inventory

**当前为空。** 历史上打过 5 个 hunk，1.66.2 起全部由上游内建：

| 历史补丁 | 上游状态 | 位置 |
|---|---|---|
| DTS 注册为已知音频编码 | 已内建 | `codec.js` 的已知音频编码列表含 `'dts'` |
| DTS → MSE codec string `dtsc`（2 处） | 已内建 | `codec.js:617` / `codec.js:667` |
| Matroska `A_DTS` → codec `dts` | 已内建 | `matroska/ebml.js:742` |
| `A_DTS` 音轨透传（SimpleBlock = 完整帧） | 已内建 | `matroska/matroska-demuxer.js:975`，且帧长 512 |
| FLAC MP4 `AudioSampleEntry` 读真实位深 | 已内建 | `isobmff/isobmff-boxes.js:699`（`readBits(5) + 1`） |

之前的写法（fork 基座 + `find`/`replace` 程序化补丁）保留在
`local-patches.mjs` 的机制里：若上游日后回归（例如 DTS 映射被删、FLAC
位深退回硬编码 16），在 `LOCAL_PATCHES` 加回条目即可，fetch 流程不变。
`--check` 会在补丁未在位时抛错，避免静默产出残缺副本。

## 为什么不再用 kzahel fork

2026-03-08 之前，仓库 vendored 的是 `kzahel/mediabunny@cd3cd2be`
（`integration` 分支，基于 v1.38.1）。当时需要它，因为它是唯一同时具备
`A_DTS` 支持与内嵌字幕轨 API 的版本：

- `Input.getSubtitleTracks()`
- `formatCuesToWebVTT()`

1.66.2 的 `Input` 仍然**没有**字幕轨读取能力（muxer 侧已有字幕工具，
demux 侧还没做）。ZViewer 不依赖它：

1. `playsvideo-subtitle-bridge.ts` 的 `subscribePlaysVideoSubtitles()` 全仓
   零调用方——playsvideo 的 `<track>` 桥接实际是死路径；
2. 内嵌字幕实际全部走 `frontend/src/modules/subtitles/mkv-embedded.ts`
   的自研 MKV 解析器（Range 探测 + 稀疏提取）；
3. playsvideo 的 `demux.js` 已用 try/catch 包住字幕探测，缺 API 只让
   `subtitleTracks` 恒为空，不影响 demux 结果。

## 升级 1.66.2 后必须注意的两点

1. **TrueHD 会被误判为可转码。** 上游把 `A_TRUEHD` 登记为 codec
   `truehd`、decoderConfig `mlpa`，`AudioDecoderConfig` 非空 ⇒
   playsvideo 的 `doTranscode` 为 true。但 wasm ffmpeg 只有 audio tier
   （`ac3/eac3/dts/mp3/flac/opus`），`FULL_TIER_ENABLED = false`，转码必抛
   `Full ffmpeg tier is not currently enabled`。`pipeline/demux.js` 加了
   `NON_TRANSCODABLE_AUDIO` 守卫，见下节。
2. **内嵌字幕轨永远为空。** 见上节，ZViewer 已由自研解析器覆盖。

## playsvideo 侧补丁（不属于 mediabunny 副本）

`frontend/vendor/playsvideo/dist/pipeline/demux.js` 里有两处本地改动，
不在本文件的管辖范围，但依赖这里的行为：

- 音轨择优：`codec` 可识别 + 能取到 `decoderConfig` + **可被 wasm ffmpeg
  转码**，三者同时满足才选中该轨；否则退到下一条兼容轨（TrueHD 7.1 +
  AC-3 5.1 是 remux 常见组合），全部不可用则静默降级并把原始 CodecID
  记入 `audioDropped`。
- mux 只在「有音频包且 `audioDecoderConfig` 非空」时建音轨。

## Regression

- `node --test frontend/scripts/test-flac-mp4.mjs`（仓库根目录执行）：
  用 `vendor/mediabunny/` 副本重封装 16/24-bit FLAC。设 `ZVIEWER_TEST_BROWSER=1` 可额外
  验证真实 Chromium MSE 播放。夹具说明见 `frontend/scripts/fixtures/flac/README.md`。
- `npm run test:playsvideo -w frontend`：TrueHD/Atmos 音轨丢弃与 mux 守卫。
