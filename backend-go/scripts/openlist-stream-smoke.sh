#!/usr/bin/env bash
# OpenList 影片流代理冒烟（阶段 4C）。
#
# 用 mock AList（scripts/mock-alist.js）替掉真实网盘：真实环境要一台
# 配好存储的 AList + 一个能访问的文件，测试无法自包含；而这层要验证的
# 恰恰是「登录 → fs/get → 签名直链 → Range 透传」这条链路本身。
set -u
REPO=/f/Code/ZViewer/ZViewer
TESTDIR=/tmp/zvol
BIN=/tmp/zviewerd.exe
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-proc.sh"

PORT=$(pick_port)
ALIST_PORT=$(( PORT + 1 ))

rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp "$REPO/config/dev.sqlite" "$TESTDIR/dev.sqlite"

echo "=== 准备数据 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('ol-pass-1234',10))")
enc_secret() {
  (cd "$REPO" && SECRET="$1" node -e "
const crypto=require('crypto');
const k=process.env.MOVIE_SECRET_KEY||'zcontrol-movie-secret-key-32b';
const key=Buffer.from(k.padEnd(32,'0').slice(0,32));
const iv=crypto.randomBytes(16);
const c=crypto.createCipheriv('aes-256-cbc', key, iv);
const out=Buffer.concat([c.update(process.env.SECRET,'utf8'), c.final()]);
process.stdout.write(iv.toString('hex')+':'+out.toString('hex'));
")
}
MOUNT_PW=$(enc_secret 'nas-pass')
BAD_PW=$(enc_secret 'wrong-pass')
INFO=$(MOUNT_PW="$MOUNT_PW" BAD_PW="$BAD_PW" HASH="$HASH" ALIST_PORT="$ALIST_PORT" C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe - "$TESTDIR/dev.sqlite" <<'PY'
import os, sqlite3, sys
db = sys.argv[1]
port = os.environ['ALIST_PORT']
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', ('ol-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('ol-user', os.environ['HASH'], 'root', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('ol-user',)).fetchone()[0]

room = 'OlStreamRoom'
c.execute('DELETE FROM "movie" WHERE "roomId"=?', (room,))
c.execute('DELETE FROM "room" WHERE "roomId"=?', (room,))
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","ownerUserId")
             VALUES (?,?,?,?,?)''', (room, 'OpenList 测试房', 'active', 'watch-together', uid))

server_url = 'http://127.0.0.1:%s/dav' % port
c.execute('DELETE FROM "user_mount" WHERE "name"=?', ('ol-mount',))
c.execute('''INSERT INTO "user_mount" ("userId","type","name","serverUrl","username","password")
             VALUES (?,?,?,?,?,?)''',
          (uid, 'openlist', 'ol-mount', server_url, 'nas-user', os.environ['MOUNT_PW']))
mount_id = c.execute('SELECT "id" FROM "user_mount" WHERE "name"=?', ('ol-mount',)).fetchone()[0]

cols = ('"roomId","url","title","source","serverUrl","path","directLink","sourceMountId",'
        '"playsvideoEnabled","order","createdAt","updatedAt"')
vals = (room, '/api/openlist/stream?movieId=0', 'OpenList 影片', 'openlist', server_url,
        '/movie/a.mkv', 0, mount_id, 1, 0, '2026-10-21 14:15:50.000', '2026-10-21 14:15:50.000')
c.execute('INSERT INTO "movie" (%s) VALUES (%s)' % (cols, ','.join('?' * 12)), vals)
ok_id = c.execute('SELECT last_insert_rowid()').fetchone()[0]

# 认证失败样本：挂载密码错
# 坏密码样本：密码本身是错的那种，用来验证 401 + AUTH_FAILED 分支。
c.execute('''INSERT INTO "user_mount" ("userId","type","name","serverUrl","username","password")
             VALUES (?,?,?,?,?,?)''',
          (uid, 'openlist', 'ol-bad', server_url, 'bad-user', os.environ['BAD_PW']))
bad_mount = c.execute('SELECT "id" FROM "user_mount" WHERE "name"=?', ('ol-bad',)).fetchone()[0]
vals_bad = (room, '/api/openlist/stream?movieId=0', 'OpenList 坏密码', 'openlist', server_url,
            '/movie/a.mkv', 0, bad_mount, 1, 1, '2026-10-21 14:15:50.000', '2026-10-21 14:15:50.000')
c.execute('INSERT INTO "movie" (%s) VALUES (%s)' % (cols, ','.join('?' * 12)), vals_bad)
bad_id = c.execute('SELECT last_insert_rowid()').fetchone()[0]

vals_missing = (room, '/api/openlist/stream?movieId=0', 'OpenList 文件缺失', 'openlist', server_url,
                '/movie/nope.mkv', 0, mount_id, 1, 2, '2026-10-21 14:15:50.000', '2026-10-21 14:15:50.000')
c.execute('INSERT INTO "movie" (%s) VALUES (%s)' % (cols, ','.join('?' * 12)), vals_missing)
missing_id = c.execute('SELECT last_insert_rowid()').fetchone()[0]

c.commit()
print('%d %d %d' % (ok_id, bad_id, missing_id))
PY
)
OK_ID=$(echo "$INFO" | awk '{print $1}')
BAD_ID=$(echo "$INFO" | awk '{print $2}')
MISS_ID=$(echo "$INFO" | awk '{print $3}')
echo "  影片: 正常=$OK_ID 坏密码=$BAD_ID 文件缺失=$MISS_ID"

echo "  启动 mock AList (:${ALIST_PORT})"
node "$HERE/mock-alist.js" "$ALIST_PORT" > "$TESTDIR/alist.log" 2>&1 &
ALIST_PID=$!
for _ in $(seq 1 40); do
  curl -s -o /dev/null "http://127.0.0.1:$ALIST_PORT/__stats" && break
  sleep 0.15
done

CONFIG_DIR="$TESTDIR" PORT="$PORT" PROJECT_ROOT="$REPO" "$BIN" > "$TESTDIR/server.log" 2>&1 &
SRV=$!
cleanup() { kill_tree "$SRV"; kill_tree "$ALIST_PID"; }
trap cleanup EXIT
wait_ready "$PORT" "Go 服务" "$TESTDIR/server.log" "监听" || exit 1

BASE="http://127.0.0.1:$PORT"
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"ol-user","password":"ol-pass-1234"}' |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).accessToken||'')}catch(e){}})")
[ -z "$TOKEN" ] && {
  echo "!! 登录失败，原始响应："
  curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json'     -d '{"username":"ol-user","password":"ol-pass-1234"}' | head -c 300; echo
  exit 1
}

echo
echo "=== 1. 未登录 -> 期望 401 ==="
curl -s -o /dev/null -w "  HTTP %{http_code}\n" "$BASE/api/openlist/stream?movieId=$OK_ID"

echo
echo "=== 2. 缺 movieId -> 期望 400 ==="
curl -s -w "\n  HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" "$BASE/api/openlist/stream" | head -2

echo
echo "=== 3. 显式 Range bytes=0-99 -> 期望 206 + 100 字节 ==="
curl -s -D "$TESTDIR/h3.txt" -o "$TESTDIR/b3.bin" \
  -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-99' \
  "$BASE/api/openlist/stream?movieId=$OK_ID"
grep -iE "^HTTP/|content-range|content-length|content-type|accept-ranges" "$TESTDIR/h3.txt" | tr -d '\r' | sed 's/^/  /'
echo "  实际字节数=$(stat -c%s "$TESTDIR/b3.bin")"

echo
echo "=== 4. 开放式 Range bytes=0- -> 期望被收敛到 8MiB 分片 ==="
curl -s -D "$TESTDIR/h4.txt" -o /dev/null -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-' \
  "$BASE/api/openlist/stream?movieId=$OK_ID"
grep -iE "^HTTP/|content-range|content-length" "$TESTDIR/h4.txt" | tr -d '\r' | sed 's/^/  /'

echo
echo "=== 5. 无 Range 全量 -> 期望 200 + 完整长度 ==="
curl -s -D "$TESTDIR/h5.txt" -o /dev/null -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/openlist/stream?movieId=$OK_ID"
grep -iE "^HTTP/|content-length|content-type" "$TESTDIR/h5.txt" | tr -d '\r' | sed 's/^/  /'

echo
echo "=== 6. 二次请求应命中 raw_url 缓存（fs/get 不重复调用）==="
curl -s -o /dev/null -H "Authorization: Bearer $TOKEN" -H 'Range: bytes=0-9' \
  "$BASE/api/openlist/stream?movieId=$OK_ID"
sleep 0.3
curl -s "http://127.0.0.1:$ALIST_PORT/__stats" |
  node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
    const o=JSON.parse(s);
    console.log('  mock 统计: login='+o.loginCount+' fsGet='+o.fsGetCount+' （多次播放只应各 1 次）');
  });"

echo
echo "=== 7. 挂载密码错误 -> 期望 401 + code=AUTH_FAILED ==="
curl -s -w "\n  HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/openlist/stream?movieId=$BAD_ID" | head -2

echo
echo "=== 8. 文件不存在 -> 期望 404 + code=NOT_FOUND ==="
curl -s -w "\n  HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/openlist/stream?movieId=$MISS_ID" | head -2

echo
echo "=== 9. 影片不存在 -> 期望 404 ==="
curl -s -w "\n  HTTP %{http_code}\n" -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/openlist/stream?movieId=999999" | head -2

echo
echo "=== 服务器日志（openlist 相关）==="
grep -E "openlist" "$TESTDIR/server.log" | tail -8 || echo "  无"
