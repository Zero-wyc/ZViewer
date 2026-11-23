#!/bin/sh
# ZViewer 一键启动脚本（单文件 exe 版，Linux）
# 命令：start | stop | restart | status | logs | cert | https | help | menu
# 无参数时进入交互菜单。
#
# 统一端口：前后端共用同一端口（默认 3333），由后端 exe 托管 frontend/dist 静态文件，
# 无需独立的前端 exe。
#
# 网页端：Linux 没有 Wails 桌面壳，由独立进程 zviewer-webgui 提供网页控制台
# （默认端口 3332）。它与后端解耦 —— 后端没启动时网页端也能打开。
# 没有 zviewer-webgui 时脚本行为与旧版完全一致。

cd "$(dirname "$0")" || exit 1

ROOT_DIR=$(pwd)
BACKEND_BIN="$ROOT_DIR/zviewer-backend"
# 网页控制台（Linux 没有 Wails 桌面壳，用独立进程提供网页端）。
# 与后端解耦：后端没启动时网页端也能打开，只是功能不可用。
WEBGUI_BIN="$ROOT_DIR/zviewer-webgui"
LOG_DIR="$ROOT_DIR/log"
WEBGUI_LOG="$LOG_DIR/webgui.log"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"
ENV_FILE="$ROOT_DIR/.env"

DEFAULT_PORT=3333
DEFAULT_RTMP_PORT=3334
DEFAULT_FLV_PORT=3335
DEFAULT_WEBGUI_PORT=3332
WEBGUI_PORT=""
BACKEND_PORT="${BACKEND_PORT:-}"
BACKEND_ONLY=0
HTTPS_MODE=0
CERT_HOST=""
CERT_FORCE=""

# ==================== 工具函数 ====================

# 从 .env / 环境变量读取端口，优先级：环境变量 > .env > 默认值
# 统一端口 PORT（默认 3333）、RTMP/HTTP-FLV（默认 3334/3335）
env_port_value() {
  local key="$1"
  local default="$2"
  local val="${!key:-}"
  if [ -z "$val" ] && [ -f "$ENV_FILE" ]; then
    val=$(grep -E "^${key}=" "$ENV_FILE" | head -n 1 | cut -d= -f2- | tr -d '"' | xargs)
  fi
  if [ -z "$val" ]; then
    val="$default"
  fi
  echo "$val"
}

resolve_ports() {
  if [ -z "$BACKEND_PORT" ]; then
    BACKEND_PORT="$(env_port_value PORT "$DEFAULT_PORT")"
  fi
  RTMP_PORT="$(env_port_value RTMP_PORT "$DEFAULT_RTMP_PORT")"
  HTTP_FLV_PORT="$(env_port_value HTTP_FLV_PORT "$DEFAULT_FLV_PORT")"
}

# 网页端端口：环境变量 ZVIEWER_WEB_PORT > .env 的 WEBGUI_PORT > 3332
resolve_webgui_port() {
  if [ -n "$WEBGUI_PORT" ]; then return; fi
  WEBGUI_PORT="${ZVIEWER_WEB_PORT:-}"
  if [ -z "$WEBGUI_PORT" ]; then
    WEBGUI_PORT="$(env_port_value WEBGUI_PORT "$DEFAULT_WEBGUI_PORT")"
  fi
}

# $1=backend_pid（可空） $2=webgui_pid（可空）
write_pids() {
  local backend_json="null" webgui_json="null"
  if [ -n "$1" ]; then backend_json="{\"pid\":$1}"; fi
  if [ -n "$2" ]; then webgui_json="{\"pid\":$2}"; fi
  printf '{"backend":%s,"frontend":null,"webgui":%s}\n' "$backend_json" "$webgui_json" > "$PIDS_FILE"
}

read_pid() { # $1=backend|frontend
  [ -f "$PIDS_FILE" ] || return 1
  sed -n "s/.*\"$1\":{\"pid\":\([0-9][0-9]*\).*/\1/p" "$PIDS_FILE" | head -n 1
}

port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -lnt "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

# 等待端口开始监听（后端初始化需要数秒）
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

kill_port() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | xargs -r kill 2>/dev/null
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "$port/tcp" >/dev/null 2>&1
  fi
}

has_exe() {
  if [ ! -f "$1" ]; then
    echo "  [错误] 未找到 $2 : $1"
    echo "         请先运行 build-all 编译（含单文件可执行程序）"
    return 1
  fi
  return 0
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

issue_cert() {
  # 返回码由 $CERT_RC 携带
  if ! has_exe "$BACKEND_BIN" "后端程序 zviewer-backend"; then CERT_RC=1; return; fi
  echo "  [证书] 签发类型: $CERT_HOST"
  if [ -n "$CERT_FORCE" ]; then
    "$BACKEND_BIN" --gen-cert "$CERT_HOST" --force
  else
    "$BACKEND_BIN" --gen-cert "$CERT_HOST"
  fi
  CERT_RC=$?
}

do_cert() {
  if [ -z "$CERT_HOST" ]; then
    select_cert_host
  fi
  issue_cert
  echo ""
  if [ "$CERT_RC" -ne 0 ]; then
    echo "  [证书] 签发失败（退出码 $CERT_RC）"
    return 1
  fi
  echo "  [证书] 签发完成，证书位于 config/ssl/"
  return 0
}

# ==================== 启动 ====================

# 取第一个非回环 IPv4，用于打印局域网访问地址；取不到时输出空串。
lan_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -v '^127\.' | head -n 1)
  fi
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip=$(ip -4 addr show 2>/dev/null | sed -n 's/.*inet \([0-9.]*\).*/\1/p' | grep -v '^127\.' | head -n 1)
  fi
  echo "$ip"
}

# 打印网页端地址（本机 + 局域网）。WEBGUI_PORT 需已解析。
# 登录用 ZViewer 的超级管理员账号（数据库 user 表中 role=root 的账号）；
# 数据库还没初始化时（后端从未跑过）用 root / root 兜底。
print_webgui_urls() {
  local ip
  echo ""
  echo "  GUI 网页端：http://localhost:$WEBGUI_PORT"
  ip=$(lan_ip)
  if [ -n "$ip" ]; then
    echo "  局域网访问：http://$ip:$WEBGUI_PORT"
  fi
  if [ -f "$ROOT_DIR/config/dev.sqlite" ]; then
    echo "  登录账号：ZViewer 超级管理员（与后台是同一个账号）"
  else
    echo "  登录账号：数据库尚未初始化，首次请用 root / root"
  fi
}

# 启动后端进程。成功时把 PID 写入 BACKEND_PID。
# 返回 0=成功 1=失败（可继续启动网页端） 2=中止（HTTPS 证书失败）
start_backend() {
  BACKEND_PID=""
  if ! has_exe "$BACKEND_BIN" "后端程序 zviewer-backend"; then return 1; fi

  if port_in_use "$BACKEND_PORT"; then
    echo "  [错误] 端口 $BACKEND_PORT 已被占用"
    return 1
  fi

  # 后端统一托管前端静态文件，需 frontend/dist 存在；BackendOnly 模式跳过此检查
  if [ "$BACKEND_ONLY" -ne 1 ]; then
    if [ ! -f "$ROOT_DIR/frontend/dist/index.html" ]; then
      echo "  [错误] 前端构建产物缺失: $ROOT_DIR/frontend/dist/index.html"
      return 1
    fi
  fi

  # HTTPS 模式：先签发证书（后端启动时也会在证书缺失时自动补签，
  # 此处提前签发以支持 host / --force 参数）
  if [ "$HTTPS_MODE" -eq 1 ]; then
    if [ -z "$CERT_HOST" ]; then
      select_cert_host
    fi
    issue_cert
    if [ "$CERT_RC" -ne 0 ]; then
      echo "  [证书] 签发失败，HTTPS 启动中止"
      return 2
    fi
  fi

  mkdir -p "$LOG_DIR"
  : > "$LOG_DIR/backend.log"
  : > "$LOG_DIR/backend.err.log"

  echo "  启动后端..."
  if [ "$HTTPS_MODE" -eq 1 ]; then
    PORT="$BACKEND_PORT" RTMP_PORT="$RTMP_PORT" HTTP_FLV_PORT="$HTTP_FLV_PORT" HTTPS=true \
      nohup "$BACKEND_BIN" >> "$LOG_DIR/backend.log" 2>> "$LOG_DIR/backend.err.log" &
  else
    PORT="$BACKEND_PORT" RTMP_PORT="$RTMP_PORT" HTTP_FLV_PORT="$HTTP_FLV_PORT" \
      nohup "$BACKEND_BIN" >> "$LOG_DIR/backend.log" 2>> "$LOG_DIR/backend.err.log" &
  fi
  local_backend_pid=$!

  # 等待后端就绪（数据库结构校验 + 各服务启动需要数秒）
  echo "  等待后端就绪..."
  if ! wait_port_ready "$BACKEND_PORT"; then
    echo "  错误：后端在 30 秒内未就绪，请检查日志: $LOG_DIR/backend.err.log" >&2
    kill "$local_backend_pid" 2>/dev/null || true
    return 1
  fi

  BACKEND_PID="$local_backend_pid"
  echo "  后端 PID: $BACKEND_PID"
  if [ "$HTTPS_MODE" -eq 1 ]; then
    echo "  访问  : https://localhost:$BACKEND_PORT"
  else
    echo "  访问  : http://localhost:$BACKEND_PORT"
  fi
  return 0
}

# 启动网页控制台（zviewer-webgui）。成功/已运行返回 0，未安装或启动失败返回 1。
# 注意：没有该二进制时保持旧版行为 —— 不启动、不报错。
start_webgui() {
  WEBGUI_PID=""
  if [ ! -f "$WEBGUI_BIN" ]; then
    return 1
  fi

  if port_in_use "$WEBGUI_PORT"; then
    echo "  [网页端] 端口 $WEBGUI_PORT 已被占用，跳过启动（可能已有网页端在运行）"
    print_webgui_urls
    return 1
  fi

  mkdir -p "$LOG_DIR"
  [ -x "$WEBGUI_BIN" ] || chmod +x "$WEBGUI_BIN" 2>/dev/null || true

  echo "  启动网页端..."
  nohup "$WEBGUI_BIN" --root "$PWD" --state-dir "$PWD/profile" --port "$WEBGUI_PORT" --bind 0.0.0.0 >> "$WEBGUI_LOG" 2>&1 &
  WEBGUI_PID=$!

  # 网页端只是静态壳 + 代理，通常 1-2 秒就绪；60 * 0.5s ≈ 30s 上限
  echo "  等待网页端就绪..."
  if wait_port_ready "$WEBGUI_PORT" 60; then
    print_webgui_urls
    echo "  网页端 PID: $WEBGUI_PID"
    echo "  网页端日志: $WEBGUI_LOG"
    return 0
  fi

  echo "  GUI 网页端启动失败，请查看 $WEBGUI_LOG" >&2
  echo "  （后端仍可用，不影响后端功能）"
  return 1
}

do_start() {
  resolve_ports
  resolve_webgui_port
  echo "========================================"
  echo "  ZViewer 启动"
  echo "  端口: $BACKEND_PORT"
  if [ "$HTTPS_MODE" -eq 1 ]; then
    echo "  模式: HTTPS（可信/自签证书）"
  elif [ "$BACKEND_ONLY" -eq 1 ]; then
    echo "  模式: 仅后端（不校验前端产物）"
  else
    echo "  模式: HTTP（后端统一提供 API + 前端静态文件）"
  fi
  if [ -f "$WEBGUI_BIN" ]; then
    echo "  网页端: 端口 $WEBGUI_PORT（独立进程，后端未启动也可访问）"
  fi
  echo "========================================"

  # 1) 后端：失败不中止 —— 网页端与后端解耦，仍会继续尝试启动
  local backend_rc=0
  start_backend || backend_rc=$?
  if [ "$backend_rc" -eq 2 ]; then
    return 1
  fi
  if [ "$backend_rc" -ne 0 ]; then
    echo "  [提示] 后端未启动，网页端仍可打开（部分功能不可用）"
  fi

  # 2) 网页端
  local webgui_rc=0
  start_webgui || webgui_rc=$?

  # 3) 记录 PID（至少启动了一个才写，保持旧版无 pids 文件的行为）
  if [ -n "$BACKEND_PID" ] || [ -n "$WEBGUI_PID" ]; then
    write_pids "$BACKEND_PID" "$WEBGUI_PID"
  fi

  if [ -n "$BACKEND_PID" ]; then
    echo "  日志  : $LOG_DIR/"
  fi

  if [ "$backend_rc" -ne 0 ] && [ "$webgui_rc" -ne 0 ]; then
    return 1
  fi
  return 0
}

# ==================== 停止 / 重启 / 状态 / 日志 ====================

do_stop() {
  local bp fp wp
  resolve_webgui_port
  # 先停网页端（独立进程，不依赖后端）
  wp=$(read_pid webgui)
  [ -n "$wp" ] && kill "$wp" 2>/dev/null
  kill_port "$WEBGUI_PORT"

  bp=$(read_pid backend)
  fp=$(read_pid frontend)
  [ -n "$bp" ] && kill "$bp" 2>/dev/null
  # 兼容旧版 pids 文件中可能记录的前端进程
  [ -n "$fp" ] && kill "$fp" 2>/dev/null
  rm -f "$PIDS_FILE"
  resolve_ports
  kill_port "$BACKEND_PORT"
  echo "  已停止"
}

do_restart() {
  do_stop
  sleep 1
  do_start
}

do_status() {
  echo "========================================"
  echo "  ZViewer 运行状态"
  echo "========================================"
  resolve_ports
  local bp backend_running
  bp=$(read_pid backend)
  backend_running="否"
  if [ -n "$bp" ] && kill -0 "$bp" 2>/dev/null; then backend_running="是"; fi

  local wp webgui_running
  resolve_webgui_port
  wp=$(read_pid webgui)
  webgui_running="否"
  if [ -n "$wp" ] && kill -0 "$wp" 2>/dev/null; then webgui_running="是"; fi

  echo "  服务:"
  echo "    配置端口: $BACKEND_PORT"
  echo "    端口监听: $(if port_in_use "$BACKEND_PORT"; then echo 是; else echo 否; fi)"
  if [ -n "$bp" ]; then
    echo "    记录 PID: $bp ($(if [ "$backend_running" = "是" ]; then echo 运行中; else echo 未运行; fi))"
  fi

  if [ -f "$WEBGUI_BIN" ]; then
    echo "  网页端:"
    echo "    配置端口: $WEBGUI_PORT"
    echo "    端口监听: $(if port_in_use "$WEBGUI_PORT"; then echo 是; else echo 否; fi)"
    echo "    运行状态: $webgui_running"
    if [ -n "$wp" ]; then
      echo "    记录 PID: $wp ($(if [ "$webgui_running" = "是" ]; then echo 运行中; else echo 未运行; fi))"
    fi
    echo "    地址: http://localhost:$WEBGUI_PORT"
    if [ -f "$ROOT_DIR/config/dev.sqlite" ]; then
      echo "    登录账号: ZViewer 超级管理员（与后台同一个账号）"
    else
      echo "    登录账号: 数据库尚未初始化，root / root"
    fi
  else
    echo "  网页端: 未安装（zviewer-webgui 缺失）"
  fi

  echo "  程序:"
  echo "    后端: $(if [ -f "$BACKEND_BIN" ]; then echo 存在; else echo 缺失; fi)"
  echo "    网页端: $(if [ -f "$WEBGUI_BIN" ]; then echo 存在; else echo 缺失; fi)"
  echo "    前端: $(if [ -f "$ROOT_DIR/frontend/dist/index.html" ]; then echo 存在; else echo 缺失; fi)"
  echo "    证书: $(if [ -f "$ROOT_DIR/config/ssl/cert.pem" ]; then echo 存在; else echo 缺失; fi)"
}

do_logs() {
  # $1: backend（默认）| webgui | all
  # 统一端口后前端静态文件由后端托管，无独立前端日志；网页端有自己的 webgui.log。
  local which="${1:-backend}"
  local log_file
  case "$which" in
    webgui|all)
      if [ "$which" = "all" ] && [ -f "$LOG_DIR/backend.log" ]; then
        echo "===== backend.log ====="
        tail -n 50 "$LOG_DIR/backend.log"
        echo ""
      fi
      log_file="$WEBGUI_LOG"
      if [ -f "$log_file" ]; then
        echo "===== webgui.log ====="
        tail -n 50 "$log_file"
      else
        echo "  日志不存在: $log_file"
      fi
      ;;
    *)
      log_file="$LOG_DIR/backend.log"
      if [ -f "$log_file" ]; then
        tail -n 50 "$log_file"
      else
        echo "  日志不存在: $log_file"
      fi
      ;;
  esac
}

# ==================== 帮助 / 菜单 ====================

usage() {
  cat <<EOF
用法: $0 {start|backend|stop|restart|status|logs|cert|https|help|menu} [选项]

命令:
  start              启动服务（加 --https 使用 HTTPS）
  backend            仅启动后端（加 --https 使用 HTTPS）
  stop               停止服务（含网页端）
  restart            重启服务
  status             查看运行状态
  logs [类型]        查看日志：backend（默认）| webgui | all
  cert [host]        一键签发 SSL 证书（localhost / 公网域名或公网 IP(Let's Encrypt)）
  https [host]       签发证书后以 HTTPS 启动
  help               显示此帮助
  menu               交互菜单（无参数时自动进入）

start/restart/cert/https 选项:
      --https              start 时使用 HTTPS
      --force              证书强制重新签发

端口: 后端默认取 .env 的 PORT（否则 3333），前后端共用同一端口
      网页端默认 3332（环境变量 ZVIEWER_WEB_PORT > .env 的 WEBGUI_PORT > 3332）
      网页端（zviewer-webgui）与后端解耦：后端没启动也能打开

示例:
  ./start.sh                    # 交互菜单
  ./start.sh start              # HTTP 启动
  ./start.sh backend            # 仅启动后端
  ./start.sh logs webgui        # 查看网页端日志
  ./start.sh https example.com  # 申请 Let's Encrypt 证书后 HTTPS 启动
  ./start.sh cert example.com --force  # 为公网域名或公网 IP 强制重新签发 Let's Encrypt 证书
EOF
}

do_menu() {
  while true; do
    clear 2>/dev/null || true
    echo "========================================"
    echo "  ZViewer 服务管理（单文件版）"
    echo "========================================"
    echo ""
    echo "  1) 启动服务"
    echo "  2) 仅启动后端"
    echo "  3) 停止服务"
    echo "  4) 重启服务"
    echo "  5) 查看状态"
    echo "  6) 查看日志"
    echo "  7) 一键签发 SSL 证书"
    echo "  8) HTTPS 启动（自动签发证书）"
    echo "  9) 查看网页端日志"
    echo "  0) 退出"
    echo ""
    printf "  请输入编号 (0-9): "
    read CHOICE
    case "$CHOICE" in
      1) BACKEND_ONLY=0; HTTPS_MODE=0; do_start; wait_key ;;
      2) BACKEND_ONLY=1
        printf "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP): "
        read BO_CHOICE
        if [ "$BO_CHOICE" = "2" ]; then HTTPS_MODE=1; else HTTPS_MODE=0; fi
        do_start; wait_key ;;
      3) do_stop; wait_key ;;
      4) do_restart; wait_key ;;
      5) do_status; wait_key ;;
      6) do_logs; wait_key ;;
      7) do_cert; wait_key ;;
      8) BACKEND_ONLY=0; HTTPS_MODE=1; do_start; wait_key ;;
      9) do_logs webgui; wait_key ;;
      0) return 0 ;;
      *) echo "  无效输入，请重新选择"; sleep 1 ;;
    esac
  done
}

wait_key() {
  echo ""
  printf "  按回车返回菜单: "
  read _DUMMY
}

# ==================== 参数解析 ====================

# start/https 参数：--https/--force/host
parse_start_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --https) HTTPS_MODE=1; shift ;;
      --force) CERT_FORCE="--force"; shift ;;
      *)
        if [ -z "$CERT_HOST" ]; then
          CERT_HOST="$1"; shift
        else
          echo "  未知参数: $1" >&2
          exit 1
        fi
        ;;
    esac
  done
}

# cert 参数：host / --force
parse_cert_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --force|-f) CERT_FORCE="--force"; shift ;;
      *) CERT_HOST="$1"; shift ;;
    esac
  done
}

# ==================== 入口 ====================

CMD="${1:-menu}"
case "$CMD" in
  start)
    shift
    parse_start_args "$@"
    do_start
    ;;
  backend)
    shift
    parse_start_args "$@"
    BACKEND_ONLY=1
    do_start
    ;;
  stop)
    do_stop
    ;;
  restart)
    shift
    parse_start_args "$@"
    do_restart
    ;;
  status)
    do_status
    ;;
  logs)
    shift
    do_logs "$@"
    ;;
  cert)
    shift
    parse_cert_args "$@"
    do_cert
    ;;
  https)
    shift
    HTTPS_MODE=1
    parse_start_args "$@"
    do_start
    ;;
  help|--help|-h)
    usage
    ;;
  menu)
    do_menu
    ;;
  *)
    usage
    ;;
esac

exit 0
