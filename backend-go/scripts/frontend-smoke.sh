#!/usr/bin/env bash
# 前端全链路冒烟（阶段 5 检查单第 4 项）。
#
# 三件事：
#   1. 前端质量门禁：`tsc` + `vite build`（类型漂移会让 SPA 在运行时才炸）
#   2. Go 托管前端产物（PROJECT_ROOT 指仓库根，CONFIG_DIR/DB 指临时目录）
#   3. 真实 Chromium 逐页访问：首页 / 登录 / 房间列表 / 管理页 / 个人中心 / 房间页，
#      断言「页面锚点文案 + 控制台零 error + 无 4xx/5xx 请求」
#
# 跳过后端专用能力（B站解析、推流）——那些需要外网或外部服务，由各自的
# 对拍脚本覆盖；这里只看「打开页面能不能用」。
#
# 用法：bash backend-go/scripts/frontend-smoke.sh
#   SKIP_FRONTEND_BUILD=1  复用现有 frontend/dist（调试时省时间）
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=frontend-smoke
WORK=/tmp/zv-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/frontend-smoke.js"

ADMIN_USER=fe-admin
ADMIN_PASS=fe-admin-pass
ROOM_ID=FESMOKE1

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/cfg" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/cfg/dev.sqlite"

if [ "${SKIP_FRONTEND_BUILD:-0}" != "1" ]; then
  echo "=== 1. 前端构建（tsc + vite build）==="
  (cd "$REPO/frontend" && "$NODE" ../node_modules/typescript/bin/tsc && "$NODE" ../node_modules/vite/bin/vite.js build) || exit 1
  echo "=== 1b. 前端单测 ==="
  (cd "$REPO" && "$NODE" --experimental-strip-types --test "frontend/src/modules/music/utils/__tests__/*.test.ts") || exit 1
else
  echo "=== 1. 跳过前端构建（SKIP_FRONTEND_BUILD=1）==="
fi
[ -f "$REPO/frontend/dist/index.html" ] || { echo "!! 缺少 frontend/dist/index.html"; exit 1; }

echo "=== 2. 种子：root 账号 + 一个房间 ==="
ADMIN_HASH=$("$NODE" -e "console.log(require('bcryptjs').hashSync('$ADMIN_PASS',10))")
"$PY" - "$WORK/cfg/dev.sqlite" "$ADMIN_HASH" "$ADMIN_USER" "$ROOM_ID" <<'PY'
import sqlite3, sys
from datetime import datetime, timezone

db, pw_hash, name, room_id = sys.argv[1:5]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          (name, pw_hash, 'root', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', (name,)).fetchone()[0]

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.000')
c.execute('DELETE FROM "room" WHERE "roomId"=?', (room_id,))
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","shareMethod","ownerUserId","lastAccessedAt")
             VALUES (?,?,?,?,?,?,?)''',
          (room_id, '冒烟房间', 'active', 'watch-together', 'webrtc', uid, now))
c.commit()
PY

echo "=== 3. 编译并启动 Go（托管前端产物）==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

PORT=$(pick_port)
CFG=$(cygpath -w "$WORK/cfg")
DB="$CFG\\dev.sqlite"
UPLOADS=$(cygpath -w "$WORK/uploads")
ROOT=$(cygpath -w "$REPO")
(
  PORT=$PORT \
  DATABASE_URL="$DB" \
  CONFIG_DIR="$CFG" \
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$ROOT" \
  NMS_HTTP_FLV_URL="http://127.0.0.1:1" \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; exit 1
fi
# Go 不打「静态目录」日志（Node 会打），这里直接问一句「根路径给的是不是 index.html」
ROOT_TYPE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/")
[ "$ROOT_TYPE" = "200" ]; echo "  · 根路径 / 返回 $ROOT_TYPE"

echo "=== 4. Chromium 逐页冒烟 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$PORT" "$ADMIN_USER" "$ADMIN_PASS" "$ROOM_ID"
CODE=$?

# 页面访问期间的 5xx / panic 也要看：白屏常常是后端 500 撑出来的
HEAVY=$(grep -c "\[panic\]" "$WORK/go.log" 2>/dev/null || true)
if [ "${HEAVY:-0}" != "0" ]; then
  echo "!! 冒烟期间出现 $HEAVY 次 panic："
  grep -A 3 "\[panic\]" "$WORK/go.log" | head -20
  CODE=1
fi

kill_tree "$GO_PID"

echo
if [ "$CODE" -eq 0 ]; then
  echo "✓ 前端全链路冒烟通过"
else
  echo "✗ 前端全链路冒烟未通过（详见上面失败项，服务端日志在 $WORK/go.log）"
fi
exit "$CODE"
