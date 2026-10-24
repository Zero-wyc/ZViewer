#!/usr/bin/env bash
# 让 Node 版与 Go 版同时解析同一批真实链接，逐字段比对输出。
#
# 为什么值得单独写：解析链的输出是「前端 + 播放器 + 影片缓存」三方共同依赖的契约，
# 字段少一个、清晰度差一档、试看标记丢了，都不会报错，只会静默播不出来。
#
# 两个服务各用一份 config 副本：Node 的 sql.js 会把整库读进内存并全量写回，
# 共用同一文件会互相覆盖（且不留痕迹）。
set -u
REPO=/f/Code/ZViewer/ZViewer
WORK="$REPO/.tmp-parity"
BIN=/tmp/zviewerd.exe
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/lib-proc.sh"

# 端口随机，见 lib-proc.sh 顶部说明（残留进程冒充新构建是本脚本最大的坑）。
NODE_PORT=$(pick_port)
GO_PORT=$(( NODE_PORT + 1 ))

rm -rf "$WORK"; mkdir -p "$WORK/node/config" "$WORK/go/config" "$WORK/out"
cp "$REPO/config/dev.sqlite" "$WORK/node/config/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/config/dev.sqlite"

HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('parity-pass-1234',10))")
python - "$WORK/node/config/dev.sqlite" "$WORK/go/config/dev.sqlite" "$HASH" <<'PY'
import sqlite3, sys
h = sys.argv[3]
for db in sys.argv[1:3]:
    c = sqlite3.connect(db)
    c.execute('DELETE FROM "user" WHERE "username" = ?', ('parity-user',))
    c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
              ('parity-user', h, 'root', 'active'))
    c.commit()
print('两个副本库均已插入 parity-user')
PY

WINWORK=$(cd "$WORK" && pwd -W 2>/dev/null || echo "$WORK")

(cd "$REPO/backend" && CONFIG_DIR="$WINWORK/node/config" PORT=$NODE_PORT node dist/index.js \
  > "$WORK/node/server.log" 2>&1) &
NODE_PID=$!
CONFIG_DIR="$WINWORK/go/config" PORT=$GO_PORT PROJECT_ROOT="$REPO" "$BIN" \
  > "$WORK/go/server.log" 2>&1 &
GO_PID=$!

cleanup() {
  kill_tree "$NODE_PID"
  kill_tree "$GO_PID"
  sleep 1
}
trap cleanup EXIT

wait_ready "$NODE_PORT" Node "$WORK/node/server.log" "Server is running on" || exit 1
wait_ready "$GO_PORT" Go "$WORK/go/server.log" "\[start\] 监听" || exit 1

login() {
  curl -s -X POST "http://127.0.0.1:$1/api/auth/login" -H 'Content-Type: application/json' \
    -d '{"username":"parity-user","password":"parity-pass-1234"}' \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accessToken||'')}catch(e){console.log('')}})"
}
NODE_TOKEN=$(login "$NODE_PORT")
GO_TOKEN=$(login "$GO_PORT")
echo "端口 Node=$NODE_PORT Go=$GO_PORT；token Node=${#NODE_TOKEN} 字符, Go=${#GO_TOKEN} 字符"
[ -z "$NODE_TOKEN" ] && { echo "Node 登录失败，中止"; exit 1; }
[ -z "$GO_TOKEN" ] && { echo "Go 登录失败，中止"; exit 1; }

# 对拍用例：覆盖 UGC 默认/降清晰度/MP4、PGC 免费集/会员专享集/切集。
# 第三段是额外查询参数，必须单独传——塞进 url 里会被当成链接的一部分，
# 服务端解析到的 url 虽然还能认出 BV 号，但 qn/preferMp4 根本没生效。
CASES=(
  "ugc-default|https://www.bilibili.com/video/BV1GJ411x7h7|"
  "ugc-qn16|https://www.bilibili.com/video/BV1GJ411x7h7|qn=16"
  "ugc-mp4|https://www.bilibili.com/video/BV1GJ411x7h7|preferMp4=1"
  "pgc-free|https://www.bilibili.com/bangumi/play/ep321808|"
  "pgc-paid|https://www.bilibili.com/bangumi/play/ep322558|"
  "pgc-ep2|https://www.bilibili.com/bangumi/play/ep322559|"
)

# 自己拼 query：curl -G + -d 在多参数组合下容易把额外参数吞掉，
# 而"参数没生效"的测试会静默地拿默认值比对，等于没测。
enc() { node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$1"; }

for entry in "${CASES[@]}"; do
  name=$(echo "$entry" | cut -d'|' -f1)
  url=$(echo "$entry" | cut -d'|' -f2)
  extra=$(echo "$entry" | cut -d'|' -f3)
  QS="url=$(enc "$url")"
  if [ -n "$extra" ]; then QS="$QS&$extra"; fi
  NODE_RAW=$(curl -s -m 90 -H "Authorization: Bearer $NODE_TOKEN" \
    "http://127.0.0.1:$NODE_PORT/api/stream/resolve-bilibili?$QS")
  GO_RAW=$(curl -s -m 90 -H "Authorization: Bearer $GO_TOKEN" \
    "http://127.0.0.1:$GO_PORT/api/stream/resolve-bilibili?$QS")
  # NDJSON：接口会先推进度行，结果永远在最后一行。
  echo "$NODE_RAW" | tail -1 > "$WORK/out/node-$name.json"
  echo "$GO_RAW" | tail -1 > "$WORK/out/go-$name.json"
  echo "  [$name] 已采集"
done

echo
echo "================ 逐字段比对 ================"
node "$HERE/parity-compare.js" "$WORK/out"
RESULT=$?

echo
echo "=== Go 侧日志（bilibili 相关） ==="
grep -E "\[bilibili" "$WORK/go/server.log" | tail -12
echo
echo "=== Node 侧日志（bilibili 相关） ==="
grep -E "\[bilibili" "$WORK/node/server.log" | tail -12
exit $RESULT
