#!/bin/bash
set -e

echo "========================================"
echo "  ZViewer Docker 启动（HTTP 模式）"
echo "  统一端口：后端提供 API + 前端静态文件"
echo "========================================"

# 确保运行时目录存在
mkdir -p config/ssl config/uploads config/media log

# ==================== 端口配置 ====================
# 统一端口：前后端共用同一端口（默认 3333），由后端托管前端静态文件
PORT="${PORT:-3333}"
RTMP_PORT="${RTMP_PORT:-3334}"
HTTP_FLV_PORT="${HTTP_FLV_PORT:-3335}"

# 后端环境变量
export PORT="$PORT"
export HOST="${HOST:-0.0.0.0}"
export RTMP_PORT="$RTMP_PORT"
export HTTP_FLV_PORT="$HTTP_FLV_PORT"

# ==================== 重启标记文件 ====================
# 更新脚本替换文件后会创建 .restart-backend，entrypoint 检测到后重启后端而非退出容器
RESTART_MARKER="/app/.restart-backend"
# 清理可能残留的旧标记，避免启动时误判
rm -f "$RESTART_MARKER"

BACKEND_PID=""

# ==================== 信号处理 ====================
# SIGTERM/SIGINT 时停止后端并退出容器（正常关闭流程，不触发重启）
cleanup() {
  echo ""
  echo "  正在停止服务..."
  if [ -n "$BACKEND_PID" ]; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
  echo "  服务已停止"
  exit 0
}

trap cleanup SIGTERM SIGINT

# ==================== 后端进程监控循环 ====================
# 后端退出后，检查是否为更新触发的重启：
# - 存在 .restart-backend 标记 → 等待更新脚本完成 → 重启后端，不退出容器
# - 无标记 → 后端异常退出，停止容器（依赖 restart policy 自动恢复）
while true; do
  echo "  启动后端 (统一端口: $PORT, RTMP: $RTMP_PORT, FLV: $HTTP_FLV_PORT)..."
  ./zviewer-backend &
  BACKEND_PID=$!
  # 记录后端 PID 到 pidfile，供 Docker 更新脚本终止后端进程以触发重启
  echo "$BACKEND_PID" > /app/.backend.pid

  if [ ! -f "$RESTART_MARKER" ]; then
    # 首次启动打印访问信息，重启时不重复打印
    echo ""
    echo "========================================"
    echo "  ZViewer 已启动"
    echo "  访问页面 : http://localhost:$PORT"
    echo "  RTMP 推流: rtmp://localhost:$RTMP_PORT/live （由后端进程内监听）"
    echo "  HTTP-FLV : http://localhost:$PORT/live/ （后端反代到进程内 $HTTP_FLV_PORT）"
    echo "  一起听   : 后端自带网易云接口，无需额外服务"
    echo "========================================"
  fi

  # 等待后端进程退出
  while kill -0 "$BACKEND_PID" 2>/dev/null; do
    sleep 1
  done

  # 后端已退出，检查是否为更新触发的重启
  if [ -f "$RESTART_MARKER" ]; then
    echo ""
    echo "  [entrypoint] 检测到更新重启标记"
    rm -f "$RESTART_MARKER"

    # 等待更新脚本（apply-update.sh）完成文件复制
    # 更新脚本先 kill 后端再复制文件，必须等它完成后才能重启后端
    echo "  [entrypoint] 等待更新脚本完成..."
    UPDATE_TIMEOUT=120
    UPDATE_WAITED=0
    while pgrep -f "apply-update.sh" >/dev/null 2>&1; do
      sleep 1
      UPDATE_WAITED=$((UPDATE_WAITED + 1))
      if [ "$UPDATE_WAITED" -ge "$UPDATE_TIMEOUT" ]; then
        echo "  [entrypoint] 更新脚本等待超时（${UPDATE_TIMEOUT}s），强制重启后端"
        break
      fi
    done
    echo "  [entrypoint] 更新脚本已完成，正在重启后端..."

    # 短暂等待，确保端口释放（旧进程可能处于 TIME_WAIT）
    sleep 2
    continue  # 重启后端，不退出容器
  fi

  echo "  [警告] 后端进程已异常退出，正在停止容器..."
  break
done

cleanup
