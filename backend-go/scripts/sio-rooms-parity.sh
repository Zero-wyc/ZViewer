#!/usr/bin/env bash
# 房间实时层 Node ↔ Go 双向对拍（阶段 8）。
#
# 与前几个对拍脚本的区别：这次比较的不是 HTTP 响应，而是**事件流**。
# 同一份驱动器（默认 sio-rooms-driver.js；可用 DRIVER 换成 sio-members-driver.js
# 等其它场景）先后打到 Node 真身与 Go 实现，每步收集「收到的事件 + ack 应答」，
# 规范化 socketId / roomId / 时间字段后逐步骤 diff。
#
# Node 侧刻意用**真实后端**（ts-node 跑 src/index.ts）而不是最小 express
# 应用：房间业务的事件顺序依赖十几个服务（permission / session / state /
# playback-memory / movie-broadcaster），手搭最小应用等于把被测对象换掉。
#
# 用法：bash backend-go/scripts/sio-rooms-parity.sh
#       DRIVER=sio-members-driver.js TAG=members bash backend-go/scripts/sio-rooms-parity.sh
#
# DRIVER/TAG 让同一套「起两侧真后端 + 逐步骤 diff」的机制复用到别的驱动器上，
# 不必为每个场景复制一份 160 行的启动/比较逻辑。
set -u

REPO=/f/Code/ZViewer/ZViewer
DRIVER=${DRIVER:-sio-rooms-driver.js}
TAG=${TAG:-rooms}
WORK=/tmp/zvsio-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 种子：三个账号 + 放开建房权限 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('sio-pass-1234',10))")
seed_db() {
  "$PY" - "$1" "$HASH" <<'PY'
import sqlite3, sys
db, pw = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
for name, role in (('sio-owner', 'user'), ('sio-viewer', 'user'), ('sio-admin', 'admin')):
    c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
    c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
              (name, pw, role, 'active'))
# all-users：普通 user 也能建房，否则 create-room 第一步就 403
row = c.execute('SELECT "id" FROM "system_settings" ORDER BY "id" LIMIT 1').fetchone()
if row:
    c.execute('UPDATE "system_settings" SET "roomCreationMode"=? WHERE "id"=?', ('all-users', row[0]))
c.commit()
PY
}
for db in "$WORK/node/dev.sqlite" "$WORK/go/dev.sqlite"; do
  seed_db "$db" || exit 1
done

# ---------------------------------------------------------------------------
# Node 侧
# ---------------------------------------------------------------------------
NODE_PORT=$(pick_port)
echo "=== 启动 Node 后端（端口 $NODE_PORT）==="
(
  cd "$REPO/backend" || exit 1
  PORT=$NODE_PORT \
  DATABASE_URL="$WORK/node/dev.sqlite" \
  CONFIG_DIR="$WORK/node" \
  STREAM_PUSH_ENABLED=0 \
  "$NODE" ../node_modules/ts-node-dev/lib/bin.js --transpile-only src/index.ts \
    > "$WORK/node.log" 2>&1
) &
NODE_PID=$!

if ! wait_ready "$NODE_PORT" "Node 后端" "$WORK/node.log" "Server is running on"; then
  echo "!! Node 后端未就绪"; tail -20 "$WORK/node.log"; kill_tree "$NODE_PID"; exit 1
fi

echo "=== 在 Node 上跑驱动器 ==="
"$NODE" "$script_dir/$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" || {
  echo "!! Node 驱动失败"; grep -n "error" "$WORK/node.json" | head -5
}
kill_tree "$NODE_PID"
sleep 2

# ---------------------------------------------------------------------------
# Go 侧
# ---------------------------------------------------------------------------
GO_PORT=$(pick_port)
echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

echo "=== 启动 Go 后端（端口 $GO_PORT）==="
(
  DATABASE_URL="$WORK/go/dev.sqlite" \
  CONFIG_DIR="$WORK/go" \
  PORT=$GO_PORT \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$GO_PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$script_dir/$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" || {
  echo "!! Go 驱动失败"; grep -n "error" "$WORK/go.json" | head -5
}
kill_tree "$GO_PID"

# ---------------------------------------------------------------------------
# 比较
# ---------------------------------------------------------------------------
echo "=== 逐步骤比较 ==="
"$PY" - "$WORK/node.json" "$WORK/go.json" <<'PY'
import json, sys

a = json.load(open(sys.argv[1], encoding='utf-8'))
b = json.load(open(sys.argv[2], encoding='utf-8'))

if 'error' in a:
    print('Node 驱动异常:', a['error'][:400])
if 'error' in b:
    print('Go 驱动异常:', b['error'][:400])

sa = {s['step']: s for s in a.get('steps', [])}
sb = {s['step']: s for s in b.get('steps', [])}

names = [s['step'] for s in a.get('steps', [])]
names_b = [s['step'] for s in b.get('steps', [])]
if names != names_b:
    print('步骤序列不一致:')
    print('  node:', names)
    print('  go  :', names_b)

diff = 0
for name in names:
    if name not in sb:
        print(f'✗ {name}: Go 侧缺少该步骤')
        diff += 1
        continue
    x, y = sa[name], sb[name]
    if x.get('ack') != y.get('ack'):
        print(f'✗ {name}: ack 不同')
        print('   node:', json.dumps(x.get('ack'), ensure_ascii=False, sort_keys=True))
        print('   go  :', json.dumps(y.get('ack'), ensure_ascii=False, sort_keys=True))
        diff += 1
    if x.get('events') != y.get('events'):
        print(f'✗ {name}: 事件不同')
        ea = {(e['client'], e['event'], json.dumps(e['payload'], ensure_ascii=False, sort_keys=True)) for e in x.get('events', [])}
        eb = {(e['client'], e['event'], json.dumps(e['payload'], ensure_ascii=False, sort_keys=True)) for e in y.get('events', [])}
        for item in sorted(ea - eb):
            print('   仅 node:', item[0], item[1], item[2][:300])
        for item in sorted(eb - ea):
            print('   仅 go  :', item[0], item[1], item[2][:300])
        diff += 1

total = len(names)
print()
if diff == 0:
    print(f'✓ {total} 个步骤完全一致（ack + 事件流）')
else:
    print(f'✗ {diff} / {total} 个步骤存在差异')
sys.exit(0 if diff == 0 else 1)
PY
rc=$?
echo "（产物：$WORK/node.json / $WORK/go.json）"
exit $rc
