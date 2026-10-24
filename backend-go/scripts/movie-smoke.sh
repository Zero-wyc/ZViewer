#!/usr/bin/env bash
# 影片 REST 端点冒烟测试（阶段 4）。
#
# 特点：跑在**真实库副本**上（config/dev.sqlite → 临时目录），不碰生产数据；
# 覆盖 CRUD 全链路 + 权限边界 + 凭证加密的跨语言兼容。
#
# 用法：bash backend-go/scripts/movie-smoke.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TESTDIR=/tmp/zvmovie
BIN=/tmp/zviewerd.exe

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

PORT=$(pick_port)

rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp "$REPO/config/dev.sqlite" "$TESTDIR/dev.sqlite"

echo "=== 准备测试数据（临时库副本）==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('movie-pass-1234',10))")
# 挂载凭证在库里必须是 Node 的 AES 密文：明文写进去 Go 解不出来，
# 会静默降级成「无密码」，测试就白跑了。
MOUNT_PW=$(cd "$REPO" && node -e "
const crypto=require('crypto');
const k=process.env.MOVIE_SECRET_KEY||'zcontrol-movie-secret-key-32b';
const key=Buffer.from(k.padEnd(32,'0').slice(0,32));
const iv=crypto.randomBytes(16);
const c=crypto.createCipheriv('aes-256-cbc', key, iv);
const out=Buffer.concat([c.update('nas-secret','utf8'), c.final()]);
process.stdout.write(iv.toString('hex')+':'+out.toString('hex'));
")
PY_OUT=$(MOUNT_PW="$MOUNT_PW" C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe - "$TESTDIR/dev.sqlite" "$HASH" <<'PY'
import os, sqlite3, sys
db, h = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username" IN (?,?)', ('movie-owner', 'movie-other'))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('movie-owner', h, 'user', 'active'))
owner_id = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('movie-owner',)).fetchone()[0]
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('movie-other', h, 'user', 'active'))

room = 'MovieTest01'
c.execute('DELETE FROM "movie" WHERE "roomId"=?', (room,))
c.execute('DELETE FROM "room" WHERE "roomId"=?', (room,))
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","ownerUserId")
             VALUES (?,?,?,?,?)''', (room, '影片测试房', 'active', 'watch-together', owner_id))
# 挂载：openlist 内网地址，用于验证「内网强制服务器转发」与凭证补全
c.execute('DELETE FROM "user_mount" WHERE "name"=?', ('movie-test-mount',))
c.execute('''INSERT INTO "user_mount" ("userId","type","name","serverUrl","username","password")
             VALUES (?,?,?,?,?,?)''',
          (owner_id, 'openlist', 'movie-test-mount', 'http://192.168.1.99:5244/dav',
           'nas-user', os.environ['MOUNT_PW']))
c.commit()
print(room, owner_id)
PY
)
ROOM=$(echo "$PY_OUT" | awk '{print $1}')
OWNER_ID=$(echo "$PY_OUT" | awk '{print $2}')
echo "  房间=$ROOM 房主ID=$OWNER_ID"

CONFIG_DIR="$TESTDIR" PORT="$PORT" PROJECT_ROOT="$REPO" "$BIN" > "$TESTDIR/server.log" 2>&1 &
SRV=$!
trap 'kill_tree "$SRV"' EXIT

if ! wait_ready "$PORT" "Go 服务" "$TESTDIR/server.log" "监听"; then
  exit 1
fi
BASE="http://127.0.0.1:$PORT"

login() {
  curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"movie-pass-1234\"}" |
    node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{const o=JSON.parse(s);process.stdout.write(o.accessToken||'')}catch(e){}
    })"
}

TOKEN=$(login movie-owner)
OTHER=$(login movie-other)
if [ -z "$TOKEN" ]; then
  echo "!! 登录失败，日志尾部："; tail -10 "$TESTDIR/server.log"; exit 1
fi
echo "  已取得 owner / other 两个令牌"

echo
echo "=== 1. 未登录访问列表 -> 期望 401 ==="
curl -s -o /dev/null -w "  HTTP %{http_code}\n" "$BASE/api/rooms/$ROOM/movies"

echo
echo "=== 2. 非房主访问列表 -> 房间 active 但无会话，期望 403 ==="
curl -s -w "\n  HTTP %{http_code}\n" -H "Authorization: Bearer $OTHER" "$BASE/api/rooms/$ROOM/movies" | head -2

echo
echo "=== 3. 房主访问空列表 ==="
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rooms/$ROOM/movies" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const o=JSON.parse(s);console.log('  success='+o.success+' 数量='+(o.movies||[]).length);
  })"

echo
echo "=== 4. 新增影片（B站源，带 acceptQuality 数组 / pages / sourceMeta）==="
CREATE=$(curl -s -X POST "$BASE/api/rooms/$ROOM/movies" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "url":"https://www.bilibili.com/video/BV1GJ411x7h7",
    "title":"测试影片 - 第一集",
    "cover":"https://i0.hdslb.com/bfs/archive/test.jpg",
    "source":"bilibili",
    "cid":170001,
    "currentQn":80,
    "duration":176.5,
    "acceptQuality":[{"id":80,"label":"1080P","resolution":"1920x1080"},{"id":64,"label":"720P"}],
    "pages":[{"page":1,"cid":170001,"part":"P1","duration":176}],
    "currentPage":1,
    "sourceMeta":{"sourceId":"s1","episode":{"id":"e1","title":"第一集","episodeNumber":1,"playbackParams":{}},"originalTitle":"原始标题"},
    "password":"secret-from-body"
  }')
echo "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const o=JSON.parse(s);const m=o.movie||{};
  console.log('  success='+o.success+' id='+m.id+' order='+m.order);
  console.log('  acceptQuality 是数组: '+(Array.isArray(m.acceptQuality))+' 长度='+(m.acceptQuality||[]).length);
  console.log('  pages 是数组: '+(Array.isArray(m.pages)));
  console.log('  sourceMeta.sourceId='+(m.sourceMeta&&m.sourceMeta.sourceId));
  console.log('  凭证外泄检查 username='+JSON.stringify(m.username)+' password='+JSON.stringify(m.password));
  console.log('  createdAt='+m.createdAt+' updatedAt='+m.updatedAt);
  console.log('  duration='+m.duration+' currentQn='+m.currentQn+' cid='+m.cid);
});"
MOVIE_ID=$(echo "$CREATE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{process.stdout.write(String(JSON.parse(s).movie.id))}catch(e){}
})")

echo
echo "=== 5. 库内 password 必须是密文，且 Node 能解出原文 ==="
STORED=$(C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe - "$TESTDIR/dev.sqlite" "$MOVIE_ID" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
row = c.execute('SELECT "password" FROM "movie" WHERE "id"=?', (sys.argv[2],)).fetchone()
print(row[0] if row and row[0] else '')
PY
)
echo "  存储值=${STORED:0:24}... (含冒号: $(case "$STORED" in *:*) echo 是;; *) echo 否;; esac))"
STORED="$STORED" node -e "
const crypto=require('crypto');
const k=process.env.MOVIE_SECRET_KEY||'zcontrol-movie-secret-key-32b';
const key=Buffer.from(k.padEnd(32,'0').slice(0,32));
const [ivHex,dataHex]=process.env.STORED.split(':');
const d=crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex,'hex'));
const out=Buffer.concat([d.update(Buffer.from(dataHex,'hex')), d.final()]).toString('utf8');
console.log('  Node 解密结果='+JSON.stringify(out)+' （期望 \"secret-from-body\"）');
"

echo
echo "=== 6. 更新影片（标题 + currentPage + 关闭 playsvideoEnabled）==="
curl -s -X PUT "$BASE/api/rooms/$ROOM/movies/$MOVIE_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "title":"测试影片 - 改名后","currentPage":2,"playsvideoEnabled":false,"serverProxy":true
  }' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const m=(JSON.parse(s)||{}).movie||{};
    console.log('  title='+m.title+' currentPage='+m.currentPage);
    console.log('  playsvideoEnabled='+m.playsvideoEnabled+' serverProxy='+m.serverProxy);
  });"

echo
echo "=== 7. 更新时传 null 不应清空已有字段（与 Node 的 typeof 判定一致）==="
curl -s -X PUT "$BASE/api/rooms/$ROOM/movies/$MOVIE_ID" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "cover":null,"cid":null,"duration":null
  }' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const m=(JSON.parse(s)||{}).movie||{};
    console.log('  cover='+JSON.stringify(m.cover)+' cid='+m.cid+' duration='+m.duration+' （均应保持原值）');
  });"

echo
echo "=== 8. 新增 openlist 影片：凭证从挂载补全 + 内网强制服务器转发 ==="
OL=$(curl -s -X POST "$BASE/api/rooms/$ROOM/movies" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "url":"http://192.168.1.99:5244/dav/movie/a.mkv",
    "title":"内网影片",
    "source":"openlist",
    "serverUrl":"http://192.168.1.99:5244/dav",
    "path":"/movie/a.mkv",
    "directLink":true
  }')
echo "$OL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const m=(JSON.parse(s)||{}).movie||{};
  console.log('  id='+m.id+' url='+m.url);
  console.log('  directLink='+m.directLink+' （内网地址应为 false）');
  console.log('  sourceMountId='+m.sourceMountId+' （应命中挂载）');
});"
OL_ID=$(echo "$OL" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try{process.stdout.write(String(JSON.parse(s).movie.id))}catch(e){}
})")

echo
echo "=== 9. 代理模式 url 重写 + 挂载凭证回填 ==="
C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe - "$TESTDIR/dev.sqlite" "$OL_ID" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
row = c.execute('SELECT "url","username","password","sourceMountId" FROM "movie" WHERE "id"=?',
                (sys.argv[2],)).fetchone()
print('  DB url=%s' % row[0])
print('  DB username=%s' % row[1])
print('  DB password 非空=%s' % bool(row[2]))
if not row[2]:
    print('  !! 凭证未从挂载回填')
print('  DB sourceMountId=%s' % row[3])
PY

echo
echo "=== 10. 重排序（orderedIds 与 orders 两种格式）==="
curl -s -X POST "$BASE/api/rooms/$ROOM/movies/reorder" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"orderedIds\":[$OL_ID,$MOVIE_ID]}" | head -c 200; echo
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rooms/$ROOM/movies" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const list=(JSON.parse(s)||{}).movies||[];
    console.log('  排序后: '+list.map(m=>m.id+'(order='+m.order+')').join(' → '));
  });"

echo
echo "=== 11. 非房主写操作 -> 期望 403 ==="
curl -s -w "\n  HTTP %{http_code}\n" -X POST "$BASE/api/rooms/$ROOM/movies" \
  -H "Authorization: Bearer $OTHER" -H 'Content-Type: application/json' \
  -d '{"url":"x","title":"越权"}' | head -2

echo
echo "=== 12. 必填校验：缺 title -> 期望 400 ==="
curl -s -w "\n  HTTP %{http_code}\n" -X POST "$BASE/api/rooms/$ROOM/movies" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/a.mp4"}' | head -2

echo
echo "=== 13. 删除单条 + 清空 ==="
curl -s -X DELETE "$BASE/api/rooms/$ROOM/movies/$MOVIE_ID" -H "Authorization: Bearer $TOKEN"; echo
curl -s -X DELETE "$BASE/api/rooms/$ROOM/movies/$OL_ID" -H "Authorization: Bearer $TOKEN"; echo
curl -s -X DELETE "$BASE/api/rooms/$ROOM/movies" -H "Authorization: Bearer $TOKEN"; echo
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/rooms/$ROOM/movies" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    console.log('  清空后数量='+((JSON.parse(s)||{}).movies||[]).length);
  });"

echo
echo "=== 14. 删除不存在的影片 -> 期望 404 ==="
curl -s -w "\n  HTTP %{http_code}\n" -X DELETE "$BASE/api/rooms/$ROOM/movies/999999" \
  -H "Authorization: Bearer $TOKEN" | head -2

echo
echo "=== 服务器日志（错误行）==="
grep -iE "error|panic" "$TESTDIR/server.log" | tail -5 || echo "  无错误"
