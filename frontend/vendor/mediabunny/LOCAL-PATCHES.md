# Local Patches (vendored mediabunny)

All local patches on top of pristine `kzahel/mediabunny` @ `cd3cd2be`
(integration branch, 2026-03-08 HEAD) are **programmatic**: see
`frontend/vendor/local-patches.mjs`. They are re-applied automatically by
`fetch-mediabunny.mjs` after a re-fetch, so a full refresh is one
reproducible command:

```
node frontend/vendor/fetch-mediabunny.mjs        # fetch pristine @ SHA + auto-apply patches
node frontend/vendor/local-patches.mjs           # (re-)apply patches only
node frontend/vendor/local-patches.mjs --check   # verify only, no writes
```

The patch script is idempotent, line-ending agnostic, and fails loudly when
its find/replace strings no longer match — treat that as upstream drift and
re-estimate the patches manually. Never edit these files by hand without
mirroring the change into `local-patches.mjs`.

## Patch inventory

1. **DTS support** (5 hunks: `codec.js` ×3, `matroska/ebml.js`,
   `matroska/matroska-demuxer.js`) — upstream (including kzahel@integration)
   does not recognize `A_DTS`, so MKVs with DTS audio demux as video-only and
   playsvideo gets no audio to transcode. Adds DTS to the known-audio-codec
   list, maps Matroska `A_DTS` → codec `dts`, and maps codec string `dts` →
   `dtsc` for MSE/WebCodecs (matching playsvideo's `AUDIO_CODEC_MAP.dts`).
   SimpleBlocks are passed through as complete DTS frames; decoding happens
   in playsvideo via ffmpeg.wasm.
2. **FLAC MP4 sample depth** (`isobmff/isobmff-boxes.js`) — reads the FLAC
   STREAMINFO `bitsPerSample` field when creating an MP4 `AudioSampleEntry`.
   The old hardcoded 16-bit value produced an MP4 whose FLAC
   AudioSampleEntry disagreed with its `FLACSpecificBox` for 24-bit tracks.
   Chromium then rejected the initialization segment with:
   `FLAC AudioSampleEntry sample size mismatches FLACSpecificBox STREAMINFO sample size`.
   The field begins after 167 bits in the WebCodecs FLAC decoder description,
   is five bits wide, and is stored as `bitsPerSample - 1`.

## Regression

`node --test frontend/scripts/test-flac-mp4.mjs` from the repository root
checks 16/24-bit FLAC after remuxing through this exact vendor copy. Set
`ZVIEWER_TEST_BROWSER=1` to additionally verify real Chromium MSE playback.
See `frontend/scripts/fixtures/flac/README.md` for setup.
