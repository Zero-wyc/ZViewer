#!/usr/bin/env bash
# 端点全覆盖检查（阶段 5 检查单第 1 项）。
#
# 做的事：起一份真实的 Go 服务，把 Node（Express，运行时遍历出来的）全部 /api
# 路由逐条打一遍，看有没有落到 Go 的 `/api/` 404 兜底（文案「接口不存在」）。
# 落到兜底 = 该端点没实现，或被路径写法挡住（参数名不同不会误报，因为打的是真实 URL）。
#
# 为什么不用纯静态对账：Go 侧 emby/jellyfin 用变量拼前缀、Node 侧存在嵌套 router，
# 两边静态解析都会互相误报。静态扫描保留在 route-audit.js 里做快速预检，
# 最终判定以本脚本的行为探测为准。
#
# 用法：bash backend-go/scripts/route-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=route-parity
WORK=/tmp/zv-$TAG
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/cfg"
CFG=$(cygpath -w "$WORK/cfg")
DB="$CFG\\dev.sqlite"
UPLOADS="$CFG\\uploads"
cp "$REPO/config/dev.sqlite" "$WORK/cfg/dev.sqlite"

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

PORT=$(pick_port)
echo "=== 启动 Go（端口 $PORT）==="
(
  PORT=$PORT \
  DATABASE_URL="$DB" \
  CONFIG_DIR="$CFG" \
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$CFG" \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
PID=$!

if ! wait_ready "$PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$PID"; exit 1
fi

echo "=== 逐条探测 ==="
"$NODE" "$REPO/backend-go/scripts/route-audit.js" --probe "http://127.0.0.1:$PORT"
CODE=$?

# 探测过程中出现的 5xx / panic 也要看：panic 说明某条路由的实现是坏的。
PANICS=$(grep -c "\[panic\]" "$WORK/go.log" 2>/dev/null || true)
if [ "${PANICS:-0}" != "0" ]; then
  echo "!! 探测期间出现 $PANICS 次 panic："
  grep -A 3 "\[panic\]" "$WORK/go.log" | head -20
  CODE=1
fi

kill_tree "$PID"

echo
if [ "$CODE" -eq 0 ]; then
  echo "✓ 全部 /api 路由在 Go 侧都存在，且探测期间无 panic"
else
  echo "✗ 端点覆盖检查未通过"
fi
exit "$CODE"
