#!/usr/bin/env bash
# 桌面壳托管环境冒烟（阶段 5 第 5 项的前置验证）。
#
# 桌面壳把后端当**受管子进程**拉起（`ZViewer.ProcessHost.exe` + Job Object），
# 注入一整套环境变量。这个脚本不启动 Wails 壳，而是**复刻它注入的环境**，
# 验证 Go 后端在那种环境下行为正确：
#
#   1. 二进制名/摆放：`<root>/zviewer-backend.exe` + `<root>/frontend/dist/index.html`
#   2. 环境变量：PORT / HOST / HTTPS / SSL_CERT_PATH / SSL_KEY_PATH /
#      RTMP_PORT / HTTP_FLV_PORT / LIVEKIT_* / ZVIEWER_DESKTOP=1
#   3. 断言：TLS 起来 + /health 200 + 静态首页 200 +
#      `/api/system/update/*` 一律 409（桌面托管的「版本更新」守卫）+ 无 panic
#
# 用法：bash backend-go/scripts/desktop-env-smoke.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=desktop-env
WORK=/tmp/zv-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/root/frontend/dist" "$WORK/root/config" "$WORK/root/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/root/config/dev.sqlite"
cp -r "$REPO/frontend/dist/." "$WORK/root/frontend/dist/"
cp "$REPO/config/ssl/cert.pem" "$REPO/config/ssl/key.pem" "$WORK/root/config/" 2>/dev/null

pass=0
fail=0
check() {
  local name="$1" cond="$2"
  if [ "$cond" = "0" ]; then
    echo "  ✓ $name"
    pass=$((pass + 1))
  else
    echo "  ✗ $name"
    fail=$((fail + 1))
  fi
}

echo "=== 编译 zviewer-backend.exe（与分发包同名）==="
(cd "$REPO/backend-go" && go build -o "$WORK/root/zviewer-backend.exe" ./cmd/zviewer-server) || exit 1

if [ ! -f "$WORK/root/config/cert.pem" ]; then
  echo "!! 缺少 config/ssl 证书，先用 Go 生成一份"
  CONFIG_DIR="$(cygpath -w "$WORK/root/config")" "$WORK/root/zviewer-backend.exe" --gen-cert 127.0.0.1 > "$WORK/gencert.log" 2>&1 || exit 1
  cp "$WORK/root/config/ssl/cert.pem" "$WORK/root/config/cert.pem"
  cp "$WORK/root/config/ssl/key.pem" "$WORK/root/config/key.pem"
fi

echo "=== 种子 root 账号（更新端点是 root-only）==="
ADMIN_HASH=$("$NODE" -e "console.log(require('bcryptjs').hashSync('desk-admin-pass',10))")
"$PY" - "$WORK/root/config/dev.sqlite" "$ADMIN_HASH" <<'SEED'
import sqlite3, sys
db, pw_hash = sys.argv[1:3]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', ('desk-admin',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('desk-admin', pw_hash, 'root', 'active'))
c.commit()
SEED

PORT=$(pick_port)
ROOT=$(cygpath -w "$WORK/root")
echo "=== 按桌面壳的方式启动（HTTPS，端口 $PORT）==="
(
  cd "$WORK/root" || exit 1
  PORT=$PORT \
  HOST=127.0.0.1 \
  HTTPS=true \
  SSL_CERT_PATH="$ROOT\\config\\cert.pem" \
  SSL_KEY_PATH="$ROOT\\config\\key.pem" \
  RTMP_PORT=3334 \
  HTTP_FLV_PORT=3335 \
  ZVIEWER_DESKTOP=1 \
  LIVEKIT_EXTERNAL=1 \
  LIVEKIT_API_HOST="http://127.0.0.1:7880" \
  LIVEKIT_API_KEY=devkey \
  LIVEKIT_API_SECRET=devsecret \
  DATABASE_URL="$ROOT\\config\\dev.sqlite" \
  CONFIG_DIR="$ROOT\\config" \
  UPLOADS_DIR="$ROOT\\uploads" \
  PROJECT_ROOT="$ROOT" \
  ./zviewer-backend.exe > "$WORK/backend.log" 2>&1
) &
PID=$!

if ! wait_ready "$PORT" "桌面托管后端" "$WORK/backend.log" "监听"; then
  echo "!! 未就绪"; tail -20 "$WORK/backend.log"; kill_tree "$PID"; exit 1
fi

echo "=== 断言 ==="
curl -sk --max-time 8 "https://127.0.0.1:$PORT/health" | grep -q '"status":"ok"'; check "TLS + /health 200" $?
curl -sk --max-time 8 "https://127.0.0.1:$PORT/" | grep -q -i "<!doctype html\|<div id=\"root\""; check "静态首页返回 index.html" $?

# 桌面托管下网页端「版本更新」必须被拦成 409（整包由 GUI 更新链路负责）。
# 顺序不能反：先 401（匿名）/403（非 root），再 409 —— 否则等于对外暴露
# 「这台机器是桌面版」。
ANON_CODE=$(curl -sk --max-time 8 -o /dev/null -w "%{http_code}" "https://127.0.0.1:$PORT/api/system/update/check")
[ "$ANON_CODE" = "401" ]; check "匿名请求先被 401 拦住（不泄露桌面标识）" $?

TOKEN=$(curl -sk --max-time 8 -X POST -H 'Content-Type: application/json' \
  -d '{"username":"desk-admin","password":"desk-admin-pass"}' \
  "https://127.0.0.1:$PORT/api/auth/login" \
  | "$PY" -c "import sys,json;print(json.load(sys.stdin).get('accessToken',''))")
[ -n "$TOKEN" ]; check "root 登录拿到 accessToken" $?

UPDATE_CODE=$(curl -sk --max-time 8 -o "$WORK/update.json" -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" "https://127.0.0.1:$PORT/api/system/update/check")
[ "$UPDATE_CODE" = "409" ]; check "/api/system/update/check 返回 409（桌面托管守卫）" $?
grep -q '"desktopManaged": *true' "$WORK/update.json"; check "409 带 desktopManaged=true（前端据此渲染提示卡）" $?

# 语音凭证端点存在（即便是 503 也不能 404：桌面壳会预置 LiveKit 密钥）
VOICE_CODE=$(curl -sk --max-time 8 -o /dev/null -w "%{http_code}" -X POST \
  -H 'Content-Type: application/json' -d '{"roomId":"x"}' \
  "https://127.0.0.1:$PORT/api/voice/token")
[ "$VOICE_CODE" != "404" ]; check "/api/voice/token 已注册（$VOICE_CODE）" $?

PANICS=$(grep -c "\[panic\]" "$WORK/backend.log" 2>/dev/null || true)
[ "${PANICS:-0}" = "0" ]; check "全程无 panic" $?

kill_tree "$PID"

echo
if [ "$fail" -eq 0 ]; then
  echo "✓ $pass 项桌面托管环境检查全部通过"
else
  echo "✗ $fail / $((pass + fail)) 项失败（日志 $WORK/backend.log）"
  exit 1
fi
