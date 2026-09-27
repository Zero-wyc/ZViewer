import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Input,
  Mp4OutputFormat,
  Output,
} from '../vendor/mediabunny/dist/modules/src/index.js'

const fixtureRoot = new URL('./fixtures/flac/', import.meta.url)

async function remux(fileName) {
  const input = new Input({
    source: new BufferSource(await fs.readFile(new URL(fileName, fixtureRoot))),
    formats: ALL_FORMATS,
  })
  try {
    const track = await input.getPrimaryAudioTrack()
    const decoderConfig = await track.getDecoderConfig()
    const target = new BufferTarget()
    const output = new Output({
      target,
      format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
    })
    const source = new EncodedAudioPacketSource('flac')
    output.addAudioTrack(source)
    await output.start()
    for await (const packet of new EncodedPacketSink(track).packets()) {
      await source.add(packet, { decoderConfig })
    }
    await output.finalize()
    return target.buffer
  } finally {
    input.dispose()
  }
}

function findBox(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 0; offset < bytes.length;) {
    assert.ok(offset + 8 <= bytes.length, 'Truncated MP4 box header')
    const size = view.getUint32(offset)
    assert.ok(size >= 8 && offset + size <= bytes.length, 'Invalid MP4 box size')
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === type) {
      return bytes.subarray(offset, offset + size)
    }
    offset += size
  }
  throw new Error(`MP4 ${type} box not found`)
}

for (const [fileName, expectedBits] of [['flac-16.flac', 16], ['flac-24.flac', 24]]) {
  test(`${fileName}: MP4 sample depth agrees with STREAMINFO`, async () => {
    let contents = new Uint8Array(await remux(fileName))
    for (const type of ['moov', 'trak', 'mdia', 'minf', 'stbl']) {
      contents = findBox(contents, type).subarray(8)
    }
    // Skip the stsd header, version/flags and entry count.
    const entry = findBox(findBox(contents, 'stsd').subarray(16), 'fLaC')
    const view = new DataView(entry.buffer, entry.byteOffset, entry.byteLength)
    assert.equal(view.getUint16(16), 0, 'MP4 audio sample entry version')
    const actualBits = view.getUint16(26)
    // Skip the audio sample entry header (36), dfLa header (8),
    // version/flags (4) and FLAC metadata block header (4).
    const streamInfo = findBox(entry.subarray(36), 'dfLa').subarray(16)
    const streamInfoBits = (((streamInfo[12] & 1) << 4) | (streamInfo[13] >> 4)) + 1
    assert.equal(streamInfoBits, expectedBits)
    assert.equal(actualBits, streamInfoBits)
  })

  test(`${fileName}: Chromium MSE plays remuxed audio`, {
    skip: process.env.ZVIEWER_TEST_BROWSER !== '1',
  }, async () => {
    const { chromium } = await import('@playwright/test')
    const browser = await chromium.launch({
      channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
      args: ['--autoplay-policy=no-user-gesture-required'],
    })
    try {
      const page = await browser.newPage()
      const bytes = [...new Uint8Array(await remux(fileName))]
      const result = await page.evaluate(async bytes => {
        const mime = 'audio/mp4; codecs="flac"'
        if (!MediaSource.isTypeSupported(mime)) return 'FLAC MSE unsupported'
        return new Promise(resolve => {
          const audio = document.createElement('audio')
          const mediaSource = new MediaSource()
          const url = URL.createObjectURL(mediaSource)
          let finished = false
          const finish = error => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            audio.pause()
            audio.removeAttribute('src')
            audio.load()
            URL.revokeObjectURL(url)
            resolve(error)
          }
          const timer = setTimeout(() => finish(audio.error?.message ?? 'Playback timed out'), 8000)
          audio.addEventListener('error', () => finish(audio.error?.message ?? 'Media error'))
          audio.addEventListener('timeupdate', () => {
            if (audio.currentTime > 0.1) finish(null)
          })
          mediaSource.addEventListener('sourceopen', () => {
            try {
              const buffer = mediaSource.addSourceBuffer(mime)
              buffer.addEventListener('updateend', () => {
                if (!finished && mediaSource.readyState === 'open') mediaSource.endOfStream()
              }, { once: true })
              buffer.appendBuffer(new Uint8Array(bytes))
              void audio.play().catch(error => finish(String(error)))
            } catch (error) {
              finish(String(error))
            }
          }, { once: true })
          audio.src = url
        })
      }, bytes)
      assert.equal(result, null)
    } finally {
      await browser.close()
    }
  })
}
