// Local measurement only: node scripts/manual-real-file-range.cjs <absolute media path>
const fs = require('node:fs');
const http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { pipeRangeStream } = require('../dist/services/proxy/range-stream');

const file = process.argv[2];
if (!file) throw new Error('Pass an absolute media path');
const size = fs.statSync(file).size;
const cap = 8 * 1024 * 1024;
const app = express();
let sourceClose;
let sourceStream;
app.get('/:mode', (req, res) => {
  const end = req.params.mode === 'capped' ? cap - 1 : size - 1;
  sourceStream = fs.createReadStream(file, { start: 0, end, highWaterMark: 1024 * 1024 });
  sourceClose = once(sourceStream, 'close');
  pipeRangeStream(res, {
    stream: sourceStream, contentType: 'video/x-matroska',
    fileSize: size, start: 0, end, ranged: true,
    logTag: 'local-measurement', errorMessage: 'read failed',
    maxBytesPerSecond: req.params.mode === 'paced' ? 8 * 1024 * 1024 : undefined,
    initialBurstBytes: req.params.mode === 'paced' ? 16 * 1024 * 1024 : undefined,
  });
});

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    for (const mode of ['capped', 'open', 'paced']) {
      const started = performance.now();
      let received = 0;
      let stoppedByTest = false;
      let timer;
      const cutoff = (mode === 'paced' ? 48 : 128) * 1024 * 1024;
      await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/${mode}`, { headers: { Range: 'bytes=0-' } }, res => {
          timer = setTimeout(() => { stoppedByTest = true; res.destroy(); resolve(); }, 10000);
          res.on('data', chunk => {
            received += chunk.length;
            if (received >= cutoff) { stoppedByTest = true; res.destroy(); resolve(); }
          });
          res.on('end', resolve);
          res.on('error', reject);
        });
        req.on('error', reject);
      });
      clearTimeout(timer);
      await sourceClose;
      const elapsed = performance.now() - started;
      console.log(JSON.stringify({ mode, fileBytes: size, receivedBytes: received,
        sourceBytesRead: sourceStream.bytesRead,
        elapsedMs: Math.round(elapsed), stoppedByTest, sourceDestroyed: sourceStream.destroyed }));
    }
  } finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
