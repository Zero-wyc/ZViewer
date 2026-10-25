#!/usr/bin/env bash
# OBS 推流（/api/stream-push/obs-config/:roomId）—— Node ↔ Go HTTP 对拍。
#
# 覆盖 6 步：401 / 404 / 400 / 首次生成推流码 / 二次复用同一推流码 / 已有码复用。
# 推流码随机，驱动侧归一化成 <KEY> 并额外断言「两处一致」「二次请求未换码」。
#
# /live（HTTP-FLV 反代）不在本脚本里：它需要一条真实 RTMP 推流才有字节可比，
# 用假 NMS 才能稳定复现 → 由 internal/api/streampush_test.go 覆盖。
#
# 两侧都刻意关掉 NMS：Node 用 STREAM_PUSH_ENABLED=0（不监听 3334/3335），
# Go 用 NMS_HTTP_FLV_URL 指向一个必然连不上的端口，让可用性判定都在 false，
# 否则「谁先占住端口」会让两边出现假差异。
#
# 用法：bash backend-go/scripts/http-streampush-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-streampush
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-streampush-driver.js"

USER_NAME=push-user
USER_PASS=push-user-pass
ROOM_WRONG_MODE=PUSHPAR1
ROOM_NO_KEY=PUSHPAR2
ROOM_WITH_KEY=PUSHPAR3
FIXED_KEY=FixKey12

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 种子：普通用户 + 三个投屏房间 ==="
USER_HASH=$(cd "$REPO" && "$NODE" -e "console.log(require('bcryptjs').hashSync('$USER_PASS',10))")
seed_db() {
  "$PY" - "$1" "$USER_HASH" "$USER_NAME" "$ROOM_WRONG_MODE" "$ROOM_NO_KEY" "$ROOM_WITH_KEY" "$FIXED_KEY" <<'PY'
import sqlite3, sys
from datetime import datetime, timezone

db, user_hash, user_name, wrong_mode, no_key, with_key, fixed_key = sys.argv[1:8]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', (user_name,))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          (user_name, user_hash, 'user', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', (user_name,)).fetchone()[0]

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.000')
for room_id in (wrong_mode, no_key, with_key):
    c.execute('DELETE FROM "room" WHERE "roomId"=?', (room_id,))

# 非投屏模式：obs-config 应 400
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","shareMethod","ownerUserId","lastAccessedAt")
             VALUES (?,?,?,?,?,?,?)''', (wrong_mode, '推流-非投屏', 'active', 'watch-together', 'webrtc', uid, now))
# 投屏但还没推流码：接口应生成并落库
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","shareMethod","streamKey","ownerUserId","lastAccessedAt")
             VALUES (?,?,?,?,?,?,?,?)''', (no_key, '推流-待生成', 'active', 'screen-share', 'webrtc', None, uid, now))
# 投屏且已有推流码：必须原样复用
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","shareMethod","streamKey","ownerUserId","lastAccessedAt")
             VALUES (?,?,?,?,?,?,?,?)''', (with_key, '推流-已有码', 'active', 'screen-share', 'stream-push', fixed_key, uid, now))
c.commit()
PY
}
for db in "$WORK/node/dev.sqlite" "$WORK/go/dev.sqlite"; do
  seed_db "$db" || exit 1
done

NODE_DB=$(cygpath -w "$WORK/node/dev.sqlite")
NODE_CONFIG=$(cygpath -w "$WORK/node")
GO_DB=$(cygpath -w "$WORK/go/dev.sqlite")
GO_CONFIG=$(cygpath -w "$WORK/go")
UPLOADS=$(cygpath -w "$WORK/uploads")

# ---------------------------------------------------------------------------
# Node 侧
# ---------------------------------------------------------------------------
NODE_PORT=$(pick_port)
echo "=== 启动 Node 后端（端口 $NODE_PORT）==="
(
  cd "$REPO/backend" || exit 1
  PORT=$NODE_PORT \
  DATABASE_URL="$NODE_DB" \
  CONFIG_DIR="$NODE_CONFIG" \
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$NODE_CONFIG" \
  STREAM_PUSH_ENABLED=0 \
  "$NODE" ../node_modules/ts-node-dev/lib/bin.js --transpile-only src/index.ts \
    > "$WORK/node.log" 2>&1
) &
NODE_PID=$!

if ! wait_ready "$NODE_PORT" "Node 后端" "$WORK/node.log" "Server is running on"; then
  echo "!! Node 后端未就绪"; tail -20 "$WORK/node.log"; kill_tree "$NODE_PID"; exit 1
fi

echo "=== 在 Node 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" \
  "$USER_NAME" "$USER_PASS" "" "$ROOM_NO_KEY" "$ROOM_WITH_KEY" || {
  echo "!! Node 驱动失败"; head -20 "$WORK/node.json"
}
kill_tree "$NODE_PID"

# ---------------------------------------------------------------------------
# Go 侧
# ---------------------------------------------------------------------------
GO_PORT=$(pick_port)
echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

echo "=== 启动 Go 后端（端口 $GO_PORT）==="
(
  DATABASE_URL="$GO_DB" \
  CONFIG_DIR="$GO_CONFIG" \
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$GO_CONFIG" \
  PORT=$GO_PORT \
  NMS_HTTP_FLV_URL="http://127.0.0.1:1" \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$GO_PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" \
  "$USER_NAME" "$USER_PASS" "" "$ROOM_NO_KEY" "$ROOM_WITH_KEY" || {
  echo "!! Go 驱动失败"; head -20 "$WORK/go.json"
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
    print('Node 驱动异常:', a['error'][:600])
if 'error' in b:
    print('Go 驱动异常:', b['error'][:600])

steps_a = a.get('steps', [])
steps_b = b.get('steps', [])
names_a = [s['step'] for s in steps_a]
names_b = [s['step'] for s in steps_b]
if names_a != names_b:
    print('步骤序列不一致:')
    print('  node:', names_a)
    print('  go  :', names_b)

sa = {s['step']: s for s in steps_a}
sb = {s['step']: s for s in steps_b}

FIELDS = ('status', 'body', 'contentType', 'contentDisposition', 'twoPositionsSame', 'endsWithNewline')
diff = 0
for name in names_a:
    if name not in sb:
        print(f'✗ {name}: Go 侧缺少该步骤')
        diff += 1
        continue
    x, y = sa[name], sb[name]
    if x.get('error') or y.get('error'):
        if x.get('error') == y.get('error'):
            continue
        diff += 1
        print(f'✗ {name}: 请求异常 node={x.get("error")} go={y.get("error")}')
        continue
    bad = False
    for field in FIELDS:
        if x.get(field) != y.get(field):
            diff += 1
            bad = True
            print(f'✗ {name}.{field} 不同')
            print('   node:', json.dumps(x.get(field), ensure_ascii=False, sort_keys=True)[:600])
            print('   go  :', json.dumps(y.get(field), ensure_ascii=False, sort_keys=True)[:600])
            break
    if bad:
        continue

# 额外断言：首次生成的码在二次请求里必须原样复用
for side, logobj in (('node', a), ('go', b)):
    steps = {s['step']: s for s in logobj.get('steps', [])}
    first = steps.get('no stream key (first)', {})
    second = steps.get('no stream key (second)', {})
    if first.get('rawKey') and first.get('rawKey') != second.get('rawKey'):
        diff += 1
        print(f'✗ {side}: 二次请求换了推流码 {first.get("rawKey")!r} != {second.get("rawKey")!r}')
    if not first.get('twoPositionsSame'):
        diff += 1
        print(f'✗ {side}: sources[1].settings.key 与 service.settings.key 不一致')

total = len(names_a)
print()
if diff == 0:
    print(f'✓ {total} 个步骤完全一致')
else:
    print(f'✗ {diff} / {total} 个步骤存在差异')
sys.exit(0 if diff == 0 else 1)
PY
