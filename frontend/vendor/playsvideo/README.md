<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kzahel/playsvideo/main/docs/wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/kzahel/playsvideo/main/docs/wordmark-light.svg">
  <img alt="playsvideo" src="https://raw.githubusercontent.com/kzahel/playsvideo/main/docs/wordmark-light.svg" width="340">
</picture>

**You probably don't need VLC.** Play any video file in the browser — no install, no upload.

[Try it at playsvideo.com](https://playsvideo.com) &nbsp;|&nbsp; [Chrome Extension](https://chromewebstore.google.com/detail/playsvideo/leanfmncjikipbkbjghejpaenkpanimp) &nbsp;|&nbsp; Drop a file. It plays.

---

Many video files won't play in a browser — not because the browser can't *decode* the video, but because it can't open the container or handle the audio codec. playsvideo fixes that entirely client-side: it remuxes containers and transcodes audio on the fly, so your MKV with AC-3 audio just works.

### What it handles

| | Formats | Notes |
|---|---|---|
| **Containers** | MKV, MP4, AVI, TS, WebM | Demuxed and remuxed to fMP4 |
| **Video** | H.264, H.265 (HEVC), VP9, AV1 | Passthrough — plays ~99% of files (~90% on Firefox; HEVC transcode planned) |
| **Audio** | AAC, MP3, AC-3, E-AC-3, DTS, FLAC, Opus | Transcoded to AAC when the active playback path cannot use them safely |
| **Subtitles** | SRT, ASS/SSA | Extracted and displayed as WebVTT |

See [supported media](docs/supported-media.md) for the full codec matrix, browser compatibility, and transcode details.

### How it works

```
Video file (MKV, MP4, AVI, …)
  → mediabunny demux (streaming, any file size)
  → keyframe-aligned segment plan
  → per segment:
      video remuxed / passed through
      audio transcoded only if needed (AC-3/E-AC-3/DTS/MP3/FLAC/Opus → AAC)
      muxed to fMP4
  → hls.js plays segments on demand
  → subtitles extracted to WebVTT
```

Note: passthrough/native playback and remuxed HLS/MSE playback are evaluated separately. A source file can play fine via direct passthrough in both Chrome and Safari on macOS, yet still be unsafe once routed through the remuxed HLS/fMP4 pipeline. That is what we observed with AC-3: the original file played directly, but Safari produced audible stalls after remuxing to HLS/fMP4, while Chrome continued to play correctly. The remux pipeline therefore treats AC-3/E-AC-3 as unsafe there and transcodes them to AAC, without affecting native passthrough decisions.

Video transcode is almost never needed — browsers natively decode the vast majority of video codecs. When audio transcode is needed, a lightweight 1.8 MB ffmpeg.wasm build is lazy-loaded entirely in-browser. No SharedArrayBuffer required — works on any host without special CORS headers.

### Under the hood

The obvious approach — ffmpeg compiled to WebAssembly — can't handle large files (WORKERFS is catastrophically slow, MEMFS can't hold them). The trick is to split the problem:

- **[mediabunny](https://github.com/Vanilagy/mediabunny)** — streaming demux/remux in pure TypeScript, works on any size file
- **[ffmpeg.wasm](https://github.com/nicolo-ribaudo/ffmpeg.wasm)** — only transcodes short audio segments via MEMFS
- **[hls.js](https://github.com/video-dev/hls.js)** — battle-tested HLS playback via Media Source Extensions

Each piece existed separately. Nobody combined them.

### Use as a library

```bash
npm install playsvideo
```

```ts
import { PlaysVideoEngine } from 'playsvideo';

const video = document.querySelector('video')!;
const engine = new PlaysVideoEngine(video);

// Play a local file (drag-and-drop, <input type="file">, etc.)
engine.loadFile(file);

// Or play from a URL (requires CORS + range request support)
engine.loadUrl('https://example.com/video.mkv');

// Or attach an external .srt/.vtt subtitle file after loading
await engine.loadExternalSubtitle(subtitleFile);

engine.destroy(); // clean up
```

See [engine API docs](docs/engine-api.md) for events, properties, and full usage.

### Roadmap

See [docs/roadmap.md](docs/roadmap.md) for the full list. Highlights:

- **User-imported subtitles** — load external `.srt`/`.vtt` files alongside the video
- **WebCodecs** — replace ffmpeg.wasm with hardware-accelerated `AudioDecoder`/`AudioEncoder` and `VideoDecoder`/`VideoEncoder`

<details>
<summary><strong>Development</strong></summary>

```bash
pnpm run setup              # install deps + download ffmpeg-core.wasm
pnpm run dev                # vite dev server (simple player)
pnpm run typecheck          # tsc --noEmit
pnpm run test:unit          # fast unit tests
pnpm run lint               # biome lint
pnpm run format             # biome format
pnpm run test:integration   # requires test fixtures in tests/fixtures/
pnpm --filter app dev       # media player dev server (React app)
```

```
src/pipeline/       Core modules (demux, mux, segment plan, audio transcode,
                    codec probe, playlist, subtitle extraction)
src/adapters/       Platform adapters (ffmpeg.wasm for browser, node-ffmpeg for tests)
src/worker.ts       Web worker — demux + on-demand segment processing
src/engine.ts       PlaysVideoEngine class (worker, hls.js, subtitles)
src/pwa-player.ts   Browser entry — file picker, drag-and-drop
app/                React media player — library management, folder picker, playlists
tests/              Unit, integration, and e2e (Playwright) tests
```

</details>

### License

MIT. Dependencies include MPL-2.0 (mediabunny), Apache-2.0 (hls.js), and LGPL-2.1 (ffmpeg-core.wasm, loaded at runtime). No GPL codecs are compiled in. See [licensing details](docs/licensing.md) and [THIRD_PARTY_LICENSES](THIRD_PARTY_LICENSES).
