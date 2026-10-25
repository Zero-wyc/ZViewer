#!/usr/bin/env bash
# FTP 端点 Node ↔ Go 双向对拍（阶段 5）。
#
# 结构同 webdav-parity.sh：两份相同的库 + 一个 mock FTP 服务器 +
# 两侧各跑同一条请求序列 → 逐步骤比较「状态码 + 响应体」。
#
# 两种目录格式都要跑：
#   bash ftp-parity.sh              # MLSD（现代服务器）
#   LIST_ONLY=1 bash ftp-parity.sh  # 只给 LIST -a / LIST（老服务器 + stat 回退）
#
# 用法：bash backend-go/scripts/ftp-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
LIST_ONLY=${LIST_ONLY:-0}
if [ "$LIST_ONLY" = "1" ]; then
  WORK=/tmp/zvftp-parity-list
  MODE_LABEL="LIST"
  MOCK_ARGS="--no-mlst"
else
  WORK=/tmp/zvftp-parity
  MODE_LABEL="MLSD"
  MOCK_ARGS=""
fi
BIN="$WORK/zviewerd.exe"
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
ROOM=FtpParityRoom
FTP_USER=ftp-user
FTP_PASS=ftp-secret

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

# wait_anchor <name> <log> <anchor>
#
# mock FTP 说不了 HTTP，wait_ready 的 /health 探活用不上。这里只等日志锚点：
# 日志是本轮新建的，只有我们自己的进程会写，不会认错人。
wait_anchor() {
  local name=$1 log=$2 anchor=$3 i
  for i in $(seq 1 80); do
    if grep -q "$anchor" "$log" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo "!! $name 启动失败。日志尾部："
  tail -8 "$log" 2>/dev/null
  return 1
}

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$BIN" ./cmd/zviewer-server) || exit 1

FTP_PORT=$(pick_port)
FTP_HOST=127.0.0.1
FTP_URL="ftp://$FTP_HOST"

echo "=== 准备用户与影片种子（目录格式：$MODE_LABEL）==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('ftp-pass-1234',10))")

seed_db() {
  "$PY" - "$1" "$HASH" "$FTP_HOST" "$ROOM" "$SEED_NOW" <<'PY'
import sqlite3, sys
db, pw_hash, host, room, _now = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
c = sqlite3.connect(db)
# _now 由 bash 侧算一次后传进来：两份种子库必须拿到**同一个**时间字符串，
# 否则跨秒时两侧列表里的 lastAccessedAt 会差 1 秒，对拍随机红。
c.execute('DELETE FROM "user" WHERE "username"=?', ('ftp-owner',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('ftp-owner', pw_hash, 'user', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('ftp-owner',)).fetchone()[0]

# 清掉该用户的 ftp 挂载，保证两侧自增 id 从同一起点开始
c.execute('DELETE FROM "user_mount" WHERE "userId"=? AND "type"=?', (uid, 'ftp'))

# 影片流种子：房主 = ftp-owner，影片自身不带凭证，必须靠
# serverUrl + type + 房主 回退到挂载取凭证。
c.execute('DELETE FROM "movie" WHERE "roomId"=?', (room,))
c.execute('DELETE FROM "room" WHERE "roomId"=?', (room,))
# lastAccessedAt 必须写「现在」：写死的历史时间会被 Go 启动时的房间清理判成
# 「长期无人访问」直接删掉，连带挂在它身上的影片一起消失（Node 侧最小应用不跑清理，
# 于是后续所有「影片流」步骤都会变成一头 404 一头 206）。
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","ownerUserId",
             "lastAccessedAt","createdAt","updatedAt")
             VALUES (?,?,?,?,?,?,?,?)''',
          (room, 'FTP 对拍房', 'active', 'watch-together', uid, _now, _now, _now))
c.execute('''INSERT INTO "movie" ("roomId","url","title","source","serverUrl","path","order")
             VALUES (?,?,?,?,?,?,1)''',
          (room, '/api/ftp/stream', 'ftp 对拍影片', 'ftp', host, '/videos/a.mkv'))
mid = c.execute('SELECT "id" FROM "movie" WHERE "roomId"=? ORDER BY "id" DESC LIMIT 1',
                (room,)).fetchone()[0]
c.commit()
print('%d %d' % (uid, mid))
PY
}

MOVIE_ID=""
# 种子时间戳统一在这里算一次：两份库必须用同一个值，跨秒会让对拍随机红
SEED_NOW=$(date -u +"%Y-%m-%d %H:%M:%S.000")
for db in "$WORK/node/dev.sqlite" "$WORK/go/dev.sqlite"; do
  OUT=$(seed_db "$db") || exit 1
  echo "  种子(userId movieId): $OUT"
  if [ -z "$MOVIE_ID" ]; then MOVIE_ID=$(echo "$OUT" | awk '{print $2}'); fi
done
echo "  影片ID=$MOVIE_ID"

echo "=== 启动 mock FTP（端口 $FTP_PORT）==="
# shellcheck disable=SC2086
node "$script_dir/mock-ftp.js" "$FTP_PORT" $MOCK_ARGS --log="$WORK/ftp.log" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill_tree "$MOCK_PID"; [ -n "${NODE_PID:-}" ] && kill_tree "$NODE_PID"; [ -n "${GO_PID:-}" ] && kill_tree "$GO_PID"' EXIT
if ! wait_anchor "mock FTP" "$WORK/mock.log" "listening"; then
  exit 1
fi

NODE_PORT=$(pick_port)
GO_PORT=$(pick_port)

echo "=== 启动 Node 侧最小应用（端口 $NODE_PORT）==="
CONFIG_DIR="$WORK/node" DATABASE_URL="$WORK/node/dev.sqlite" \
  node "$script_dir/parity-node-ftp.js" "$WORK/node/dev.sqlite" "$NODE_PORT" \
  > "$WORK/node/app.log" 2>&1 &
NODE_PID=$!
if ! wait_ready "$NODE_PORT" "Node 最小应用" "$WORK/node/app.log" "listening"; then
  exit 1
fi

echo "=== 启动 Go 服务（端口 $GO_PORT）==="
CONFIG_DIR="$WORK/go" PORT="$GO_PORT" PROJECT_ROOT="$REPO" "$BIN" > "$WORK/go/server.log" 2>&1 &
GO_PID=$!
if ! wait_ready "$GO_PORT" "Go 服务" "$WORK/go/server.log" "监听"; then
  exit 1
fi

run_seq() {
  local base=$1 out=$2 label=$3
  # 每侧跑之前清空 mock 命令日志，便于事后核对登录次数（缓存是否生效）
  : > "$WORK/ftp.log"
  echo "=== 对 $label 跑序列 ==="
  node "$script_dir/parity-ftp-run.js" \
    --base "$base" --host "$FTP_HOST" --ftpPort "$FTP_PORT" --ftpUrl "$FTP_URL" \
    --user ftp-owner --ftpUser "$FTP_USER" --ftpPass "$FTP_PASS" --movieId "$MOVIE_ID" \
    > "$out" 2> "${out%.json}.err"
  if [ ! -s "$out" ]; then
    echo "!! $label 序列失败："; tail -10 "${out%.json}.err"; return 1
  fi
  cp "$WORK/ftp.log" "${out%.json}.log"
  echo "  步骤数=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$out")"
  echo "  FTP 命令数=$(wc -l < "$WORK/ftp.log") 登录(PASS)数=$(grep -c '^PASS' "$WORK/ftp.log" || true)"
}

run_seq "http://127.0.0.1:$NODE_PORT" "$WORK/node/out.json" Node || exit 1
run_seq "http://127.0.0.1:$GO_PORT" "$WORK/go/out.json" Go || exit 1

echo
echo "=== 逐步骤比对（$MODE_LABEL）==="
node - "$WORK/node/out.json" "$WORK/go/out.json" <<'JS'
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const n = Math.max(a.length, b.length);
let bad = 0;
for (let i = 0; i < n; i++) {
  const left = a[i];
  const right = b[i];
  if (!left || !right) {
    console.log(`  !! 第 ${i + 1} 步只有一侧有结果: node=${!!left} go=${!!right}`);
    bad++;
    continue;
  }
  const ls = JSON.stringify(left);
  const rs = JSON.stringify(right);
  if (ls === rs) {
    console.log(`  ✓ ${left.step}`);
    continue;
  }
  bad++;
  console.log(`  ✗ ${left.step}`);
  console.log(`      node: status=${left.status} ${ls.slice(0, 600)}`);
  console.log(`      go  : status=${right.status} ${rs.slice(0, 600)}`);
}
console.log('');
if (bad === 0) {
  console.log(`全部 ${n} 步完全一致 ✓`);
  process.exit(0);
}
console.log(`有 ${bad} 处差异 ✗`);
process.exit(1);
JS
STATUS=$?

echo
echo "=== mock FTP 收到的命令（Go 侧最后一轮，末尾 12 条）==="
tail -12 "$WORK/go/out.log"
echo "=== Go 服务日志（错误行）==="
grep -iE "error|panic" "$WORK/go/server.log" | tail -5 || echo "  无错误"

exit $STATUS
