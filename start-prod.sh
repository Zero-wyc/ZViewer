#!/usr/bin/env bash
set -euo pipefail

# ZViewer 生产服务统一管理脚本
# 适配 npm workspaces（根目录统一安装依赖）
# 支持子命令：start | stop | restart | status | logs | port | menu | help

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"
PORTS_FILE="$ROOT_DIR/.prod.ports.json"
BACKEND_LOG="$ROOT_DIR/backend-prod.log"
BACKEND_ERR_LOG="$ROOT_DIR/backend-prod.err.log"
FRONTEND_LOG="$ROOT_DIR/frontend-prod.log"
FRONTEND_ERR_LOG="$ROOT_DIR/frontend-prod.err.log"

# 默认端口（可被 .prod.ports.json 或命令行参数覆盖）
DEFAULT_PORT=3333
DEFAULT_FRONTEND_PORT=4173
PORT=""
FRONTEND_PORT=""
DATABASE=""
SKIP_BUILD=0
FORCE_DEPS=0
SKIP_BUILD_AUTO=0      # 智能跳过：检测到产物新于源代码时自动跳过
COMMAND="help"
LOG_TARGET="backend"

usage() {
  cat <<EOF

========================================
  ZViewer 生产服务管理脚本
========================================

用法: $0 <command> [options]

命令：
  start     构建并启动服务
  stop      停止服务
  restart   重启服务（不重新构建）
  status    查看服务状态
  logs      查看日志（默认 backend，可选 frontend）
  port      交互式修改端口配置（持久化到 .prod.ports.json）
  menu      交互式菜单
  help      显示此帮助

选项：
  --skip-build           跳过构建步骤
  --auto-build           智能构建：产物新于源代码时自动跳过（默认行为）
  --no-auto-build        禁用智能构建跳过，强制构建
  --force-deps           强制重新安装依赖（默认跳过已安装）
  -p, --port <int>       后端端口（默认 3333，优先级高于配置文件）
  --frontend-port <int>  前端端口（默认 4173，优先级高于配置文件）
  -d, --database <url>   数据库 URL

端口优先级：
  命令行参数 > .prod.ports.json 配置文件 > 默认值

示例：
  $0 start
  $0 start --skip-build -p 3001
  $0 start --no-auto-build     # 强制重新构建
  $0 port
  $0 logs frontend

EOF
  exit 0
}

# ============ 参数解析 ============
if [[ $# -gt 0 ]]; then
  case "$1" in
    start|stop|restart|status|logs|port|menu) COMMAND="$1"; shift ;;
    -h|--help|help) usage ;;
    *) echo "未知命令: $1" >&2; usage ;;
  esac
fi

# 命令行显式传入端口标记（用于优先级判断）
PORT_CLI_SET=0
FRONTEND_PORT_CLI_SET=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --auto-build) SKIP_BUILD_AUTO=1; shift ;;
    --no-auto-build) SKIP_BUILD_AUTO=2; shift ;;
    --force-deps) FORCE_DEPS=1; shift ;;
    -p|--port) PORT="$2"; PORT_CLI_SET=1; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; FRONTEND_PORT_CLI_SET=1; shift 2 ;;
    -d|--database) DATABASE="$2"; shift 2 ;;
    backend|frontend) LOG_TARGET="$1"; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

# ============ 辅助函数 ============

write_title() {
  echo ""
  echo "========================================"
  echo "  $1"
  echo "========================================"
}

check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo "错误: $1 未安装或不在 PATH 中" >&2
    exit 1
  fi
}

# ============ 端口配置 ============

read_ports_file() {
  # 输出 "backend frontend" 或空
  if [[ ! -f "$PORTS_FILE" ]]; then return 1; fi
  local backend frontend
  backend=$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.backend||'')}catch(e){console.log('')}" "$PORTS_FILE" 2>/dev/null || true)
  frontend=$(node -e "try{const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(d.frontend||'')}catch(e){console.log('')}" "$PORTS_FILE" 2>/dev/null || true)
  if [[ -n "$backend" && -n "$frontend" ]]; then
    echo "$backend $frontend"
    return 0
  fi
  return 1
}

write_ports_file() {
  local backend="$1"
  local frontend="$2"
  local updated_at
  updated_at=$(date -Iseconds 2>/dev/null || date '+%Y-%m-%dT%H:%M:%S')
  cat > "$PORTS_FILE" <<EOF
{
  "backend": $backend,
  "frontend": $frontend,
  "updatedAt": "$updated_at"
}
EOF
}

port_in_use_check() {
  # 校验端口范围
  local port="$1"
  if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
    echo "  端口 $port 不合法（需 1-65535）" >&2
    return 1
  fi
  return 0
}

read_port_input() {
  # 交互式读取端口，参数：提示文案 默认值
  local prompt="$1"
  local default="$2"
  while true; do
    read -r -p "$prompt (默认 $default，留空使用默认): " input
    if [[ -z "$input" ]]; then
      echo "$default"
      return 0
    fi
    if ! [[ "$input" =~ ^[0-9]+$ ]]; then
      echo "  请输入正整数" >&2
      continue
    fi
    if ! port_in_use_check "$input"; then
      continue
    fi
    echo "$input"
    return 0
  done
}

# ============ 依赖与构建 ============

deps_installed() {
  # npm workspaces：根目录 node_modules 存在 + 关键依赖存在
  [[ -d "$ROOT_DIR/node_modules" ]] || return 1
  [[ -d "$ROOT_DIR/node_modules/express" ]] || return 1
  [[ -d "$ROOT_DIR/node_modules/vite" ]] || return 1
  return 0
}

install_deps() {
  # npm workspaces：仅在根目录安装一次，子目录自动 hoist
  echo "  [$ROOT_DIR] 检测到 package-lock.json，执行 npm ci ..."
  (cd "$ROOT_DIR" && npm ci --no-audit --no-fund --prefer-offline) || {
    echo "  npm ci 失败，回退到 npm install ..." >&2
    (cd "$ROOT_DIR" && npm install --no-audit --no-fund) || { echo "依赖安装失败" >&2; exit 1; }
  }
}

# 智能构建跳过：检测构建产物是否新于所有源代码文件
# 返回 0 = 可跳过，1 = 需要构建
build_up_to_date() {
  local project_dir="$1"
  local artifact="$2"

  # 产物不存在，必须构建
  if [[ ! -e "$artifact" ]]; then
    return 1
  fi

  # 获取产物 mtime（秒级）
  local artifact_mtime
  artifact_mtime=$(stat -c %Y "$artifact" 2>/dev/null || stat -f %m "$artifact" 2>/dev/null || echo 0)

  # 查找 src 目录下所有源代码文件，任一新于产物则需重新构建
  if [[ ! -d "$project_dir/src" ]]; then
    return 0   # 无 src 目录，无法判断，按"已最新"处理
  fi

  local newest_src
  # 兼容 GNU find（Linux）与 BSD find（macOS）：使用 -newer 比较
  if newest_src=$(find "$project_dir/src" -type f -newer "$artifact" -print -quit 2>/dev/null); then
    if [[ -n "$newest_src" ]]; then
      return 1   # 发现新于产物的源文件
    fi
  fi

  # 同时检查 package.json / tsconfig.json 等配置文件
  for cfg in "$project_dir/package.json" "$project_dir/tsconfig.json" "$project_dir/vite.config.ts" "$project_dir/vite.config.js"; do
    if [[ -f "$cfg" ]] && [[ "$cfg" -nt "$artifact" ]]; then
      return 1
    fi
  done

  return 0
}

# ============ PID 与端口 ============

read_pid() {
  local key="$1"
  if [[ ! -f "$PIDS_FILE" ]] || ! command -v node &> /dev/null; then
    echo ""
    return
  fi
  node -e "
    const fs = require('fs');
    try {
      const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
      console.log(data[process.argv[2]].pid || '');
    } catch (e) { console.log(''); }
  " "$PIDS_FILE" "$key" 2>/dev/null || true
}

pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

# 通过端口查找真正监听的进程 PID
get_pid_by_port() {
  local port="$1"
  local timeout_ms="${2:-4000}"
  local deadline=$(( $(date +%s%3N) + timeout_ms ))
  while [[ $(date +%s%3N) -lt $deadline ]]; do
    local pid=""
    if command -v lsof &> /dev/null; then
      pid=$(lsof -t -i:"$port" -sTCP:LISTEN 2>/dev/null | head -n1 || true)
    elif command -v ss &> /dev/null; then
      pid=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -n1 || true)
    fi
    if [[ -n "$pid" ]]; then
      echo "$pid"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

resolve_vite_js() {
  # vite 在 workspaces 模式下可能 hoist 到根目录，也可能在 frontend/node_modules
  local candidates=(
    "$ROOT_DIR/node_modules/vite/bin/vite.js"
    "$FRONTEND_DIR/node_modules/vite/bin/vite.js"
  )
  for p in "${candidates[@]}"; do
    if [[ -f "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

stop_by_pid_or_port() {
  local pid="$1"
  local port="$2"
  if pid_running "$pid"; then
    # 1. 优雅关闭（含子进程）
    kill -TERM "$pid" 2>/dev/null || true
    local deadline=$(( $(date +%s) + 3 ))
    while pid_running "$pid" && [[ $(date +%s) -lt $deadline ]]; do
      sleep 0.2
    done
    # 2. 超时强制结束
    if pid_running "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
      echo "  已强制结束进程 PID $pid"
    else
      echo "  已结束进程 PID $pid"
    fi
  else
    # PID 已失效，按端口查找
    local real_pid
    if real_pid=$(get_pid_by_port "$port" 500); then
      echo "  PID $pid 已失效，按端口 $port 查找到真实 PID $real_pid"
      kill -TERM "$real_pid" 2>/dev/null || true
      local d2=$(( $(date +%s) + 3 ))
      while pid_running "$real_pid" && [[ $(date +%s) -lt $d2 ]]; do
        sleep 0.2
      done
      if pid_running "$real_pid"; then
        kill -KILL "$real_pid" 2>/dev/null || true
        echo "  已强制结束进程 PID $real_pid"
      else
        echo "  已结束进程 PID $real_pid"
      fi
    else
      echo "  PID $pid 不存在，端口 $port 也未监听"
    fi
  fi
}

port_in_use() {
  local port="$1"
  if command -v lsof &> /dev/null; then
    lsof -i:"$port" > /dev/null 2>&1
  elif command -v ss &> /dev/null; then
    ss -lnt "sport = :$port" 2>/dev/null | grep -q ":$port"
  else
    return 1
  fi
}

# ============ 命令实现 ============

do_start() {
  write_title "ZViewer 生产服务启动"

  echo "  后端端口：$PORT"
  echo "  前端端口：$FRONTEND_PORT"

  # 检查是否已在运行
  local backend_pid frontend_pid
  backend_pid=$(read_pid backend)
  frontend_pid=$(read_pid frontend)
  if pid_running "$backend_pid" || pid_running "$frontend_pid"; then
    echo "服务已在运行中，如需重启请使用 restart 子命令" >&2
    pid_running "$backend_pid"  && echo "  后端 PID: $backend_pid"
    pid_running "$frontend_pid" && echo "  前端 PID: $frontend_pid"
    return 0
  fi
  rm -f "$PIDS_FILE"

  echo "[1/5] 检查环境 ..."
  check_command node
  check_command npm
  echo "  Node.js: $(node --version)"
  echo "  npm: $(npm --version)"

  if deps_installed && [[ "$FORCE_DEPS" -eq 0 ]]; then
    echo "[2/5] 依赖已安装，跳过（如需重装加 --force-deps）"
  else
    echo "[2/5] 安装依赖 ..."
    install_deps
  fi

  # 构建阶段：支持 --skip-build / --no-auto-build / 智能跳过
  local backend_artifact="$BACKEND_DIR/dist/index.js"
  local frontend_artifact="$FRONTEND_DIR/dist/index.html"
  if [[ "$SKIP_BUILD" -eq 1 ]]; then
    echo "[3/5] 跳过构建（--skip-build）"
  else
    local need_build=1

    if [[ "$SKIP_BUILD_AUTO" -ne 2 ]]; then
      # 智能跳过：产物新于所有源代码时跳过
      if build_up_to_date "$BACKEND_DIR" "$backend_artifact" \
         && build_up_to_date "$FRONTEND_DIR" "$frontend_artifact"; then
        need_build=0
      fi
    fi

    if [[ "$need_build" -eq 0 ]]; then
      echo "[3/5] 构建产物已是最新（源代码未修改），跳过构建"
    else
      echo "[3/5] 构建后端 ..."
      (cd "$BACKEND_DIR" && npm run build)
      echo "[3/5] 构建前端 ..."
      (cd "$FRONTEND_DIR" && npm run build)
    fi
  fi

  echo "[4/5] 检查构建产物 ..."
  if [[ ! -f "$backend_artifact" ]]; then
    echo "错误: 未找到 backend/dist/index.js，请先构建（去掉 --skip-build）" >&2
    exit 1
  fi
  echo "  产物存在: backend/dist/index.js"

  echo "[5/5] 启动服务 ..."
  # 清空旧日志
  rm -f "$BACKEND_LOG" "$BACKEND_ERR_LOG" "$FRONTEND_LOG" "$FRONTEND_ERR_LOG"

  echo "  启动后端 (PORT=$PORT) ..."
  cd "$BACKEND_DIR"
  PORT="$PORT" NODE_ENV=production ${DATABASE:+DATABASE_URL="$DATABASE"} \
    nohup node dist/index.js > "$BACKEND_LOG" 2> "$BACKEND_ERR_LOG" &
  STUB_PID=$!
  echo "  后端 stub PID: $STUB_PID (等待端口监听...)"

  # nohup 后台启动可能 PID 不准，通过端口查找真实 PID
  if ! BACKEND_PID=$(get_pid_by_port "$PORT" 6000); then
    echo "  后端启动失败（端口 $PORT 未监听），查看日志 $BACKEND_ERR_LOG" >&2
    [[ -f "$BACKEND_ERR_LOG" ]] && tail -n 20 "$BACKEND_ERR_LOG" >&2
    kill -KILL "$STUB_PID" 2>/dev/null || true
    exit 1
  fi
  if [[ "$BACKEND_PID" != "$STUB_PID" ]]; then
    echo "  真实后端 PID: $BACKEND_PID"
    kill -KILL "$STUB_PID" 2>/dev/null || true
  else
    echo "  后端 PID: $BACKEND_PID"
  fi

  echo "  启动前端 (PORT=$FRONTEND_PORT) ..."
  # 直接调用 node + vite.js，避免 npm 在 nohup 中的子进程 PID 不可控
  if ! VITE_JS=$(resolve_vite_js); then
    echo "  未找到 vite.js，前端启动失败" >&2
    echo "  回滚：停止已启动的后端 PID $BACKEND_PID ..." >&2
    stop_by_pid_or_port "$BACKEND_PID" "$PORT"
    exit 1
  fi
  echo "  vite.js: $VITE_JS"
  cd "$FRONTEND_DIR"
  NODE_ENV=production \
    nohup node "$VITE_JS" preview --port "$FRONTEND_PORT" --host > "$FRONTEND_LOG" 2> "$FRONTEND_ERR_LOG" &
  FRONTEND_STUB=$!
  echo "  前端 stub PID: $FRONTEND_STUB (等待端口监听...)"

  if ! FRONTEND_PID=$(get_pid_by_port "$FRONTEND_PORT" 8000); then
    echo "  前端启动失败（端口 $FRONTEND_PORT 未监听），查看日志 $FRONTEND_ERR_LOG" >&2
    [[ -f "$FRONTEND_ERR_LOG" ]] && tail -n 20 "$FRONTEND_ERR_LOG" >&2
    kill -KILL "$FRONTEND_STUB" 2>/dev/null || true
    echo "  回滚：停止已启动的后端 PID $BACKEND_PID ..." >&2
    stop_by_pid_or_port "$BACKEND_PID" "$PORT"
    exit 1
  fi
  if [[ "$FRONTEND_PID" != "$FRONTEND_STUB" ]]; then
    echo "  真实前端 PID: $FRONTEND_PID"
    kill -KILL "$FRONTEND_STUB" 2>/dev/null || true
  else
    echo "  前端 PID: $FRONTEND_PID"
  fi

  cat > "$PIDS_FILE" <<EOF
{
  "backend": { "pid": $BACKEND_PID, "port": $PORT, "url": "http://localhost:$PORT" },
  "frontend": { "pid": $FRONTEND_PID, "port": $FRONTEND_PORT, "url": "http://localhost:$FRONTEND_PORT" }
}
EOF

  write_title "启动完成"
  echo "  后端：http://localhost:$PORT"
  echo "  前端：http://localhost:$FRONTEND_PORT"
  echo "  PID 文件：$PIDS_FILE"
  echo "  日志：$BACKEND_LOG / $BACKEND_ERR_LOG"
  echo "        $FRONTEND_LOG / $FRONTEND_ERR_LOG"
  echo ""
}

do_stop() {
  write_title "ZViewer 生产服务停止"

  if [[ -f "$PIDS_FILE" ]]; then
    BACKEND_PID=$(read_pid backend)
    FRONTEND_PID=$(read_pid frontend)
    [[ -n "$BACKEND_PID" ]]  && stop_by_pid_or_port "$BACKEND_PID" "$PORT"
    [[ -n "$FRONTEND_PID" ]] && stop_by_pid_or_port "$FRONTEND_PID" "$FRONTEND_PORT"
    rm -f "$PIDS_FILE"
    echo "  已清理 PID 文件"
  else
    echo "  未找到 PID 文件，服务未通过本脚本启动（不按端口清理，避免误杀 dev server）"
  fi

  echo ""
  echo "服务已停止"
  echo ""
}

do_restart() {
  write_title "ZViewer 生产服务重启"
  do_stop
  sleep 1
  SKIP_BUILD=1 do_start
}

do_status() {
  write_title "ZViewer 生产服务状态"

  if [[ ! -f "$PIDS_FILE" ]]; then
    echo "  PID 文件不存在，服务未运行（或未通过本脚本启动）"
  else
    BACKEND_PID=$(read_pid backend)
    FRONTEND_PID=$(read_pid frontend)

    echo "  后端:"
    echo "    PID:   $BACKEND_PID"
    echo "    端口:  $PORT"
    echo "    URL:   http://localhost:$PORT"
    if pid_running "$BACKEND_PID"; then
      echo "    状态:  运行中"
    else
      echo "    状态:  已退出"
    fi

    echo ""
    echo "  前端:"
    echo "    PID:   $FRONTEND_PID"
    echo "    端口:  $FRONTEND_PORT"
    echo "    URL:   http://localhost:$FRONTEND_PORT"
    if pid_running "$FRONTEND_PID"; then
      echo "    状态:  运行中"
    else
      echo "    状态:  已退出"
    fi
  fi

  echo ""
  echo "  端口配置:"
  echo "    后端端口: $PORT"
  echo "    前端端口: $FRONTEND_PORT"
  if [[ -f "$PORTS_FILE" ]]; then
    echo "    配置文件: $PORTS_FILE （已持久化）"
  else
    echo "    配置文件: $PORTS_FILE （未创建，使用默认值）"
  fi

  echo ""
  echo "  端口占用检查:"
  if port_in_use "$PORT"; then
    echo "    $PORT : 占用"
  else
    echo "    $PORT : 空闲"
  fi
  if port_in_use "$FRONTEND_PORT"; then
    echo "    $FRONTEND_PORT : 占用"
  else
    echo "    $FRONTEND_PORT : 空闲"
  fi
  echo ""
}

do_logs() {
  local target="$1"
  local log_file err_file
  if [[ "$target" == "frontend" ]]; then
    log_file="$FRONTEND_LOG"
    err_file="$FRONTEND_ERR_LOG"
  else
    log_file="$BACKEND_LOG"
    err_file="$BACKEND_ERR_LOG"
    target="backend"
  fi

  write_title "ZViewer 日志 - $target"

  if [[ ! -f "$log_file" && ! -f "$err_file" ]]; then
    echo "  日志文件不存在：$log_file"
    echo "  提示：服务可能尚未启动"
    return
  fi

  if [[ -f "$err_file" ]]; then
    echo "  错误日志：$err_file"
    echo "  --- stderr（最后 20 行）---"
    tail -n 20 "$err_file" 2>/dev/null || true
  fi
  if [[ -f "$log_file" ]]; then
    echo "  标准输出：$log_file"
    echo "  --- stdout（最后 50 行）---"
    tail -n 50 "$log_file"
  fi
  echo "  ----------------------------------------"
  echo ""
  echo "  提示：实时跟踪日志请使用 tail -f $log_file"
  echo ""
}

do_port() {
  write_title "ZViewer 端口配置"

  # 非交互式环境检测
  if [[ ! -t 0 ]]; then
    echo "检测到非交互式输入，端口配置需要在交互式终端中运行。" >&2
    echo "也可通过命令行参数指定：$0 start -p 3001 --frontend-port 4180" >&2
    return 1
  fi

  local current_backend="$PORT"
  local current_frontend="$FRONTEND_PORT"

  while true; do
    echo ""
    echo "  当前端口配置："
    echo "    后端端口：$current_backend"
    echo "    前端端口：$current_frontend"
    if [[ -f "$PORTS_FILE" ]]; then
      echo "    配置文件：$PORTS_FILE （已持久化）"
    else
      echo "    配置文件：$PORTS_FILE （未创建，使用默认值）"
    fi
    echo ""
    echo "  1. 修改后端端口"
    echo "  2. 修改前端端口"
    echo "  3. 同时修改两个端口"
    echo "  4. 重置为默认值（后端 $DEFAULT_PORT，前端 $DEFAULT_FRONTEND_PORT）"
    echo "  0. 返回"

    read -r -p "请选择 [0-4]: " choice
    case "$choice" in
      1)
        local new_port
        new_port=$(read_port_input "  输入新的后端端口" "$current_backend")
        if [[ "$new_port" -eq "$current_frontend" ]]; then
          echo "  后端端口不能与前端端口 ($current_frontend) 相同" >&2
          continue
        fi
        current_backend="$new_port"
        write_ports_file "$current_backend" "$current_frontend"
        echo "  已保存：后端端口 = $current_backend"
        ;;
      2)
        local new_port
        new_port=$(read_port_input "  输入新的前端端口" "$current_frontend")
        if [[ "$new_port" -eq "$current_backend" ]]; then
          echo "  前端端口不能与后端端口 ($current_backend) 相同" >&2
          continue
        fi
        current_frontend="$new_port"
        write_ports_file "$current_backend" "$current_frontend"
        echo "  已保存：前端端口 = $current_frontend"
        ;;
      3)
        local new_backend new_frontend
        new_backend=$(read_port_input "  输入新的后端端口" "$current_backend")
        new_frontend=$(read_port_input "  输入新的前端端口" "$current_frontend")
        if [[ "$new_backend" -eq "$new_frontend" ]]; then
          echo "  后端端口与前端端口不能相同" >&2
          continue
        fi
        current_backend="$new_backend"
        current_frontend="$new_frontend"
        write_ports_file "$current_backend" "$current_frontend"
        echo "  已保存：后端 = $current_backend，前端 = $current_frontend"
        ;;
      4)
        rm -f "$PORTS_FILE"
        current_backend="$DEFAULT_PORT"
        current_frontend="$DEFAULT_FRONTEND_PORT"
        echo "  已重置为默认值：后端 = $current_backend，前端 = $current_frontend"
        ;;
      0) return 0 ;;
      "") echo "  未收到输入，退出。" >&2; return 0 ;;
      *) echo "  无效选项" ;;
    esac
  done
}

do_menu() {
  # 交互式中文菜单循环。无参数调用时进入此分支。
  # 非交互式环境（stdin 被重定向）下 read 会立即返回空，导致死循环，需检测并退出。
  if [[ ! -t 0 ]]; then
    echo "检测到非交互式输入，菜单模式需要在交互式终端中运行。" >&2
    echo "请直接运行 $0，或使用子命令：start / stop / restart / status / logs / port / help" >&2
    return 1
  fi

  while true; do
    echo ""
    echo "========================================"
    echo "  ZViewer 生产服务管理"
    echo "========================================"
    echo "  1. 启动服务"
    echo "  2. 停止服务"
    echo "  3. 重启服务"
    echo "  4. 查看状态"
    echo "  5. 查看后端日志"
    echo "  6. 查看前端日志"
    echo "  7. 修改端口配置"
    echo "  0. 退出"
    echo "========================================"
    read -r -p "请选择 [0-7]: " choice
    if [[ -z "$choice" ]]; then
      echo "未收到输入，退出菜单。"
      return 0
    fi
    case "$choice" in
      1) do_start ;;
      2) do_stop ;;
      3) do_restart ;;
      4) do_status ;;
      5) do_logs backend ;;
      6) do_logs frontend ;;
      7) do_port ;;
      0) return 0 ;;
      *) echo "无效选项，请重新选择"; sleep 1 ;;
    esac
    if [[ "$choice" =~ ^[1-7]$ ]]; then
      echo ""
      read -r -p "按 Enter 返回菜单..." _
    fi
  done
}

# ============ 端口优先级解析 ============

# 端口优先级：命令行参数 > .prod.ports.json 配置文件 > 默认值
# 在进入子命令前统一解析（port/menu 除外，它们自己管理配置文件）
if [[ "$COMMAND" != "port" && "$COMMAND" != "menu" ]]; then
  saved_ports=$(read_ports_file || true)
  if [[ -n "$saved_ports" ]]; then
    saved_backend=$(echo "$saved_ports" | awk '{print $1}')
    saved_frontend=$(echo "$saved_ports" | awk '{print $2}')
    if [[ "$PORT_CLI_SET" -eq 0 ]]; then PORT="$saved_backend"; fi
    if [[ "$FRONTEND_PORT_CLI_SET" -eq 0 ]]; then FRONTEND_PORT="$saved_frontend"; fi
  fi
fi

# 兜底设置默认值
[[ -z "$PORT" ]] && PORT="$DEFAULT_PORT"
[[ -z "$FRONTEND_PORT" ]] && FRONTEND_PORT="$DEFAULT_FRONTEND_PORT"

# ============ 主入口 ============

case "$COMMAND" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs "$LOG_TARGET" ;;
  port)    do_port ;;
  menu)    do_menu ;;
  *)       usage ;;
esac
