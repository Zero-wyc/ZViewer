#!/usr/bin/env bash
# Socket.IO 协议层验证（阶段 7 spike）。
#
# 起 cmd/sio-spike（只挂 internal/sio，无业务逻辑），然后用**真实的**
# socket.io-client@4.8.3 连上去逐项断言：三种传输形态、双向 ack、
# 房间广播的「含自己 / 排除自己」、5MB 大载荷、心跳保活、断线原因。
#
# 用法：bash backend-go/scripts/spike-sio.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
WORK=/tmp/zvsio-spike
BIN="$WORK/sio-spike.exe"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK"

echo "=== 编译 spike 服务端 ==="
(cd "$REPO/backend-go" && go build -o "$BIN" ./cmd/sio-spike) || exit 1

PORT=$(pick_port)
ADDR="127.0.0.1:$PORT"
LOG="$WORK/server.log"

ADDR="$ADDR" "$BIN" > "$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill_tree "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT

if ! wait_ready "$PORT" "sio-spike" "$LOG" "\[sio-spike\] 监听"; then
  exit 1
fi
echo "=== 服务端就绪：$ADDR ==="

node "$script_dir/spike-sio.js" "http://$ADDR"
rc=$?

if [ "$rc" -ne 0 ]; then
  echo ""
  echo "=== 服务端日志（尾部）==="
  tail -20 "$LOG"
fi
exit "$rc"
