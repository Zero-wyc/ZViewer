#!/usr/bin/env node
/**
 * 房间 REST 端点的「Node 侧最小应用」（阶段 5 对拍用）。
 *
 * 为什么不是一个完整的 Node 后端：`npm start` 会去拉内嵌 LiveKit，
 * 实测启动 >2 分钟（与影片对拍同一坑）。这里只挂 routes/rooms 一个
 * Router，跑的是**生产代码**，启动是秒级的。
 *
 * 用法：node parity-node-rooms.js <db路径> <端口>
 *
 * 唯一非生产的部分是 `/__parity/login`：跳过口令校验直接签发令牌。
 * 它只服务于对拍（鉴权链路已在阶段 1 单独对拍过），不参与任何断言，
 * 目的只是让 Node 与 Go 两侧用**同一套 HTTP 请求**跑同一条序列。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const dbPath = process.argv[2];
const port = Number(process.argv[3]);

if (!dbPath || !port) {
  process.stderr.write('用法: parity-node-rooms.js <db路径> <端口>\n');
  process.exit(2);
}

process.env.DATABASE_URL = path.resolve(dbPath);
process.env.NODE_ENV = 'test';

/** 记录 Router 发出的房间事件，便于人工核对广播载荷。 */
const emitted = [];
const fakeIo = {
  to: (roomId) => ({
    emit: (event, payload) => {
      emitted.push({ roomId, event, payload });
    },
  }),
};

// movie.service / 其他模块在 createMovie 时会打印请求体，对拍输出必须干净。
console.log = () => {};
console.info = () => {};

(async () => {
  // 延迟到设置完 env 之后再 require：data-source 在模块加载期就读取 DATABASE_URL
  const express = require('express');
  const { AppDataSource } = require(path.resolve(ROOT, 'backend/dist/data-source'));
  const { createRoomsRouter } = require(path.resolve(ROOT, 'backend/dist/routes/rooms'));
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

  app.get('/__parity/events', (_req, res) => {
    res.json({ success: true, events: emitted.map((e) => ({ roomId: e.roomId, event: e.event })) });
  });

  app.use('/api/rooms', createRoomsRouter(fakeIo));
  app.use((err, _req, res, _next) => {
    res.status(500).json({ success: false, message: 'unhandled', error: String(err) });
  });

  app.listen(port, '127.0.0.1', () => {
    process.stderr.write('[parity-node-rooms] listening on ' + port + '\n');
  });
})().catch((e) => {
  process.stderr.write('[parity-node-rooms] 启动失败: ' + e.stack + '\n');
  process.exit(1);
});
