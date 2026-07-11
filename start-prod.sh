#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"
FRONTEND_PORT=4173

PORT=3000
DATABASE=""
SKIP_BUILD=0

usage() {
  echo "用法: $0 [--skip-build] [-p PORT] [-d DATABASE_URL]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    -p|--port) PORT="$2"; shift 2 ;;
    -d|--database) DATABASE="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo "错误: $1 未安装或不在 PATH 中" >&2
    exit 1
  fi
}

install_deps() {
  local dir="$1"
  echo "[$dir] 安装依赖 ..."
  cd "$dir"
  if [[ -f package-lock.json ]]; then
    npm ci
  else
    npm install
  fi
}

# 1. 检查 node 与 npm
check_command node
check_command npm
echo "Node.js: $(node --version)"
echo "npm: $(npm --version)"

# 2. 安装依赖（优先 npm ci）
install_deps "$ROOT_DIR"
install_deps "$BACKEND_DIR"
install_deps "$FRONTEND_DIR"

# 3. 构建（可跳过）
if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "构建后端 ..."
  cd "$BACKEND_DIR"
  npm run build

  echo "构建前端 ..."
  cd "$FRONTEND_DIR"
  npm run build
else
  echo "跳过构建"
fi

# 4. 确认产物存在
if [[ ! -f "$BACKEND_DIR/dist/index.js" ]]; then
  echo "错误: 未找到 backend/dist/index.js，请先构建" >&2
  exit 1
fi

# 5. 启动后端
{
  echo "启动后端服务：PORT=$PORT"
  if [[ -n "$DATABASE" ]]; then
    echo "DATABASE_URL=$DATABASE"
  fi
}
cd "$BACKEND_DIR"
PORT="$PORT" NODE_ENV=production ${DATABASE:+DATABASE_URL="$DATABASE"} nohup node dist/index.js > "$ROOT_DIR/backend-prod.log" 2>&1 &
BACKEND_PID=$!
echo "后端进程已启动，PID: $BACKEND_PID"
sleep 0.5

# 6. 启动前端静态服务
echo "启动前端静态服务：PORT=$FRONTEND_PORT"
cd "$FRONTEND_DIR"
NODE_ENV=production nohup node ./node_modules/vite/bin/vite.js preview --port "$FRONTEND_PORT" > "$ROOT_DIR/frontend-prod.log" 2>&1 &
FRONTEND_PID=$!
echo "前端进程已启动，PID: $FRONTEND_PID"

# 7. 写入 PID 文件
cat > "$PIDS_FILE" <<EOF
{
  "backend": { "pid": $BACKEND_PID, "port": $PORT, "url": "http://localhost:$PORT" },
  "frontend": { "pid": $FRONTEND_PID, "port": $FRONTEND_PORT, "url": "http://localhost:$FRONTEND_PORT" }
}
EOF

echo ""
echo "生产服务已启动："
echo "  后端：http://localhost:$PORT"
echo "  前端：http://localhost:$FRONTEND_PORT"
echo "PID 文件：$PIDS_FILE"
echo "日志文件：$ROOT_DIR/backend-prod.log, $ROOT_DIR/frontend-prod.log"
