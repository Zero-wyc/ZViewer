#!/usr/bin/env bash
# 影片 REST：Node 与 Go 逐字段对拍。
#
# Node 侧不走完整后端（启动会拉内嵌 LiveKit，实测 2 分钟以上），而是直接用
# `parity-node-movies.js` require data-source + movieService —— 那正是生产代码，
# DTO 序列化、ValueTransformer 加解密、datetime 水合一个都不少。
#
# 为什么两份库：Node 的 sql.js 把整库读进内存、变更时全量写回，两个进程
# 同时对同一文件写会互相覆盖。所以**串行**跑，需要交叉验证时手工拷库。
#
# 种子影片的 createdAt 是**硬编码固定值**——这一步专门锁死时区语义：
# TypeORM 写入用 UTC 分解、读回按本地时区解释，Go 必须复刻这个偏移，
# 否则同一批数据在两端差 8 小时。
set -u
REPO=/f/Code/ZViewer/ZViewer
WORK="$REPO/.tmp-movie-parity"
BIN=/tmp/zviewerd.exe
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-proc.sh"

GO_PORT=$(pick_port)
ROOM=ParityMovie1

rm -rf "$WORK"; mkdir -p "$WORK/node/config" "$WORK/go/config" "$WORK/out"
WINWORK=$(cd "$WORK" && pwd -W 2>/dev/null || echo "$WORK")

HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('parity-pass-1234',10))")
# 挂载密码必须是 Node 的 AES 密文（Go 解不出来会静默降级为「无密码」）。
MOUNT_PW=$(cd "$REPO" && node -e "
const crypto=require('crypto');
const k=process.env.MOVIE_SECRET_KEY||'zcontrol-movie-secret-key-32b';
const key=Buffer.from(k.padEnd(32,'0').slice(0,32));
const iv=Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90','hex');
const c=crypto.createCipheriv('aes-256-cbc', key, iv);
const out=Buffer.concat([c.update('nas-secret','utf8'), c.final()]);
process.stdout.write(iv.toString('hex')+':'+out.toString('hex'));
")

seed() {
  local db=$1
  cp "$REPO/config/dev.sqlite" "$db"
  MOUNT_PW="$MOUNT_PW" HASH="$HASH" C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe - "$db" <<'PY'
import os, sqlite3, sys
db = sys.argv[1]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username" = ?', ('parity-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('parity-user', os.environ['HASH'], 'root', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('parity-user',)).fetchone()[0]

room = 'ParityMovie1'
c.execute('DELETE FROM "movie" WHERE "roomId"=?', (room,))
c.execute('DELETE FROM "room" WHERE "roomId"=?', (room,))
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","ownerUserId")
             VALUES (?,?,?,?,?)''', (room, '对拍房', 'active', 'watch-together', uid))

c.execute('DELETE FROM "user_mount" WHERE "name"=?', ('parity-mount',))
c.execute('''INSERT INTO "user_mount" ("userId","type","name","serverUrl","username","password")
             VALUES (?,?,?,?,?,?)''',
          (uid, 'openlist', 'parity-mount', 'http://192.168.5.5:5244/dav',
           'parity-nas', os.environ['MOUNT_PW']))
mount_id = c.execute('SELECT "id" FROM "user_mount" WHERE "name"=?', ('parity-mount',)).fetchone()[0]

# 固定时间戳：两端读出的 ISO 必须完全相同。
FIXED = '2026-10-21 14:15:50.000'
seeds = [
    dict(url='https://www.bilibili.com/video/BV1GJ411x7h7', title='种子-B站多P',
         cover='https://i0.hdslb.com/bfs/archive/a.jpg', source='bilibili',
         audioUrl='https://cdn.example.com/a.m4s', format='dash',
         videoCodec='avc1.640032', audioCodec='mp4a.40.2', duration=176.5,
         cid=170001, currentQn=80,
         acceptQuality='[{"id":80,"label":"1080P","resolution":"1920x1080"},{"id":64,"label":"720P"}]',
         pages='[{"page":1,"cid":170001,"part":"P1","duration":176},{"page":2,"cid":170002,"part":"P2","duration":180}]',
         currentPage=2, serverUrl=None, path=None, username=None, password=None,
         directLink=0, serverProxy=1, playsvideoEnabled=1, cliOnly=1, multiVersion=0,
         sourceMeta='{"sourceId":"s1","episode":{"id":"e1","title":"第一集","episodeNumber":1,"playbackParams":{}},"originalTitle":"原题"}',
         order=0),
    dict(url='/api/openlist/stream?movieId=1', title='种子-OpenList',
         cover=None, source='openlist', audioUrl=None, format='mkv',
         videoCodec=None, audioCodec=None, duration=None, cid=None, currentQn=None,
         acceptQuality=None, pages=None, currentPage=None,
         serverUrl='http://192.168.5.5:5244/dav', path='/movie/b.mkv',
         username='parity-nas', password=os.environ['MOUNT_PW'],
         directLink=0, serverProxy=0, playsvideoEnabled=1, cliOnly=0, multiVersion=1,
         sourceMeta=None, order=1),
]
cols = ['url','title','cover','source','audioUrl','format','videoCodec','audioCodec',
        'duration','cid','currentQn','acceptQuality','pages','currentPage','serverUrl',
        'path','username','password','directLink','serverProxy','playsvideoEnabled',
        'cliOnly','multiVersion','sourceMeta','order']
for s in seeds:
    vals = [room] + [s[k] for k in cols] + [FIXED, FIXED]
    c.execute('INSERT INTO "movie" ("roomId",%s,"createdAt","updatedAt") VALUES (%s)' % (
        ','.join('"%s"' % x for x in cols), ','.join('?' * (len(cols) + 3))), vals)
c.execute('UPDATE "movie" SET "sourceMountId"=? WHERE "roomId"=? AND "source"=?',
          (mount_id, room, 'openlist'))
c.commit()
PY
}

node_movies() {
  local cfg=$1; shift
  # 不加 2>&1：脚本会把 movie.service 的调试日志打到 stderr，
  # 合并进来会污染 stdout 的 JSON。
  (cd "$REPO/backend" && CONFIG_DIR="$cfg" node "$HERE/parity-node-movies.js" "$@")
}

start_go() {
  local cfg=$1 log=$2
  CONFIG_DIR="$cfg" PORT="$GO_PORT" PROJECT_ROOT="$REPO" "$BIN" > "$log" 2>&1 &
  echo $!
}

login() {
  curl -s -X POST "http://127.0.0.1:$GO_PORT/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"username":"parity-user","password":"parity-pass-1234"}' \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).accessToken||'')}catch(e){}})"
}

# go_read <configDir> <outFile>：起 Go、读列表、停。
go_read() {
  local cfg=$1 out=$2 pid tok
  pid=$(start_go "$cfg" "$WORK/go/server.log")
  if ! wait_ready "$GO_PORT" Go "$WORK/go/server.log" "\[start\] 监听"; then
    kill_tree "$pid"; return 1
  fi
  tok=$(login)
  curl -s -H "Authorization: Bearer $tok" \
    "http://127.0.0.1:$GO_PORT/api/rooms/$ROOM/movies" > "$out"
  kill_tree "$pid"; sleep 0.5
}

echo "=== 准备两份种子库 ==="
seed "$WORK/node/config/dev.sqlite"
seed "$WORK/go/config/dev.sqlite"

echo
echo "=== 1. 同一批种子：Node 与 Go 各读一次 ==="
node_movies "$WINWORK/node/config" list "$ROOM" > "$WORK/out/node-seed.json" 2>"$WORK/out/node-seed.err" || {
  echo "!! Node 读取失败"; head -20 "$WORK/out/node-seed.err"; exit 1; }
go_read "$WINWORK/go/config" "$WORK/out/go-seed.json" || exit 1
node "$HERE/parity-compare-movies.js" "$WORK/out/node-seed.json" "$WORK/out/go-seed.json"
SEED_DIFF=$?
echo "  种子时间戳: Node=$(node -e "const m=(require(process.argv[1]).movies||[])[0]||{};console.log(m.createdAt)" "$WINWORK/out/node-seed.json")"
echo "              Go  =$(node -e "const m=(require(process.argv[1]).movies||[])[0]||{};console.log(m.createdAt)" "$WINWORK/out/go-seed.json")"

echo
echo "=== 2. Node 写入一条，Go 在 Node 写过的库上读（跨实现读） ==="
node_movies "$WINWORK/node/config" create "$ROOM" \
  '{"url":"https://www.bilibili.com/video/BV1uv411q7Mv","title":"Node写入-给Go读","source":"bilibili","cid":123456,"currentQn":64,"duration":90,"acceptQuality":[{"id":64,"label":"720P"}],"pages":[{"page":1,"cid":123456,"part":"P1","duration":90}],"password":"written-by-node"}' \
  > "$WORK/out/node-created.json" 2>"$WORK/out/node-created.err"
# 取写入后的**完整列表**再比：单条响应与整表比对会把种子条目误报成「只在一侧」。
node_movies "$WINWORK/node/config" list "$ROOM"   > "$WORK/out/node-after-create.json" 2>"$WORK/out/node-after-create.err"
cp "$WORK/node/config/dev.sqlite" "$WORK/go/config/dev.sqlite"
go_read "$WINWORK/go/config" "$WORK/out/go-after-node.json" || exit 1
node "$HERE/parity-compare-movies.js" "$WORK/out/node-after-create.json" "$WORK/out/go-after-node.json"
CROSS_DIFF=$?

echo
echo "=== 3. Go 写入一条，Node 读 Go 写过的库（反向） ==="
GPID=$(start_go "$WINWORK/node/config" "$WORK/go/server.log")
wait_ready "$GO_PORT" Go "$WORK/go/server.log" "\[start\] 监听" || exit 1
GTOKEN=$(login)
curl -s -X POST "http://127.0.0.1:$GO_PORT/api/rooms/$ROOM/movies" \
  -H "Authorization: Bearer $GTOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://www.bilibili.com/video/BV1i4411L7qG","title":"Go写入-给Node读","source":"bilibili","cid":999,"password":"go-wrote-this"}' \
  > "$WORK/out/go-created.json"
kill_tree "$GPID"; sleep 0.5

NODE_READ=$(node_movies "$WINWORK/node/config" list "$ROOM" 2>"$WORK/out/node-after-go.err")
echo "$NODE_READ" > "$WORK/out/node-after-go.json"
echo "$NODE_READ" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  let list=[];
  try{list=JSON.parse(s).movies||[]}catch(e){console.log('  ✗ Node 读取失败: '+s.slice(0,200));process.exit(1)}
  const m=list.find(x=>x.title==='Go写入-给Node读');
  if(!m){console.log('  ✗ Node 读不到 Go 写入的影片');process.exit(1)}
  console.log('  ✓ Node 读到 Go 写入的影片: id='+m.id+' cid='+m.cid+' url='+m.url);
  console.log('    凭证外泄检查 username='+JSON.stringify(m.username)+' password='+JSON.stringify(m.password));
  console.log('    createdAt='+m.createdAt);
});"
REVERSE_OK=$?

echo
echo "=== 4. 库里 Go 写入的密码，Node 必须能解出明文 ==="
STORED=$(C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe - "$WINWORK/node/config/dev.sqlite" <<'PY'
import sqlite3
c = sqlite3.connect(r'F:/Code/ZViewer/ZViewer/.tmp-movie-parity/node/config/dev.sqlite')
row = c.execute('SELECT "password" FROM "movie" WHERE "title"=?', ('Go写入-给Node读',)).fetchone()
print(row[0] if row and row[0] else '')
PY
)
STORED="$STORED" node -e "
const crypto=require('crypto');
const k=process.env.MOVIE_SECRET_KEY||'zcontrol-movie-secret-key-32b';
const key=Buffer.from(k.padEnd(32,'0').slice(0,32));
const [ivHex,dataHex]=process.env.STORED.split(':');
const d=crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex||'','hex'));
const out=Buffer.concat([d.update(Buffer.from(dataHex||'','hex')), d.final()]).toString('utf8');
console.log('  Node 解密='+JSON.stringify(out)+(out==='go-wrote-this'?' ✓':' ✗'));
process.exit(out==='go-wrote-this'?0:1);
"
PW_OK=$?

echo
echo "================ 汇总 ================"
echo "  种子逐字段差异=$SEED_DIFF  跨实现读取差异=$CROSS_DIFF  反向读取=$REVERSE_OK  密码链路=$PW_OK"
if [ "$SEED_DIFF" = "0" ] && [ "$CROSS_DIFF" = "0" ] && [ "$REVERSE_OK" = "0" ] && [ "$PW_OK" = "0" ]; then
  echo "  全部一致 ✓"; exit 0
fi
echo "  存在差异 ✗"; exit 1
