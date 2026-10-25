#!/usr/bin/env bash
# 切换前全量回归汇总（阶段 5 第 6 项的前置证据）
#
# 逐个跑仓库里所有「Go 侧验收脚本」，串行执行（它们各自会占随机端口起进程，
# 并行会互相踩），把每个脚本的退出码、耗时、日志尾部收进一张表。
#
# 用法：
#   bash backend-go/scripts/regression-sweep.sh              # 全部
#   bash backend-go/scripts/regression-sweep.sh http-voice   # 只跑名字含 http-voice 的
#   SWEEP_TIMEOUT=600 bash backend-go/scripts/regression-sweep.sh
#
# 退出码：全部通过 0；有失败 1（失败项会打印日志尾部）。
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
FILTER="${1:-}"
SWEEP_TIMEOUT="${SWEEP_TIMEOUT:-420}"

WORK="${TMPDIR:-/tmp}/zv-sweep"
rm -rf "$WORK"
mkdir -p "$WORK"

# 顺序即执行顺序：先「端点级对拍」，再「链路冒烟」，最后「长跑类」。
# sio-* 放在 http-* 之后：它要起两边 socket 服务，耗时最长。
SCRIPTS=(
  route-parity.sh
  events-parity.sh
  http-bilibili-parity.sh
  http-anime-parity.sh
  http-anisubs-parity.sh
  http-cms-parity.sh
  http-kazumi-parity.sh
  http-music-parity.sh
  http-openlist-parity.sh
  http-serverfiles-parity.sh
  http-subtitles-parity.sh
  http-updater-parity.sh
  http-voice-parity.sh
  http-streampush-parity.sh
  http-admin-parity.sh
  webdav-parity.sh
  ftp-parity.sh
  emby-parity.sh
  movie-parity.sh
  rooms-parity.sh
  bilibili-parity.sh
  sio-rooms-parity.sh
  profile-smoke.sh
  movie-smoke.sh
  proxy-smoke.sh
  openlist-stream-smoke.sh
  bilibili-smoke.sh
  compat-smoke.sh
  https-smoke.sh
  desktop-env-smoke.sh
  config-roundtrip.sh
  frontend-smoke.sh
  soak.sh
)

# frontend-smoke 的构建（tsc + vite build）单独跑过一次就够了；这里只跑浏览器断言，
# 否则每次 sweep 都要多花两分钟做同一份产物。
export SKIP_FRONTEND_BUILD=1
# soak 是压缩版：真机 24h 用 SOAK_SECONDS=86400 单独跑。
export SOAK_SECONDS="${SOAK_SECONDS:-30}"

pass=0
fail=0
skip=0
declare -a FAILED=()
declare -a ROWS=()

echo "=============================================="
echo " ZViewer 切换前全量回归（Go 后端）"
echo " 仓库: $REPO"
echo " 日志: $WORK"
[ -n "$FILTER" ] && echo " 过滤: $FILTER"
echo "=============================================="
echo

for name in "${SCRIPTS[@]}"; do
  if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then
    continue
  fi
  if [ ! -f "$HERE/$name" ]; then
    echo "· 跳过 $name（脚本不存在）"
    skip=$((skip + 1))
    ROWS+=("SKIP|$name|0|脚本不存在")
    continue
  fi

  log="$WORK/${name%.sh}.log"
  printf '· %-30s ' "$name"
  start=$(date +%s)
  ( cd "$REPO" && timeout "$SWEEP_TIMEOUT" bash "$HERE/$name" ) > "$log" 2>&1
  code=$?
  dur=$(( $(date +%s) - start ))

  if [ $code -eq 0 ]; then
    echo "PASS  ${dur}s"
    pass=$((pass + 1))
    ROWS+=("PASS|$name|$dur|")
  elif [ $code -eq 124 ]; then
    echo "TIMEOUT  ${dur}s"
    fail=$((fail + 1))
    FAILED+=("$name")
    ROWS+=("TIMEOUT|$name|$dur|超过 ${SWEEP_TIMEOUT}s")
  else
    echo "FAIL(exit=$code)  ${dur}s"
    fail=$((fail + 1))
    FAILED+=("$name")
    ROWS+=("FAIL|$name|$dur|exit=$code")
  fi
done

echo
echo "=============================================="
echo " 汇总：通过 $pass / 失败 $fail / 跳过 $skip"
echo "=============================================="
for row in "${ROWS[@]}"; do
  IFS='|' read -r status name dur note <<< "$row"
  printf '%-8s %-30s %4ss  %s\n' "$status" "$name" "$dur" "$note"
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  echo "---- 失败详情（日志尾部 25 行）----"
  for name in "${FAILED[@]}"; do
    echo
    echo "### $name"
    tail -25 "$WORK/${name%.sh}.log"
  done
  exit 1
fi
exit 0
