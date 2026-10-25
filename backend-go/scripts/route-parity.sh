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
# 用法：
#   bash backend-go/scripts/route-parity.sh            # 自动：backend/ 还在就用 Node 实时路由表
#   bash backend-go/scripts/route-parity.sh --fixture  # 强制用契约快照（不需要 Node）
#
# 端点清单的来源有两种：
#   · backend/ 还在 → 直接遍历 Node 的 Express 路由表（最权威，能发现 Node 新增了什么）
#   · backend/ 已删 → 用 backend-go/testdata/contract/routes.json（删除前冻结的快照）
# 两种来源下探测逻辑完全相同，所以「Go 侧是否覆盖了全部历史端点」这条保证不会因为
# 删掉 Node 而失效。
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=route-parity
WORK=/tmp/zv-$TAG
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
FIXTURE=backend-go/testdata/contract/routes.json

USE_FIXTURE=0
[ -d "$REPO/backend/src" ] || USE_FIXTURE=1
[ "${1:-}" = "--fixture" ] && USE_FIXTURE=1

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
AUDIT_ARGS=(--probe "http://127.0.0.1:$PORT")
if [ "$USE_FIXTURE" = "1" ]; then
  echo "（端点清单来源：契约快照 $FIXTURE）"
  [ -f "$REPO/$FIXTURE" ] || { echo "!! 契约快照缺失：$FIXTURE"; kill_tree "$PID"; exit 1; }
  AUDIT_ARGS=(--fixture "$FIXTURE" "${AUDIT_ARGS[@]}")
else
  echo "（端点清单来源：Node 运行时路由表）"
fi
"$NODE" "$REPO/backend-go/scripts/route-audit.js" "${AUDIT_ARGS[@]}"
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
