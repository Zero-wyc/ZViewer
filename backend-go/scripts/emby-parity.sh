#!/usr/bin/env bash
# Emby / Jellyfin 端点 Node ↔ Go 双向对拍（阶段 6）。
#
# 结构同 webdav-parity.sh：两份相同的库 + 一个 mock Emby 服务器 +
# 两侧各跑同一条请求序列 → 逐步骤比较「状态码 + 响应体」（m3u8 比全文）。
#
# 用法：bash backend-go/scripts/emby-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
WORK=/tmp/zvemby-parity
BIN="$WORK/zviewerd.exe"
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
ROOM=EmbyParityRoom

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$BIN" ./cmd/zviewer-server) || exit 1

MOCK_PORT=$(pick_port)
EMBY_URL="http://127.0.0.1:$MOCK_PORT"

echo "=== 准备用户与影片种子 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('emby-owner-pass',10))")

seed_db() {
  "$PY" - "$1" "$HASH" "$EMBY_URL" "$ROOM" <<'PY'
import sqlite3, sys
db, pw_hash, emby_url, room = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', ('emby-owner',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('emby-owner', pw_hash, 'user', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('emby-owner',)).fetchone()[0]

# 清掉该用户的 emby/jellyfin 挂载，保证两侧自增 id 从同一起点开始
c.execute('DELETE FROM "user_mount" WHERE "userId"=? AND "type" IN (?,?)', (uid, 'emby', 'jellyfin'))

# 影片流种子：房间房主 = emby-owner，影片自身不带凭证，
# 靠 serverUrl + type + 房主回退到挂载取凭证。
c.execute('DELETE FROM "movie" WHERE "roomId"=?', (room,))
c.execute('DELETE FROM "room" WHERE "roomId"=?', (room,))
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","ownerUserId",
             "lastAccessedAt","createdAt","updatedAt")
             VALUES (?,?,?,?,?,'2026-01-01 00:00:00.000',
                    '2026-01-01 00:00:00.000','2026-01-01 00:00:00.000')''',
          (room, 'Emby 对拍房', 'active', 'watch-together', uid))
# 影片一：静态流（format=mkv）
c.execute('''INSERT INTO "movie" ("roomId","url","title","source","serverUrl","path","format","order")
             VALUES (?,?,?,?,?,?,?,1)''',
          (room, '/api/emby/stream', 'emby 静态影片', 'emby', emby_url, 'm1', 'mkv'))
mid1 = c.execute('SELECT "id" FROM "movie" WHERE "roomId"=? ORDER BY "id" ASC LIMIT 1',
                 (room,)).fetchone()[0]
# 影片二：转码（format=hls，音轨是 DTS）
c.execute('''INSERT INTO "movie" ("roomId","url","title","source","serverUrl","path","format","order")
             VALUES (?,?,?,?,?,?,?,2)''',
          (room, '/api/emby/stream', 'emby 转码影片', 'emby', emby_url, 'm3', 'hls'))
mid2 = c.execute('SELECT "id" FROM "movie" WHERE "roomId"=? ORDER BY "id" DESC LIMIT 1',
                 (room,)).fetchone()[0]
c.commit()
print('%d %d %d' % (uid, mid1, mid2))
PY
}

MOVIE_IDS=""
for db in "$WORK/node/dev.sqlite" "$WORK/go/dev.sqlite"; do
  OUT=$(seed_db "$db") || exit 1
  echo "  种子(userId movie1 movie2): $OUT"
  if [ -z "$MOVIE_IDS" ]; then MOVIE_IDS=$(echo "$OUT" | awk '{print $2","$3}'); fi
done
echo "  影片ID=$MOVIE_IDS"

echo "=== 启动 mock Emby（端口 $MOCK_PORT）==="
node "$script_dir/mock-emby.js" "$MOCK_PORT" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill_tree "$MOCK_PID"; [ -n "${NODE_PID:-}" ] && kill_tree "$NODE_PID"; [ -n "${GO_PID:-}" ] && kill_tree "$GO_PID"' EXIT
if ! wait_ready "$MOCK_PORT" "mock Emby" "$WORK/mock.log" "listening"; then
  exit 1
fi

NODE_PORT=$(pick_port)
GO_PORT=$(pick_port)

echo "=== 启动 Node 侧最小应用（端口 $NODE_PORT）==="
CONFIG_DIR="$WORK/node" DATABASE_URL="$WORK/node/dev.sqlite" \
  node "$script_dir/parity-node-emby.js" "$WORK/node/dev.sqlite" "$NODE_PORT" \
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
  echo "=== 对 $label 跑序列 ==="
  node "$script_dir/parity-emby-run.js" \
    --base "$base" --mock "$EMBY_URL" --user emby-owner \
    --movieIds "$MOVIE_IDS" \
    > "$out" 2> "${out%.json}.err"
  if [ ! -s "$out" ]; then
    echo "!! $label 序列失败："; tail -10 "${out%.json}.err"; return 1
  fi
  echo "  步骤数=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$out")"
}

run_seq "http://127.0.0.1:$NODE_PORT" "$WORK/node/out.json" Node || exit 1
run_seq "http://127.0.0.1:$GO_PORT" "$WORK/go/out.json" Go || exit 1

echo
echo "=== 逐步骤比对 ==="
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
  console.log(`      node: status=${left.status} ${ls.slice(0, 700)}`);
  console.log(`      go  : status=${right.status} ${rs.slice(0, 700)}`);
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
echo "=== mock Emby 命中统计（两侧合计）==="
curl -s "$EMBY_URL/__stats"; echo
echo "=== Go 服务日志（错误行）==="
grep -iE "error|panic" "$WORK/go/server.log" | tail -5 || echo "  无错误"

exit $STATUS
