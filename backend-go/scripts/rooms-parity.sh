#!/usr/bin/env bash
# 房间 REST 端点的 Node ↔ Go 双向对拍（阶段 5）。
#
# 做法：同一份 dev.sqlite 副本复制两份 → 写入完全相同的种子 → 一份跑
# Node 的真实 rooms Router（最小 express 应用，避开 >2 分钟的 LiveKit 启动），
# 一份跑 Go 的 zviewer-server → 用**同一个驱动器脚本**跑同一条请求序列
# → 逐字节比较「状态码 + 响应体」。
#
# 用法：bash backend-go/scripts/rooms-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
WORK=/tmp/zvrooms-parity
BIN=/tmp/zvrooms-parity/zviewerd.exe
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

ROOM_A=RoomsParity1
ROOM_B=RoomsParity2

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$BIN" ./cmd/zviewer-server) || exit 1

# 三个时间点统一在这里算一次：两份种子库必须拿到完全相同的时间字符串，
# 否则跨秒时两侧列表里的 lastAccessedAt 会差 1 秒，对拍随机红。
T_FRESH=$(date -u +"%Y-%m-%d %H:%M:%S.000")
T_HOUR_AGO=$(date -u -d "-1 hour" +"%Y-%m-%d %H:%M:%S.000")
T_OLD=$(date -u -d "-2 days" +"%Y-%m-%d %H:%M:%S.000")

echo "=== 写入相同种子（两份库）==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('rooms-pass-1234',10))")
for db in "$WORK/node/dev.sqlite" "$WORK/go/dev.sqlite"; do
  "$PY" - "$db" "$HASH" "$ROOM_A" "$ROOM_B" "$T_FRESH" "$T_HOUR_AGO" "$T_OLD" <<'PY' || exit 1
import sqlite3, sys
db, pw_hash, room_a, room_b = sys.argv[1:5]
t_fresh, t_hour_ago, t_old = sys.argv[5], sys.argv[6], sys.argv[7]
c = sqlite3.connect(db)

def user(name, role):
    c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
    c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
              (name, pw_hash, role, 'active'))
    return c.execute('SELECT "id" FROM "user" WHERE "username"=?', (name,)).fetchone()[0]

owner = user('rooms-owner', 'user')
other = user('rooms-other', 'user')
v1 = user('rooms-viewer1', 'user')
v2 = user('rooms-viewer2', 'user')

# 时间基准必须取「现在」：基线库里的历史房间 lastAccessedAt 早就超过
# autoDeleteAfterHours，Go 启动即跑一轮房间清理会把它们（以及挂在它们身上的影片）
# 删掉，而 Node 侧的最小应用不跑清理 —— 结果就是「列表/影片」两侧必然不一致。
# 所以这里清空房间与影片，全部按 now 重新播种。
# 三个时间点由 bash 侧算一次后传进来：**两份种子库必须拿到同一组字符串**，
# 否则跨秒时两侧列表里的 lastAccessedAt 会差 1 秒，对拍随机红（踩过）。

c.execute('DELETE FROM "movie"')
c.execute('DELETE FROM "danmaku_track"')
c.execute('DELETE FROM "room_danmaku_meta"')
c.execute('DELETE FROM "session"')
c.execute('DELETE FROM "room"')

# 房间 A：房主=owner，时间列刻意给固定值，保证两端 toISOString 一致且排序稳定
c.execute('''INSERT INTO "room"
    ("roomId","name","status","mode","maxViewers","requireApproval","ownerUserId",
     "lastAccessedAt","createdAt","updatedAt")
    VALUES (?,?,?,?,?,?,?,?,?,?)''',
    (room_a, '对拍房间A', 'active', 'watch-together', 12, 0, owner,
     t_fresh, t_old, t_fresh))

# 房间 B：用于验证 viewerCount / sharerOnline 聚合；
# password 刻意写一个非空值，验证 hasPassword 的「有无」语义（true）而非内容。
c.execute('''INSERT INTO "room"
    ("roomId","name","password","status","mode","maxViewers","requireApproval","ownerUserId",
     "lastAccessedAt","createdAt","updatedAt")
    VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
    (room_b, '对拍房间B', 'not-a-real-hash', 'active', 'watch-together', 10, 1, other,
     t_hour_ago, t_old, t_hour_ago))

def session(rid, sock, role, uid):
    c.execute('''INSERT INTO "session" ("roomId","socketId","role","userId","guestId","startedAt","endedAt")
                 VALUES (?,?,?,?,NULL,?,NULL)''', (rid, sock, role, uid, t_old))

session(room_b, 'sock-v1', 'viewer', v1)
session(room_b, 'sock-v2', 'viewer', v2)
session(room_b, 'sock-s1', 'sharer', other)

# 房间 A 预置一条弹幕辅助数据：realtimeLog 由 send-danmaku 单独维护，
# PUT 只替换屏蔽词与已删除记录，必须原样保留——这是最容易写出偏差的一处。
c.execute('''INSERT INTO "room_danmaku_meta"
    ("roomId","blockKeywords","deletedLog","realtimeLog")
    VALUES (?,?,?,?)''',
    (room_a, '["旧屏蔽词"]', '[]', '[{"id":"r1","content":"实时弹幕","time":12}]'))

c.commit()
print('  种子完成: ' + db)
PY
done

NODE_PORT=$(pick_port)
GO_PORT=$(pick_port)

echo "=== 启动 Node 侧最小应用（端口 $NODE_PORT）==="
CONFIG_DIR="$WORK/node" DATABASE_URL="$WORK/node/dev.sqlite" \
  node "$script_dir/parity-node-rooms.js" "$WORK/node/dev.sqlite" "$NODE_PORT" \
  > "$WORK/node/app.log" 2>&1 &
NODE_PID=$!
trap 'kill_tree "$NODE_PID"; [ -n "${GO_PID:-}" ] && kill_tree "$GO_PID"' EXIT
if ! wait_ready "$NODE_PORT" "Node 最小应用" "$WORK/node/app.log" "listening"; then
  exit 1
fi

echo "=== 启动 Go 服务（端口 $GO_PORT）==="
CONFIG_DIR="$WORK/go" PORT="$GO_PORT" PROJECT_ROOT="$REPO" "$BIN" > "$WORK/go/server.log" 2>&1 &
GO_PID=$!
if ! wait_ready "$GO_PORT" "Go 服务" "$WORK/go/server.log" "监听"; then
  exit 1
fi

echo
echo "=== 对 Node 跑序列 ==="
node "$script_dir/parity-rooms-run.js" --base "http://127.0.0.1:$NODE_PORT" \
  --roomA "$ROOM_A" --roomB "$ROOM_B" > "$WORK/node/out.json" 2> "$WORK/node/out.err"
if [ ! -s "$WORK/node/out.json" ]; then
  echo "!! Node 侧序列失败："; tail -10 "$WORK/node/out.err"; exit 1
fi
echo "  步骤数=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$WORK/node/out.json")"

echo
echo "=== 对 Go 跑序列 ==="
node "$script_dir/parity-rooms-run.js" --base "http://127.0.0.1:$GO_PORT" \
  --roomA "$ROOM_A" --roomB "$ROOM_B" > "$WORK/go/out.json" 2> "$WORK/go/out.err"
if [ ! -s "$WORK/go/out.json" ]; then
  echo "!! Go 侧序列失败："; tail -10 "$WORK/go/out.err"; exit 1
fi
echo "  步骤数=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).length)" "$WORK/go/out.json")"

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
  console.log(`      node: status=${left.status} ${ls.slice(0, 400)}`);
  console.log(`      go  : status=${right.status} ${rs.slice(0, 400)}`);
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
echo "=== 服务器日志（错误行）==="
grep -iE "error|panic" "$WORK/go/server.log" | tail -5 || echo "  Go 无错误"

exit $STATUS
