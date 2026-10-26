// Private loopback service supervised by the Go backend. No account data is bundled.
const fs = require('node:fs');
const path = require('node:path');
const tmp = require('node:os').tmpdir();
const parent = Number(process.env.NCM_PARENT_PID);
if (parent > 0) setInterval(() => {
  try { process.kill(parent, 0); } catch { process.exit(0); }
}, 1000).unref();
fs.mkdirSync(tmp, { recursive: true });
const token = path.join(tmp, 'anonymous_token');
if (!fs.existsSync(token)) fs.writeFileSync(token, '');
const api = '@neteasecloudmusicapienhanced/api';
// Listen before anonymous-token refresh: a slow upstream must not block QR startup.
require(`${api}/server`).serveNcmApi({
  host: '127.0.0.1', port: Number(process.env.NCM_PORT), checkVersion: false,
}).then(() => {
  console.log('[ncm] ready');
  return require(`${api}/generateConfig`)();
}).catch(() => { console.error('[ncm] startup failed'); process.exitCode = 1; });
