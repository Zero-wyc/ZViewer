#!/usr/bin/env node
/**
 * 直接用 Node 侧的 TypeORM 层读写影片表（不启动 HTTP 服务）。
 *
 * 为什么不用完整后端：Node 版启动会拉起内嵌 LiveKit（实测 2 分钟以上），
 * 对拍只需要「Node 真实实现写出来的数据长什么样」，跟路由/信令无关。
 * 直接 require data-source + movieService 就是最贴近真实的一条路径——
 * DTO 序列化、ValueTransformer 加解密、datetime 水合全都是生产代码。
 *
 * 用法（CONFIG_DIR 指向库副本）：
 *   node parity-node-movies.js list   <roomId>
 *   node parity-node-movies.js create <roomId> '<json>'
 *   node parity-node-movies.js update <roomId> <movieId> '<json>'
 */
const path = require('path');

// movie.service 里带着 console.log 调试输出（创建时打印 pages 类型），
// 它会混进 stdout 把 JSON 打坏。把它挪到 stderr——stdout 只留结果。
console.log = (...args) => console.error(...args);

const BACKEND = path.resolve(__dirname, '../../backend');
const [, , action, roomId, a4, a5] = process.argv;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const { AppDataSource } = require(path.join(BACKEND, 'dist/data-source'));
  const { movieService } = require(path.join(BACKEND, 'dist/modules/movie/movie.service'));

  if (!AppDataSource.isInitialized) {
    await AppDataSource.initialize();
  }

  let out;
  switch (action) {
    case 'list': {
      if (!roomId) fail('缺少 roomId');
      out = { movies: await movieService.listMovies(roomId) };
      break;
    }
    case 'create': {
      if (!roomId || !a4) fail('缺少 roomId 或 请求体');
      const created = await movieService.createMovie(roomId, JSON.parse(a4), 0);
      out = { movie: created };
      break;
    }
    case 'update': {
      if (!roomId || !a4 || !a5) fail('缺少 roomId / movieId / 请求体');
      const updated = await movieService.updateMovie(roomId, Number(a4), JSON.parse(a5), 0);
      out = { movie: updated };
      break;
    }
    default:
      fail(`未知动作: ${action}`);
  }

  // autoSave 会把变更写回库文件；显式关闭连接确保写完再退出。
  await AppDataSource.destroy();
  process.stdout.write(JSON.stringify(out));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
