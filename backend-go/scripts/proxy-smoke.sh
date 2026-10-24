#!/usr/bin/env bash
# 防盗链代理端到端验证：真实库副本 + 真实公网源。
#
# 单测里上游是 httptest（且 DNS 被打桩），这里补上"真的出网"这一层：
# TLS、重定向、Range、通配 CORS 都在真实链路上过一遍。
set -u
REPO=/f/Code/ZViewer/ZViewer
TESTDIR=/tmp/zvproxy
PORT=3403
BIN=/tmp/zviewerd.exe
# 用配置里现成的 Kazumi 规则地址当公网样本（体积小、稳定、非视频）
TARGET="https://raw.githubusercontent.com/Predidit/KazumiRules/main/DM84.json"

rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp "$REPO/config/dev.sqlite" "$TESTDIR/dev.sqlite"

HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('init-pass-1234',10))")
python - "$TESTDIR/dev.sqlite" "$HASH" <<'PY'
import sqlite3, sys
db, h = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username" = ?', ('proxy-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('proxy-user', h, 'user', 'active'))
c.commit()
PY

CONFIG_DIR="$TESTDIR" PORT="$PORT" PROJECT_ROOT="$REPO" "$BIN" > "$TESTDIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then break; fi
  sleep 0.25
done
BASE="http://127.0.0.1:$PORT"
ENC=$(python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$TARGET")

TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"proxy-user","password":"init-pass-1234"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).accessToken||''))")

echo "=== 1. 未鉴权 -> 期望 401 ==="
curl -s -o /dev/null -w "status=%{http_code}\n" "$BASE/api/stream/kazumi/proxy?url=$ENC"

echo "=== 2. 内网目标 -> 期望 403 ==="
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stream/kazumi/proxy?url=http%3A%2F%2F127.0.0.1%3A$PORT%2Fapi%2Fauth%2Fme"; echo

echo "=== 3. 正常代理公网文件 -> 期望 200 ==="
curl -s -D "$TESTDIR/h1.txt" -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stream/kazumi/proxy?url=$ENC&referer=https%3A%2F%2Fexample.com%2F" \
  -o "$TESTDIR/body.json" -w "status=%{http_code} size=%{size_download}\n"
head -3 "$TESTDIR/body.json"; echo
echo "--- 关键响应头 ---"
grep -iE "^(access-control-allow-origin|x-accel-buffering|accept-ranges|content-type|cache-control)" "$TESTDIR/h1.txt"

echo "=== 4. Range 请求 -> 期望 206 ==="
curl -s -D "$TESTDIR/h2.txt" -H "Authorization: Bearer $TOKEN" -H "Range: bytes=0-99" \
  "$BASE/api/stream/kazumi/proxy?url=$ENC" -o "$TESTDIR/part.bin" -w "status=%{http_code} size=%{size_download}\n"
grep -iE "^(content-range|content-length)" "$TESTDIR/h2.txt"

echo "=== 5. 越界 Range -> 期望透传上游 416 ==="
curl -s -H "Authorization: Bearer $TOKEN" -H "Range: bytes=999999999-" \
  -o /dev/null -w "status=%{http_code}\n" "$BASE/api/stream/kazumi/proxy?url=$ENC"

echo "=== 6. 不存在的上游 -> 期望透传 404 ==="
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/stream/kazumi/proxy?url=https%3A%2F%2Fraw.githubusercontent.com%2FPredidit%2FKazumiRules%2Fmain%2F__nope__.json"; echo

echo "=== 代理日志 ==="
grep -E "proxy" "$TESTDIR/server.log" | tail -8
