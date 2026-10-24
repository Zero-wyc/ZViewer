#!/usr/bin/env bash
# 在真实库副本上验证「鉴权收尾」四个端点：改密 / 改名 / 头像上传 / 头像删除。
#
# 用 config/dev.sqlite 的副本而不是临时造表，是为了让 TypeORM 生成的真实 DDL、
# CHECK 约束、UNIQUE 索引全部参与验证——测试里手写的建表语句抄漏一条就会假绿。
set -u
REPO=/f/Code/ZViewer/ZViewer
TESTDIR=/tmp/zvprofile
PORT=3402
BIN=/tmp/zviewerd.exe

rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp "$REPO/config/dev.sqlite" "$TESTDIR/dev.sqlite"

# 造一个已知密码的测试用户（bcryptjs 与 Go 的 x/crypto/bcrypt 互通，$2b$ 前缀）
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('init-pass-1234',10))")
python - "$TESTDIR/dev.sqlite" "$HASH" <<'PY'
import sqlite3, sys
db, h = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
for name in ('smoke-user', 'smoke-rl'):
    c.execute('DELETE FROM "user" WHERE "username" = ?', (name,))
    c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
              (name, h, 'root', 'active'))
c.commit()
print('已插入 smoke-user / smoke-rl（role=root）')
PY

CONFIG_DIR="$TESTDIR" PORT="$PORT" PROJECT_ROOT="$REPO" "$BIN" > "$TESTDIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then break; fi
  sleep 0.25
done
BASE="http://127.0.0.1:$PORT"

json_field() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const p='$1'.split('.');let v=o;for(const k of p)v=v?.[k];console.log(v===undefined||v===null?'':v)}catch(e){console.log('')}})"; }

echo "=== 1. 登录（初始密码） ==="
LOGIN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"smoke-user","password":"init-pass-1234"}')
echo "$LOGIN" | head -c 300; echo
TOKEN=$(echo "$LOGIN" | json_field accessToken)
echo "token 长度: ${#TOKEN}"

echo "=== 2. 改密：旧密码错 -> 期望 401 ==="
curl -s -o /dev/null -w "status=%{http_code}\n" -X PATCH "$BASE/api/auth/password" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"oldPassword":"wrong","newPassword":"new-pass-5678"}'

echo "=== 3. 改密：正确旧密码 -> 期望 200 ==="
curl -s -X PATCH "$BASE/api/auth/password" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"oldPassword":"init-pass-1234","newPassword":"new-pass-5678"}'; echo

echo "=== 4. 旧 token 应立刻失效 -> 期望 401 ==="
curl -s -o /dev/null -w "status=%{http_code}\n" -H "Authorization: Bearer $TOKEN" "$BASE/api/auth/me"

echo "=== 5. 新密码登录 -> 期望 200 ==="
LOGIN2=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"smoke-user","password":"new-pass-5678"}')
echo "$LOGIN2" | head -c 200; echo
TOKEN2=$(echo "$LOGIN2" | json_field accessToken)

echo "=== 6. 改用户名（root） -> 期望 200 ==="
curl -s -X PATCH "$BASE/api/auth/username" \
  -H "Authorization: Bearer $TOKEN2" -H 'Content-Type: application/json' \
  -d '{"username":"smoke-user-renamed"}'; echo

echo "=== 7. 上传头像 -> 期望 200 ==="
printf '\x89PNG\r\n\x1a\nfake-image-bytes' > "$TESTDIR/avatar.png"
# Windows 的 curl.exe 不认 /tmp 这种 POSIX 路径，必须先转成盘符路径，
# 否则 -F 直接报 "Failed to open/read local data"，请求根本不会发出（也不会出现在日志里）。
AVFILE="$TESTDIR/avatar.png"
if command -v cygpath >/dev/null 2>&1; then AVFILE=$(cygpath -m "$AVFILE"); fi
UP=$(curl -s -X POST "$BASE/api/auth/avatar" -H "Authorization: Bearer $TOKEN2" \
  -F "avatar=@$AVFILE;type=image/png")
echo "$UP" | head -c 300; echo
AVATAR=$(echo "$UP" | json_field user.avatar)
echo "avatar=$AVATAR"

echo "=== 8. 头像匿名可访问 -> 期望 200 ==="
curl -s -o /dev/null -w "status=%{http_code} type=%{content_type}\n" "$BASE$AVATAR"

echo "=== 9. 库里 tokenInvalidBefore 的格式（应带毫秒、UTC） ==="
python - "$TESTDIR/dev.sqlite" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
for r in c.execute('SELECT "username","avatar","tokenInvalidBefore","updatedAt" FROM "user" WHERE "username" LIKE ?', ('smoke-user%',)):
    print(r)
print('审计:', c.execute('SELECT "action","actorUsername" FROM "audit_logs" WHERE "actorUsername" LIKE ? ORDER BY "id" DESC LIMIT 4', ('smoke-user%',)).fetchall())
PY

echo "=== 10. 删除头像 -> 期望 200 且 avatar=null ==="
curl -s -X DELETE "$BASE/api/auth/avatar" -H "Authorization: Bearer $TOKEN2"; echo
echo "头像文件是否还在:"
ls -1 "$TESTDIR/uploads/avatars" 2>/dev/null || echo "(目录为空或不存在)"

echo "=== 11. 改密限流：换一个用户连续 4 次 -> 前 3 次 401，第 4 次 429 ==="
RL_TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"smoke-rl","password":"init-pass-1234"}' | json_field accessToken)
for i in 1 2 3 4; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/api/auth/password" \
    -H "Authorization: Bearer $RL_TOKEN" -H 'Content-Type: application/json' \
    -d '{"oldPassword":"bad","newPassword":"whatever-9999"}')
  echo "第 $i 次: $code"
done

echo "=== 12. 迁移回 Node 后旧令牌是否也被拒（用 Node 的判定规则复核） ==="
REVOKE=$(python - "$TESTDIR/dev.sqlite" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
print(c.execute('SELECT "tokenInvalidBefore" FROM "user" WHERE "username" LIKE ?', ('smoke-user%',)).fetchone()[0])
PY
)
echo "库中 tokenInvalidBefore = $REVOKE"
OLD_TOKEN="$TOKEN" REVOKE="$REVOKE" node -e "
const payload = JSON.parse(Buffer.from(process.env.OLD_TOKEN.split('.')[1], 'base64url').toString());
const issuedAt = payload.issuedAtMs ?? (payload.iat ?? 0) * 1000;
const revoke = new Date(process.env.REVOKE).getTime();
console.log('旧 token issuedAtMs =', issuedAt, '| Node 解析吊销时间 =', revoke);
console.log('Node 规则下是否失效:', issuedAt <= revoke ? '是（正确）' : '否（不一致！）');
"

echo "=== 服务器日志（末 20 行） ==="
tail -20 "$TESTDIR/server.log"
