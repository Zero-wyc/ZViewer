# Local Patches

## FLAC MP4 sample depth

`dist/modules/src/isobmff/isobmff-boxes.js` reads the FLAC STREAMINFO
`bitsPerSample` field when creating an MP4 `AudioSampleEntry`. The previous
hardcoded 16-bit value produced an MP4 whose FLAC AudioSampleEntry disagreed
with its `FLACSpecificBox` for 24-bit tracks. Chromium then rejected the
initialization segment with:

`FLAC AudioSampleEntry sample size mismatches FLACSpecificBox STREAMINFO sample size`

Keep this patch when refreshing the vendored Mediabunny fork. The field begins
after 167 bits in the WebCodecs FLAC decoder description and is five bits wide,
stored as `bitsPerSample - 1`.

Regression: `node --test frontend/scripts/test-flac-mp4.mjs` from the repository
root checks 16/24-bit FLAC after remuxing through this exact vendor copy.
Set `ZVIEWER_TEST_BROWSER=1` to additionally verify real Chromium MSE playback.
See `frontend/scripts/fixtures/flac/README.md` for setup.

The pre-existing DTS patches in `codec.js`, `matroska/ebml.js` and
`matroska/matroska-demuxer.js` must also be retained when refreshing the fork.
