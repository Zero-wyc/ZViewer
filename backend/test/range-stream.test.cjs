// Run from backend: node --test test/range-stream.test.cjs
require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { once } = require('node:events');
const http = require('node:http');
const express = require('express');
const { parseRangeHeader, pipeRangeStream, sendRangeNotSatisfiable } = require('../src/services/proxy/range-stream');
const { proxyHttpUpstream } = require('../src/services/proxy/http-proxy');

const size = 9 * 1024 * 1024 + 37;
for (const [header, length, expected, maxChunk] of [
  [undefined, size, null],
  ['bytes=0-', size, { start: 0, end: 8 * 1024 * 1024 - 1 }],
  [`bytes=0-${size - 1}`, size, { start: 0, end: 8 * 1024 * 1024 - 1 }],
  ['bytes=100-', size, { start: 100, end: 100 + 8 * 1024 * 1024 - 1 }],
  ['bytes=0-31', size, { start: 0, end: 31 }],
  ['bytes=-32', size, { start: size - 32, end: size - 1 }],
  ['bytes=-99999999999999999999999', size, { start: size - 8 * 1024 * 1024, end: size - 1 }],
  ['bytes=10-99999999999999999999999', size, { start: 10, end: 10 + 8 * 1024 * 1024 - 1 }],
  ['bytes=0-', size, { start: 0, end: size - 1 }, null],
  [`bytes=0-${size - 1}`, size, { start: 0, end: size - 1 }, null],
  ['bytes=-99999999999999999999999', size, { start: 0, end: size - 1 }, null],
  ['BYTES=0-0', size, { start: 0, end: 0 }],
  ['bytes=-0', size, 'invalid'],
  [`bytes=${size}-`, size, 'invalid'],
  ['bytes=99999999999999999999999-', size, 'invalid'],
  ['bytes=30-20', size, 'invalid'],
  ['bytes=0-1,3-4', size, 'invalid'],
  ['bytes=-', size, 'invalid'],
  ['bytes=0-', 0, 'invalid'],
  ['bytes=0-', NaN, 'invalid'],
]) {
  test(`parse ${header} size=${length} mode=${maxChunk === null ? 'full' : 'capped'}`, () => {
    assert.deepEqual(parseRangeHeader(header, length, maxChunk), expected);
  });
}

async function listen(t, app) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('HTTP direct and upstream proxy preserve ranges, headers and bytes', async t => {
  const data = Buffer.allocUnsafe(size);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const receivedRanges = [];
  const origin = express();
  origin.use((req, res) => {
    receivedRanges.push(req.headers.range);
    // The origin honors the exact range. Only the HTTP proxy applies its default cap.
    const range = parseRangeHeader(req.headers.range, size, null);
    if (range === 'invalid') return sendRangeNotSatisfiable(res, size);
    pipeRangeStream(res, {
      stream: Readable.from([range ? data.subarray(range.start, range.end + 1) : data]),
      contentType: 'video/mp4', fileSize: size, ranged: !!range,
      ...range, logTag: 'range-test', errorMessage: 'test stream failed',
    });
  });
  const originUrl = await listen(t, origin);
  const proxy = express();
  proxy.use((req, res) => proxyHttpUpstream(req, res, {
    url: originUrl, logTag: 'range-test', errorMessage: 'test proxy failed',
  }));
  const proxyUrl = await listen(t, proxy);
  for (const url of [originUrl, proxyUrl]) {
    for (const header of ['bytes=0-', `bytes=0-${size - 1}`, 'bytes=100-', 'bytes=-32', 'bytes=0-31']) {
      const range = parseRangeHeader(header, size, url === originUrl ? null : undefined);
      const response = await fetch(url, { headers: { Range: header } });
      const upstreamHeader = url === proxyUrl && range.end < size - 1 &&
        (header === 'bytes=0-' || header === `bytes=0-${size - 1}` || header === 'bytes=100-')
        ? `bytes=${range.start}-${range.end}` : header;
      assert.equal(receivedRanges.at(-1), upstreamHeader);
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes ${range.start}-${range.end}/${size}`);
      assert.equal(response.headers.get('content-length'), String(range.end - range.start + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(range.start, range.end + 1));
    }
    const head = await fetch(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(size));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const invalid = await fetch(url, { headers: { Range: `bytes=${size}-` } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('content-range'), `bytes */${size}`);
    const invalidBody = await invalid.arrayBuffer();
    if (url === proxyUrl) {
      assert.equal(invalid.headers.get('content-length'), '0');
      assert.equal(invalidBody.byteLength, 0);
    }
  }
});

test('full-range response can be paced without changing its headers or payload', { timeout: 10000 }, async t => {
  const oneMiB = Buffer.alloc(1024 * 1024, 0x5a);
  const app = express();
  app.get('/', (req, res) => {
    pipeRangeStream(res, {
      stream: Readable.from([oneMiB, oneMiB, oneMiB]),
      contentType: 'video/mp4', fileSize: 3 * oneMiB.length,
      start: 0, end: 3 * oneMiB.length - 1, ranged: true,
      maxBytesPerSecond: oneMiB.length, initialBurstBytes: oneMiB.length,
      logTag: 'paced-test', errorMessage: 'paced stream failed',
    });
  });
  const url = await listen(t, app);
  const started = performance.now();
  const response = await fetch(url, { headers: { Range: 'bytes=0-' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 0-${3 * oneMiB.length - 1}/${3 * oneMiB.length}`);
  assert.equal(response.headers.get('content-length'), String(3 * oneMiB.length));
  const body = Buffer.from(await response.arrayBuffer());
  assert.equal(body.length, 3 * oneMiB.length);
  assert.deepEqual(body.subarray(0, oneMiB.length), oneMiB);
  assert.ok(performance.now() - started >= 1700, 'three MiB must take roughly two seconds at one MiB/s after the initial burst');
});

test('disconnect destroys the source for direct and upstream proxy streams', { timeout: 10000 }, async t => {
  let sourceClosed;
  const origin = express();
  origin.use((req, res) => {
    const stream = new Readable({
      read() {
        this.timer = setTimeout(() => { if (!this.destroyed) this.push(Buffer.alloc(16384)); }, 5);
      },
      destroy(error, callback) { clearTimeout(this.timer); callback(error); },
    });
    sourceClosed = once(stream, 'close');
    pipeRangeStream(res, {
      stream, contentType: 'video/mp4', fileSize: 1024 ** 3,
      start: 0, end: 1024 ** 3 - 1, ranged: true,
      logTag: 'cancel-test', errorMessage: 'test stream failed',
    });
  });
  const originUrl = await listen(t, origin);
  const proxy = express();
  proxy.use((req, res) => proxyHttpUpstream(req, res, {
    url: originUrl, logTag: 'cancel-test', errorMessage: 'test proxy failed',
  }));
  const proxyUrl = await listen(t, proxy);
  for (const url of [originUrl, proxyUrl]) {
    await new Promise((resolve, reject) => {
      const req = http.get(url, { headers: { Range: 'bytes=0-' } }, res => {
        res.once('data', () => { res.destroy(); resolve(); });
        res.on('error', () => {});
      });
      req.on('error', reject);
    });
    await sourceClosed;
  }
});
