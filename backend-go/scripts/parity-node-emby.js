#!/usr/bin/env node
/**
 * Emby / Jellyfin 端点的「Node 侧最小应用」（阶段 6 对拍用）。
 *
 * 与 webdav / ftp 的 stub 同构：只挂 emby 与 jellyfin 两个 Router，
 * 起 express 最小应用（完整后端会拉内嵌 LiveKit，两分钟起步）。
 *
 * 用法：node parity-node-emby.js <db路径> <端口>
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const dbPath = process.argv[2];
const port = Number(process.argv[3]);

if (!dbPath || !port) {
  process.stderr.write('用法: parity-node-emby.js <db路径> <端口>\n');
  process.exit(2);
}

process.env.DATABASE_URL = path.resolve(dbPath);
process.env.NODE_ENV = 'test';

console.log = () => {};
console.info = () => {};

(async () => {
  const express = require('express');
  const { AppDataSource } = require(path.resolve(ROOT, 'backend/dist/data-source'));
  const embyRouter = require(path.resolve(ROOT, 'backend/dist/routes/emby')).default;
  const jellyfinRouter = require(path.resolve(ROOT, 'backend/dist/routes/jellyfin')).default;
  const { generateTokens } = require(path.resolve(ROOT, 'backend/dist/middleware/auth'));

  await AppDataSource.initialize();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.post('/__parity/login', async (req, res) => {
    const { username } = req.body ?? {};
    const user = await AppDataSource.getRepository('User').findOneBy({ username });
    if (!user) {
      res.status(404).json({ success: false });
      return;
    }
    const { accessToken } = generateTokens(user.id, user.role, user.username);
    res.json({ success: true, accessToken });
  });

  app.use('/api/emby', embyRouter);
  app.use('/api/jellyfin', jellyfinRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ success: false, message: 'unhandled', error: String(err) });
  });

  app.listen(port, '127.0.0.1', () => {
    process.stderr.write('[parity-node-emby] listening on ' + port + '\n');
  });
})().catch((e) => {
  process.stderr.write('[parity-node-emby] 启动失败: ' + e.stack + '\n');
  process.exit(1);
});
