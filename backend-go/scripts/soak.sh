#!/usr/bin/env bash
# 短时 soak（阶段 5 检查单第 2 项的自动化部分）。
#
# 检查单原文是「停 Node 进程 → 仅 Go 运行 24h 无告警」。24h 不可能在会话里跑完，
# 这里做的是**压缩版**：固定并发高频打一批代表性端点，看有没有 5xx / 超时 /
# 吞吐衰减 / panic。真机 24h 用同一条命令、把 SOAK_SECONDS 调大即可：
#
#   SOAK_SECONDS=86400 bash backend-go/scripts/soak.sh
#
# 默认 120 秒（日常回归用），期间约 1~3 万次请求。
#
# 用法：bash backend-go/scripts/soak.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=soak
WORK=/tmp/zv-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/soak-driver.js"

SOAK_SECONDS=${SOAK_SECONDS:-120}
ADMIN_USER=soak-admin
ADMIN_PASS=soak-admin-pass
ROOM_ID=SOAKROOM1

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/cfg" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/cfg/dev.sqlite"

echo "=== 种子：root 账号 + 房间 ==="
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
          (room_id, 'soak 房间', 'active', 'watch-together', 'webrtc', uid, now))
c.commit()
PY

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

PORT=$(pick_port)
CFG=$(cygpath -w "$WORK/cfg")
DB="$CFG\\dev.sqlite"
UPLOADS=$(cygpath -w "$WORK/uploads")
ROOT=$(cygpath -w "$REPO")
echo "=== 启动 Go（端口 $PORT，soak ${SOAK_SECONDS}s）==="
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

echo "=== 施压 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$PORT" "$ADMIN_USER" "$ADMIN_PASS" "$ROOM_ID" "$SOAK_SECONDS"
CODE=$?

echo "=== 服务端日志体检 ==="
PANICS=$(grep -c "\[panic\]" "$WORK/go.log" 2>/dev/null || true)
[ "${PANICS:-0}" = "0" ]; echo "  · panic: ${PANICS:-0}"
# Go 侧自己的 5xx 日志（[req] 行的状态码）——客户端侧已经统计过，这里交叉验证
SERVER_5XX=$(grep -cE "\[req\] (GET|POST|PUT|DELETE) 5[0-9][0-9]" "$WORK/go.log" 2>/dev/null || true)
echo "  · 服务端 5xx: ${SERVER_5XX:-0}"
if [ "${PANICS:-0}" != "0" ]; then
  grep -A 3 "\[panic\]" "$WORK/go.log" | head -20
  CODE=1
fi

kill_tree "$GO_PID"

echo
if [ "$CODE" -eq 0 ]; then
  echo "✓ 压缩版 soak 通过（真机 24h: SOAK_SECONDS=86400 bash backend-go/scripts/soak.sh）"
else
  echo "✗ soak 未通过（日志在 $WORK/go.log）"
fi
exit "$CODE"
