// 临时诊断脚本：查询房间影片列表（验证后删除）
const Database = require('better-sqlite3')
const db = new Database('f:/Code/ZViewer/ZViewer/config/dev.sqlite', {
  readonly: true,
})
const movies = db
  .prepare(
    "SELECT id, roomId, title, source, format, audioCodec, videoCodec FROM Movie WHERE roomId IN ('ZBi3wgdp','RVTKqypo','YswqeGFz')"
  )
  .all()
console.log(JSON.stringify(movies, null, 1))
