# FLAC regression fixtures

These original synthetic 440 Hz tones contain no third-party media. Generate with:

```sh
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.4 -c:a flac -sample_fmt s16 flac-16.flac
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.4 -c:a flac -sample_fmt s32 flac-24.flac
```

The FLAC encoder stores the s32 input at 24-bit precision.

From the repository root, run the dependency-free MP4 structure regression:

```sh
node --test frontend/scripts/test-flac-mp4.mjs
```

To also verify actual Chromium MSE playback, run `npm ci`, install Google Chrome,
then enable the browser checks (PowerShell):

```powershell
$env:ZVIEWER_TEST_BROWSER = '1'
node --test frontend/scripts/test-flac-mp4.mjs
```

On Linux/macOS: `ZVIEWER_TEST_BROWSER=1 node --test frontend/scripts/test-flac-mp4.mjs`.
Set `PLAYWRIGHT_CHANNEL=chromium` to use Playwright's installed Chromium instead.
No running ZViewer server or external media is required.
