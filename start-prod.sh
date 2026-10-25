#!/usr/bin/env bash
set -euo pipefail

# ZViewer 一键启动脚本
# 命令：start | backend | stop | restart | status | logs | build | help

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 后端已迁到 Go（backend-go/）；产物统一由 scripts/build-backend.js 产出到 dist/。
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_BIN="$ROOT_DIR/dist/zviewer-backend"
case "${OSTYPE:-}" in
  msys*|cygwin*|win32) BACKEND_BIN="$BACKEND_BIN.exe" ;;
esac
LOG_DIR="$ROOT_DIR/log"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"

BACKEND_PORT="${BACKEND_PORT:-}"
BACKEND_ONLY=0
DO_BUILD=0
HTTPS_MODE=0

# ==================== 工具函数 ====================

# 端口解析：统一端口，前后端共用同一端口（默认 3333），由后端托管前端静态文件
set_ports() {
  if [[ -z "$BACKEND_PORT" ]]; then
    local env_port=""
    if [[ -f "$ROOT_DIR/.env" ]]; then
      env_port=$(grep -E '^PORT=' "$ROOT_DIR/.env" | head -n 1 | cut -d= -f2- | tr -d '"' | xargs)
    fi
    if [[ -n "$env_port" ]]; then
      BACKEND_PORT="$env_port"
    else
      BACKEND_PORT=3333
    fi
  fi
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -i:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

kill_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    local pids
    pids=$(lsof -ti:"$port" 2>/dev/null || true)
    [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    local pids
    pids=$(ss -lptn "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
    [[ -n "$pids" ]] && kill $pids 2>/dev/null || true
  fi
}

# 等待端口开始监听（后端初始化需要数秒，避免前端先就绪后页面请求被拒）
wait_port_ready() {
  local port="$1"
  local timeout="${2:-30}"
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if port_in_use "$port"; then
      return 0
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  return 1
}

deps_ok() {
  # 与 start-prod.ps1 保持一致：只检查构建期真正需要的东西。
  # 后端是 Go，node_modules 里只需要 vite / typescript（前端构建）。
  [[ -d "$ROOT_DIR/node_modules" ]] \
    && [[ -d "$ROOT_DIR/node_modules/vite" ]] \
    && [[ -d "$ROOT_DIR/node_modules/typescript" ]]
}

install_deps() {
  if deps_ok; then
    echo "  依赖已安装"
    return
  fi
  echo "  安装依赖..."
  (cd "$ROOT_DIR" && npm ci --no-audit --no-fund --prefer-offline --include=dev) || \
  (cd "$ROOT_DIR" && npm install --no-audit --no-fund --include=dev)
}

build() {
  echo "  构建后端（Go）..."
  if ! command -v go >/dev/null 2>&1; then
    echo "  错误：找不到 go 命令，请先安装 Go 工具链（后端已迁移到 Go）" >&2
    exit 1
  fi
  node "$ROOT_DIR/scripts/build-backend.js" || exit 1
  echo "  构建前端..."
  (cd "$FRONTEND_DIR" && npm run build)
  echo "  构建完成"
}

# ==================== 命令 ====================

cmd_start() {
  set_ports

  echo "========================================"
  echo "  ZViewer 启动"
  echo "  端口: $BACKEND_PORT"
  if [[ "$HTTPS_MODE" -eq 1 ]]; then
    echo "  模式: HTTPS（自签/可信证书）"
  elif [[ "$BACKEND_ONLY" -eq 1 ]]; then
    echo "  模式: 仅后端（不校验前端产物）"
  else
    echo "  模式: HTTP（后端统一提供 API + 前端静态文件）"
  fi
  echo "========================================"

  if port_in_use "$BACKEND_PORT"; then
    echo "  错误：端口 $BACKEND_PORT 已被占用" >&2
    exit 1
  fi

  install_deps

  if [[ "$DO_BUILD" -eq 1 ]]; then
    build
  else
    echo "  跳过构建（如需构建请加 --build）"
  fi

  if [[ ! -f "$BACKEND_BIN" ]]; then
    echo "  错误：后端构建产物缺失: $BACKEND_BIN（先跑 build 或加 --build）" >&2
    exit 1
  fi
  # 后端统一托管前端静态文件，需 frontend/dist 存在；BackendOnly 模式跳过此检查
  if [[ "$BACKEND_ONLY" -eq 0 ]]; then
    local frontend_artifact="$FRONTEND_DIR/dist/index.html"
    if [[ ! -f "$frontend_artifact" ]]; then
      echo "  错误：前端构建产物缺失: $frontend_artifact" >&2
      exit 1
    fi
  fi

  # HTTPS 模式：生成自签证书
  if [[ "$HTTPS_MODE" -eq 1 ]]; then
    echo "  生成自签 SSL 证书..."
    if ! (cd "$ROOT_DIR" && "$BACKEND_BIN" --gen-cert); then
      echo "  SSL 证书生成失败" >&2
      exit 1
    fi
  fi

  mkdir -p "$LOG_DIR"

  # 启动前清空旧日志，避免混叠
  : > "$LOG_DIR/backend.log"

  echo "  启动后端..."
  # 在仓库根启动：Go 版按「当前目录向上找 frontend + backend-go」定位项目根，
  # 从 dist/ 里启动也能找到，但显式给 PROJECT_ROOT 少一层猜测。
  pushd "$ROOT_DIR" >/dev/null
  PORT="$BACKEND_PORT"     PROJECT_ROOT="$ROOT_DIR"     HTTPS="$([[ "$HTTPS_MODE" -eq 1 ]] && echo "true" || echo "")"     nohup "$BACKEND_BIN" > "$LOG_DIR/backend.log" 2>&1 &
  local backend_pid=$!
  popd >/dev/null

  # 等待后端就绪（数据库结构校验 + 各服务启动需要数秒）
  echo "  等待后端就绪..."
  if ! wait_port_ready "$BACKEND_PORT"; then
    echo "  错误：后端在 30 秒内未就绪，请检查日志: $LOG_DIR/backend.log" >&2
    kill "$backend_pid" 2>/dev/null || true
    return 1
  fi

  node -e "
    const fs = require('fs');
    fs.writeFileSync('$PIDS_FILE', JSON.stringify({
      backend: { pid: $backend_pid },
      frontend: null
    }, null, 2));
  "

  echo "  后端 PID: $backend_pid"
  if [[ "$HTTPS_MODE" -eq 1 ]]; then
    echo "  访问  : https://localhost:$BACKEND_PORT"
  else
    echo "  访问  : http://localhost:$BACKEND_PORT"
  fi
  echo "  日志  : $LOG_DIR/"
}

cmd_build() {
  install_deps
  build
}

cmd_stop() {
  set_ports
  if [[ -f "$PIDS_FILE" ]]; then
    local backend_pid frontend_pid
    backend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).backend.pid||'')}catch{}" 2>/dev/null || true)
    frontend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).frontend?.pid||'')}catch{}" 2>/dev/null || true)
    [[ -n "$backend_pid" ]] && kill "$backend_pid" 2>/dev/null || true
    # 兼容旧版 pids 文件中可能记录的前端进程
    [[ -n "$frontend_pid" ]] && kill "$frontend_pid" 2>/dev/null || true
    rm -f "$PIDS_FILE"
  fi
  pkill -f "zviewer-backend" 2>/dev/null || true
  # 兜底：按统一端口清理（含历史遗留的 vite preview 进程）
  pkill -f "vite preview" 2>/dev/null || true
  kill_port "$BACKEND_PORT"
  echo "  已停止"
}

cmd_restart() {
  cmd_stop || true
  cmd_start
}

cmd_status() {
  set_ports
  if [[ -f "$PIDS_FILE" ]]; then
    local backend_pid
    backend_pid=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PIDS_FILE','utf8')).backend.pid||'')}catch{}" 2>/dev/null || true)
    echo "  后端 PID: $backend_pid (端口 $BACKEND_PORT)"
  else
    echo "  未运行"
  fi

  local frontend_artifact="$FRONTEND_DIR/dist/index.html"
  echo "  构建产物:"
  echo "    后端: $([[ -f "$BACKEND_BIN" ]] && echo '存在' || echo '缺失')  ($BACKEND_BIN)"
  echo "    前端: $([[ -f "$frontend_artifact" ]] && echo '存在' || echo '缺失')"
}

cmd_logs() {
  # 统一端口后仅保留后端日志（前端静态文件由后端托管，无独立日志）
  tail -f "$LOG_DIR/backend.log"
}

# ==================== 证书 ====================

# 交互选择证书签发类型（localhost / 公网域名）
select_cert_host() {
  echo ""
  echo "  请选择证书签发类型："
  echo "    [1] localhost（本机访问，默认，自签证书）"
  echo "    [2] 公网域名或公网 IP（自动申请 Let's Encrypt 可信证书）"
  echo "        - 域名：需已解析到本机，且 80 端口可访问（ACME HTTP-01 验证）"
  echo "        - 公网 IP：Let's Encrypt 已支持（2026-01 GA），证书约 6 天有效，到期需重新签发"
  echo "        - 内网 IP 无法通过 ACME 验证，请选 1 使用自签证书"
  printf "  请输入 1 或 2（直接回车默认 1）: "
  read CERT_CHOICE
  if [ "$CERT_CHOICE" = "2" ]; then
    printf "  请输入公网域名或公网 IP 地址: "
    read CERT_HOST
    CERT_HOST=$(echo "$CERT_HOST" | tr -d ' ')
    if [ -z "$CERT_HOST" ]; then
      echo "  [提示] 未输入地址，将使用 localhost（自签）"
      CERT_HOST="localhost"
    elif [ "$CERT_HOST" = "localhost" ]; then
      echo "  [提示] localhost 请选 1 使用自签证书"
      CERT_HOST="localhost"
    elif is_private_ip "$CERT_HOST"; then
      echo "  [提示] '$CERT_HOST' 是内网地址，Let's Encrypt 无法验证，将使用自签证书。"
      echo "         公网域名或公网 IP 才能申请可信证书。"
      CERT_HOST="localhost"
    else
      echo ""
      echo "  [提示] 正在为 $CERT_HOST 自动申请 Let's Encrypt 可信证书..."
      echo "         公网 IP 证书有效期约 6 天，到期后请重新签发。"
    fi
  else
    CERT_HOST="localhost"
  fi
}

# 判断是否为内网/保留 IP 地址（IPv4 常见私网段 + IPv6 环回/链路本地）
is_private_ip() {
  case "$1" in
    10.*|127.*|192.168.*) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    169.254.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) return 0 ;;
    ::1|fe80:*) return 0 ;;
  esac
  return 1
}

# 一键签发证书：交互选择类型后调用 scripts/generate-cert.js
do_cert() {
  local cert_script="$ROOT_DIR/scripts/generate-cert.js"
  if [[ ! -f "$cert_script" ]]; then
    echo "  [错误] 证书生成脚本缺失: $cert_script" >&2
    return 1
  fi
  select_cert_host
  echo "  [证书] 签发类型: $CERT_HOST"
  node "$cert_script" "$CERT_HOST"
  local rc=$?
  echo ""
  if [[ $rc -ne 0 ]]; then
    echo "  [证书] 签发失败（退出码 $rc）" >&2
    return 1
  fi
  echo "  [证书] 签发完成，证书位于 config/ssl/"
  return 0
}

# HTTPS 启动：交互选择证书类型 → 签发 → 以 HTTPS 启动（后端 HTTPS，统一端口托管前端）
do_https() {
  local cert_script="$ROOT_DIR/scripts/generate-cert.js"
  if [[ ! -f "$cert_script" ]]; then
    echo "  [错误] 证书生成脚本缺失: $cert_script" >&2
    return 1
  fi
  select_cert_host
  echo "  [证书] 签发类型: $CERT_HOST"
  node "$cert_script" "$CERT_HOST"
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "  [证书] 签发失败，HTTPS 启动中止" >&2
    return 1
  fi
  HTTPS_MODE=1
  cmd_start
  return 0
}

usage() {
  cat <<EOF
用法: $0 {start|backend|cert|https|stop|restart|status|logs|build|menu|help} [选项]

命令:
  start              安装依赖后直接启动（默认不构建）
  backend            仅启动后端（加 --https 使用 HTTPS）
  build              单独构建前后端
  stop               停止服务
  restart            重启服务
  status             查看运行状态
  logs               查看后端日志
  cert               一键签发 SSL 证书（localhost / 公网域名或公网 IP(Let's Encrypt)）
  https              签发证书后以 HTTPS 启动
  menu               交互菜单（无参数时自动进入）
  help               显示此帮助

start/restart/backend 选项:
      --build             启动前执行构建
      --https             使用 HTTPS

端口: 默认取 .env 的 PORT（否则 3333），前后端共用同一端口
EOF
}

# ==================== 交互菜单 ====================

do_menu() {
  while true; do
    clear 2>/dev/null || true
    echo "========================================"
    echo "  ZViewer 生产服务管理"
    echo "========================================"
    echo ""
    echo "  1) 启动服务"
    echo "  2) 仅启动后端"
    echo "  3) 停止服务"
    echo "  4) 重启服务"
    echo "  5) 查看状态"
    echo "  6) 查看日志"
    echo "  7) 构建前后端"
    echo "  8) 一键签发 SSL 证书"
    echo "  9) HTTPS 启动（自动签发证书）"
    echo "  0) 退出"
    echo ""
    printf "请输入编号 (0-9): "
    read CHOICE
    case "$CHOICE" in
      1) BACKEND_ONLY=0; HTTPS_MODE=0; cmd_start; wait_key ;;
      2) BACKEND_ONLY=1
        printf "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP): "
        read BO_CHOICE
        if [ "$BO_CHOICE" = "2" ]; then HTTPS_MODE=1; else HTTPS_MODE=0; fi
        cmd_start; wait_key ;;
      3) cmd_stop; wait_key ;;
      4) cmd_restart; wait_key ;;
      5) cmd_status; wait_key ;;
      6) cmd_logs; wait_key ;;
      7) cmd_build; wait_key ;;
      8) do_cert; wait_key ;;
      9) do_https; wait_key ;;
      0) return 0 ;;
      *) echo "  无效输入，请重新选择"; sleep 1 ;;
    esac
  done
}

wait_key() {
  echo ""
  printf "按回车返回菜单: "
  read _DUMMY
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --build) DO_BUILD=1; shift ;;
      --https) HTTPS_MODE=1; shift ;;
      *) echo "  未知参数: $1" >&2; usage; exit 1 ;;
    esac
  done
}

# ==================== 入口 ====================

main() {
  local cmd="${1:-menu}"
  shift || true

  case "$cmd" in
    start)
      parse_args "$@"
      cmd_start
      ;;
    backend)
      parse_args "$@"
      BACKEND_ONLY=1
      cmd_start
      ;;
    build)
      cmd_build
      ;;
    stop)
      cmd_stop
      ;;
    restart)
      parse_args "$@"
      cmd_restart
      ;;
    status)
      cmd_status
      ;;
    logs)
      cmd_logs "$1"
      ;;
    cert)
      do_cert
      ;;
    https)
      do_https
      ;;
    menu)
      do_menu
      ;;
    help|--help|-h|*)
      usage
      ;;
  esac
}

main "$@"
