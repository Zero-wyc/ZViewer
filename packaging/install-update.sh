#!/bin/bash
# zviewer-installer: 1
#
# ZViewer 发行包自带的更新安装脚本。
#
# 更新时由 ZViewer 更新器复制到 $ROOT/apply-update.sh 后执行。也就是说：
# **怎么停服、拷哪些文件、怎么校验、怎么重启，由新版本包自己说了算**，
# 而不是由正在运行的旧版本代码决定。以后新增一个二进制，只改这份脚本，
# 不必再改旧版更新器（旧版只需要会「发现并执行这份脚本」）。
#
# 契约（更新器通过环境变量注入，缺失即失败退出）：
#   ZVIEWER_UPDATE_ROOT       安装根目录
#   ZVIEWER_UPDATE_TEMP       临时目录（含已下载的压缩包）
#   ZVIEWER_UPDATE_EXTRACTED  解压后的新版本目录
#   ZVIEWER_UPDATE_MODE       native（裸机）| docker（容器）
#   ZVIEWER_UPDATE_TAG        日志前缀
#   ZVIEWER_UPDATE_FROM       更新前版本（仅用于日志）
#
# 首行 `# zviewer-installer: N` 是契约版本。更新器只接受自己认识的上限，
# 遇到更高的 N 会拒绝执行并提示手动更新，避免新脚本跑在不支持它的旧更新器上。
#
# 退出码：0 成功；2 参数/环境不合法；其余为安装失败。
# 注意脚本是 detached 起的，更新器看不到结果，诊断只能看 $ROOT/update.log。

set -e

TAG="${ZVIEWER_UPDATE_TAG:-[更新脚本]}"
ROOT="${ZVIEWER_UPDATE_ROOT:-}"
TEMP_DIR="${ZVIEWER_UPDATE_TEMP:-}"
EXTRACTED_DIR="${ZVIEWER_UPDATE_EXTRACTED:-}"
MODE="${ZVIEWER_UPDATE_MODE:-native}"
FROM_VERSION="${ZVIEWER_UPDATE_FROM:-unknown}"
SELF_PID=$$

# ==================== 安装策略：清单随包走 ====================
# 需要常驻安装目录的二进制。缺失就跳过而不是报错：旧版本包可能不带某个
# 伴生程序（例如 5.3.3 之前的镜像没有 zviewer-webgui）。
BINARIES=(zviewer-backend zviewer-webgui livekit-server)
# 需要覆盖的普通文件
FILES=(start.sh package.json .env)
# 需要整目录替换的目录（相对 ROOT）
DIRS=(frontend/dist)
# 安装完成后要从 ROOT 清掉的引导文件（脚本自己）
BOOTSTRAP=(install-update.sh install-update.bat)

NOBODY="${TAG} "
say() { echo "${NOBODY}$*"; }

# 原子替换二进制：先写同目录临时文件，再 rename 覆盖。
#
# 不能直接 cp 到目标位置：正在运行的 ELF 被就地覆盖会当场 SIGBUS
# （容器里 zviewer-webgui 由 entrypoint 托管，更新时并不会停它）。
# rename 只换目录项，旧 inode 留给运行中的进程，等它自己重启就切到新版本。
install_binary() {
  src="$1"
  dst="$2"
  tmp="$dst.new.$$"
  cp -f "$src" "$tmp"
  chmod +x "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$dst"
}

# ==================== 参数校验 ====================
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "[错误] ZVIEWER_UPDATE_ROOT 无效: ${ROOT:-<空>}" >&2
  exit 2
fi
if [ -z "$EXTRACTED_DIR" ] || [ ! -d "$EXTRACTED_DIR" ]; then
  echo "[错误] ZVIEWER_UPDATE_EXTRACTED 无效: ${EXTRACTED_DIR:-<空>}" >&2
  exit 2
fi
if [ -z "$TEMP_DIR" ]; then
  echo "[错误] ZVIEWER_UPDATE_TEMP 未提供" >&2
  exit 2
fi
case "$MODE" in
  native | docker) ;;
  *)
    echo "[错误] 未知的 ZVIEWER_UPDATE_MODE: $MODE" >&2
    exit 2
    ;;
esac

CONFIG_DIR="$ROOT/config"
CONFIG_BACKUP="$ROOT/.config-backup-$$"
LOG_FILE="$ROOT/update.log"

# 之后的输出全部进日志：脚本没有终端，失败原因只能从这里找。
exec >>"$LOG_FILE" 2>&1

echo ""
echo "========================================"
say "开始执行 $(date)"
say "模式=$MODE 从 $FROM_VERSION 更新 包目录=$EXTRACTED_DIR"
echo "========================================"

# ==================== 第 1 步：等后端把响应吐完 ====================
# 更新请求的响应是先返回、脚本后动手；留出窗口避免连接被拦腰切断。
say "等待后端返回响应..."
sleep 3

# ==================== 第 2 步：停服 ====================
# 必须先停再覆盖：运行中的 ELF 被覆盖会直接 SIGBUS，Windows 更是不允许。
if [ "$MODE" = "docker" ]; then
  # 先留标记，entrypoint 才知道这次退出是「更新」而不是「崩溃」。
  RESTART_MARKER="$ROOT/.restart-backend"
  touch "$RESTART_MARKER"
  say "已创建重启标记: $RESTART_MARKER"
fi

say "正在停止后端..."
BACKEND_PID=""
if [ -f "$ROOT/.backend.pid" ]; then
  BACKEND_PID=$(cat "$ROOT/.backend.pid" 2>/dev/null || true)
fi
if [ -z "$BACKEND_PID" ]; then
  # 排除自身：部署路径里含 zviewer-backend 时，本脚本的 bash 命令行也会被匹配到。
  for pid in $(pgrep -f "zviewer-backend" 2>/dev/null || true); do
    [ "$pid" != "$SELF_PID" ] && BACKEND_PID="$pid" && break
  done
fi
if [ -n "$BACKEND_PID" ]; then
  say "终止后端进程 PID=$BACKEND_PID"
  kill -TERM "$BACKEND_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    kill -0 "$BACKEND_PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$BACKEND_PID" 2>/dev/null; then
    say "后端未响应 SIGTERM，强制终止"
    kill -9 "$BACKEND_PID" 2>/dev/null || true
  fi
else
  say "未找到后端进程，可能已退出"
fi

# 旧版单文件部署可能还有独立前端进程；网页控制台在裸机上也是 start.sh 托管的，
# 一并停掉，等收尾时由 start.sh 按新版本重新拉起。
if [ "$MODE" = "native" ]; then
  for pattern in zviewer-frontend zviewer-webgui; do
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
      [ "$pid" != "$SELF_PID" ] && kill -9 "$pid" 2>/dev/null || true
    done
  done
fi

# 端口处于 TIME_WAIT 时立刻重启会失败
sleep 2

# ==================== 第 3 步：备份 config ====================
say "备份 config 目录..."
HAVE_BACKUP=0
if [ -d "$CONFIG_DIR" ]; then
  cp -r "$CONFIG_DIR" "$CONFIG_BACKUP"
  HAVE_BACKUP=1
  say "已备份 config 到 $CONFIG_BACKUP"
  # 裸机是全量覆盖安装，先把旧 config 挪走，免得旧版本的残留文件混进新版本；
  # 容器是白名单复制，根本不会碰 config，删了反而多一次风险。
  if [ "$MODE" = "native" ]; then
    rm -rf "$CONFIG_DIR"
  fi
fi

restore_config() {
  if [ "$HAVE_BACKUP" = "1" ] && [ -d "$CONFIG_BACKUP" ]; then
    mkdir -p "$CONFIG_DIR"
    cp -rf "$CONFIG_BACKUP/." "$CONFIG_DIR/" 2>/dev/null || true
  fi
}

# ==================== 第 4 步：应用新文件 ====================
say "应用新文件..."
if [ "$MODE" = "native" ]; then
  # 裸机：整包铺开。包就是真相，旧版本多出来的文件由上面的目录级替换兜住。
  #
  # 平铺包（无外层目录）时 EXTRACTED_DIR 就是临时目录，里面还躺着刚下载的
  # 压缩包，直接 cp -rf 会把 50 MB 的包一起铺进安装目录。先清掉。
  for archive in "$EXTRACTED_DIR"/*.zip "$EXTRACTED_DIR"/*.tar.gz; do
    [ -e "$archive" ] || continue
    rm -f "$archive"
  done
  cp -rf "$EXTRACTED_DIR/." "$ROOT/" 2>/dev/null || true
else
  # 容器：按清单精确覆盖。这里只写「要什么」，不写「不要什么」——
  # 所以新增二进制只要进 BINARIES，所有旧版本都能装上新文件。
  for name in "${BINARIES[@]}"; do
    if [ -f "$EXTRACTED_DIR/$name" ]; then
      install_binary "$EXTRACTED_DIR/$name" "$ROOT/$name"
      say "$name 已更新"
    else
      say "提示：更新包未包含 $name，保留现有文件"
    fi
  done
  for name in "${FILES[@]}"; do
    if [ -f "$EXTRACTED_DIR/$name" ]; then
      cp -f "$EXTRACTED_DIR/$name" "$ROOT/$name" 2>/dev/null || true
      say "$name 已更新"
    fi
  done
  for rel in "${DIRS[@]}"; do
    if [ -d "$EXTRACTED_DIR/$rel" ]; then
      rm -rf "${ROOT:?}/$rel"
      mkdir -p "$ROOT/$rel"
      cp -rf "$EXTRACTED_DIR/$rel/." "$ROOT/$rel/" 2>/dev/null || true
      say "$rel 已更新"
    fi
  done
fi

# 清掉被拷进安装目录的引导脚本，避免下次更新选错入口
for name in "${BOOTSTRAP[@]}"; do
  rm -f "$ROOT/$name" 2>/dev/null || true
done
chmod +x "$ROOT/zviewer-backend" 2>/dev/null || true

# ==================== 第 5 步：校验 ====================
if [ ! -f "$ROOT/zviewer-backend" ]; then
  echo "[错误] 更新后未找到 zviewer-backend，更新包可能损坏"
  restore_config
  exit 1
fi

say "恢复 config 目录..."
restore_config
if [ "$HAVE_BACKUP" = "1" ]; then
  rm -rf "$CONFIG_BACKUP"
  say "已恢复 config 目录（用户数据已保留）"
fi

say "清理临时文件..."
rm -rf "$TEMP_DIR"

# ==================== 第 6 步：收尾 ====================
if [ "$MODE" = "docker" ]; then
  # 容器里由 entrypoint 看到标记后重启后端，本脚本不拉进程
  say "更新完成，entrypoint 将自动重启后端 $(date)"
  rm -f "$0"
  exit 0
fi

say "重新启动服务..."
# 必须带 start 参数：start.sh 无参数会进交互菜单，后台跑起来只会卡在 read。
cd "$ROOT"
if [ -f "$ROOT/start.sh" ]; then
  nohup ./start.sh start >/dev/null 2>&1 &
else
  say "未找到 start.sh，直接启动后端"
  ENV_PORT=""
  if [ -f "$ROOT/.env" ]; then
    ENV_PORT=$(grep -E '^PORT=' "$ROOT/.env" | head -n 1 | cut -d= -f2- | tr -d '"' | xargs || true)
  fi
  PORT="${ENV_PORT:-3333}"
  PORT="$PORT" NODE_ENV=production HOST=:: nohup "$ROOT/zviewer-backend" >/dev/null 2>&1 &
fi

say "更新完成，服务正在启动... $(date)"
rm -f "$0"
exit 0
