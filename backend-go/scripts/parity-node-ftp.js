#!/usr/bin/env node
/**
 * FTP 端点的「Node 侧最小应用」（阶段 5 对拍用）。
 *
 * 只挂两个 Router：routes/ftp（挂载与流代理）与 routes/stream/ftp
 * （临时连接的票据链路）。完整后端启动会拉内嵌 LiveKit（>2 分钟），
 * 对拍等不起；这里跑的是生产代码，启动 2 秒内。
 *
 * /__parity/login 与其余的 parity-node-* 同款：跳过口令校验直接签发令牌，
 * 鉴权链路已在阶段 1 单独对拍过。
 *
 * 用法：node parity-node-ftp.js <db路径> <端口>
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const dbPath = process.argv[2];
const port = Number(process.argv[3]);

if (!dbPath || !port) {
  process.stderr.write('用法: parity-node-ftp.js <db路径> <端口>\n');
  process.exit(2);
}

process.env.DATABASE_URL = path.resolve(dbPath);
process.env.NODE_ENV = 'test';

console.log = () => {};
console.info = () => {};

(async () => {
  const express = require('express');
  const { AppDataSource } = require(path.resolve(ROOT, 'backend/dist/data-source'));
  const ftpRouter = require(path.resolve(ROOT, 'backend/dist/routes/ftp')).default;
  const streamFtpRouter = require(path.resolve(ROOT, 'backend/dist/routes/stream/ftp')).default;
  const { generateTokens, authenticateToken } = require(path.resolve(ROOT, 'backend/dist/middleware/auth'));

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

  app.use('/api/ftp', ftpRouter);
  // 生产里 authenticateToken 由 routes/stream/index.ts 统一加在父路由上，
  // 这里只挂子路由，必须自己补一层，否则 req.user 是 undefined。
  app.use('/api/stream', authenticateToken, streamFtpRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ success: false, message: 'unhandled', error: String(err) });
  });

  app.listen(port, '127.0.0.1', () => {
    process.stderr.write('[parity-node-ftp] listening on ' + port + '\n');
  });
})().catch((e) => {
  process.stderr.write('[parity-node-ftp] 启动失败: ' + e.stack + '\n');
  process.exit(1);
});
