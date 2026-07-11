#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS_FILE="$ROOT_DIR/.prod.pids.json"
PORT=3000
FRONTEND_PORT=4173

usage() {
  echo "用法: $0 [-p PORT] [--frontend-port FRONTEND_PORT]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--port) PORT="$2"; shift 2 ;;
    --frontend-port) FRONTEND_PORT="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; usage ;;
  esac
done

read_pid_from_file() {
  local key="$1"
  if ! command -v node &> /dev/null; then
    echo ""
    return
  fi
  node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    console.log(data[process.argv[2]].pid || '');
  " "$PIDS_FILE" "$key" 2>/dev/null || true
}

stop_by_pid() {
  local pid="$1"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    sleep 1
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    echo "已结束进程 PID $pid"
  else
    echo "进程 PID $pid 不存在或已结束"
  fi
}

stop_by_port() {
  local port="$1"
  local pids
  pids=$(lsof -t -i:"$port" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill -TERM 2>/dev/null || true
    sleep 1
    local remaining
    remaining=$(lsof -t -i:"$port" 2>/dev/null || true)
    if [[ -n "$remaining" ]]; then
      echo "$remaining" | xargs kill -KILL 2>/dev/null || true
    fi
    echo "已结束占用端口 $port 的进程"
  else
    echo "端口 $port 未被占用"
  fi
}

if [[ -f "$PIDS_FILE" ]]; then
  echo "读取 PID 文件：$PIDS_FILE"
  BACKEND_PID=$(read_pid_from_file backend)
  FRONTEND_PID=$(read_pid_from_file frontend)

  if [[ -n "$BACKEND_PID" ]]; then
    stop_by_pid "$BACKEND_PID"
  fi
  if [[ -n "$FRONTEND_PID" ]]; then
    stop_by_pid "$FRONTEND_PID"
  fi

  rm -f "$PIDS_FILE"
  echo "已清理 PID 文件"
else
  echo "未找到 PID 文件，尝试按端口查找 ..."
  stop_by_port "$PORT"
  stop_by_port "$FRONTEND_PORT"
fi

echo "生产服务已停止"
