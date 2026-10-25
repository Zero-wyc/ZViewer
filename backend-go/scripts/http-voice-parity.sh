#!/usr/bin/env bash
# 语音（/api/voice/*）—— Node ↔ Go HTTP 对拍。
#
# 三个端点：POST token / mute / kick。媒体面在 LiveKit，这里用
# scripts/mock-livekit.js 顶替：固定参与者、记录 Twirp 调用序列，
# 于是「禁言是否静音了音频轨」「解禁是否只改 metadata」都能逐条比较。
#
# 14 步：401 / 400×3 / 403×3 / 404×2 / token 成功（比 JWT payload）/ mute×2 / kick。
#
# 503（未配置 LIVEKIT_API_KEY/SECRET）不在这里：两侧都要配好密钥才能跑其余
# 步骤，另起一对进程不划算，由 internal/api/voice_test.go 覆盖。
#
# 用法：bash backend-go/scripts/http-voice-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-voice
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-voice-driver.js"
MOCK="$REPO/backend-go/scripts/mock-livekit.js"

OWNER=voice-owner
OWNER_PASS=voice-owner-pass
VIEWER=voice-viewer
VIEWER_PASS=voice-viewer-pass
OUTSIDER=voice-outsider
OUTSIDER_PASS=voice-outsider-pass
ROOM=VOICEPAR1
CLOSED_ROOM=VOICECLOSED

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 种子：房主 / 观众（有会话）/ 局外人 + 两个房间 ==="
OWNER_HASH=$(cd "$REPO" && "$NODE" -e "console.log(require('bcryptjs').hashSync('$OWNER_PASS',10))")
VIEWER_HASH=$(cd "$REPO" && "$NODE" -e "console.log(require('bcryptjs').hashSync('$VIEWER_PASS',10))")
OUTSIDER_HASH=$(cd "$REPO" && "$NODE" -e "console.log(require('bcryptjs').hashSync('$OUTSIDER_PASS',10))")
seed_db() {
  "$PY" - "$@" <<'PY'
import sqlite3, sys
from datetime import datetime, timezone

(db, owner_hash, viewer_hash, outsider_hash,
 owner, viewer, outsider, room, closed_room) = sys.argv[1:10]

c = sqlite3.connect(db)
for name in (owner, viewer, outsider):
    c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
ids = {}
for name, h in ((owner, owner_hash), (viewer, viewer_hash), (outsider, outsider_hash)):
    c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
              (name, h, 'user', 'active'))
    ids[name] = c.execute('SELECT "id" FROM "user" WHERE "username"=?', (name,)).fetchone()[0]

now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S.000')
for room_id in (room, closed_room):
    c.execute('DELETE FROM "session" WHERE "roomId"=?', (room_id,))
    c.execute('DELETE FROM "room" WHERE "roomId"=?', (room_id,))

c.execute('''INSERT INTO "room" ("roomId","name","status","mode","shareMethod","ownerUserId","lastAccessedAt")
             VALUES (?,?,?,?,?,?,?)''',
          (room, '语音房', 'active', 'screen-share', 'webrtc', ids[owner], now))
c.execute('''INSERT INTO "room" ("roomId","name","status","mode","shareMethod","ownerUserId","lastAccessedAt")
             VALUES (?,?,?,?,?,?,?)''',
          (closed_room, '已关房', 'closed', 'screen-share', 'webrtc', ids[owner], now))

# 观众已有活跃会话（canReadRoom 依赖它），局外人没有
c.execute('''INSERT INTO "session" ("roomId","socketId","role","userId","startedAt")
             VALUES (?,?,?,?,?)''', (room, 'sock-guard-1', 'viewer', ids[viewer], now))
c.commit()
PY
}
for db in "$WORK/node/dev.sqlite" "$WORK/go/dev.sqlite"; do
  seed_db "$db" "$OWNER_HASH" "$VIEWER_HASH" "$OUTSIDER_HASH" \
    "$OWNER" "$VIEWER" "$OUTSIDER" "$ROOM" "$CLOSED_ROOM" || exit 1
done

NODE_DB=$(cygpath -w "$WORK/node/dev.sqlite")
NODE_CONFIG=$(cygpath -w "$WORK/node")
GO_DB=$(cygpath -w "$WORK/go/dev.sqlite")
GO_CONFIG=$(cygpath -w "$WORK/go")
UPLOADS=$(cygpath -w "$WORK/uploads")

# ---------------------------------------------------------------------------
# 假 LiveKit
# ---------------------------------------------------------------------------
MOCK_PORT=$(pick_port)
echo "=== 启动假 LiveKit（端口 $MOCK_PORT）==="
"$NODE" "$MOCK" "$MOCK_PORT" > "$WORK/livekit.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  grep -q "listening on" "$WORK/livekit.log" 2>/dev/null && break
  sleep 0.1
done
if ! grep -q "listening on" "$WORK/livekit.log" 2>/dev/null; then
  echo "!! 假 LiveKit 未就绪"; cat "$WORK/livekit.log"; exit 1
fi
MOCK_URL="http://127.0.0.1:$MOCK_PORT"

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
  LIVEKIT_API_KEY=parity-key \
  LIVEKIT_API_SECRET=parity-secret \
  LIVEKIT_API_HOST="$MOCK_URL" \
  LIVEKIT_URL="wss://livekit.parity.example.com" \
  "$NODE" ../node_modules/ts-node-dev/lib/bin.js --transpile-only src/index.ts \
    > "$WORK/node.log" 2>&1
) &
NODE_PID=$!

if ! wait_ready "$NODE_PORT" "Node 后端" "$WORK/node.log" "Server is running on"; then
  echo "!! Node 后端未就绪"; tail -20 "$WORK/node.log"; kill_tree "$NODE_PID"; kill_tree "$MOCK_PID"; exit 1
fi

echo "=== 在 Node 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" \
  "$OWNER" "$OWNER_PASS" "$VIEWER" "$VIEWER_PASS" "$OUTSIDER" "$OUTSIDER_PASS" \
  "$MOCK_URL" "$ROOM" "$CLOSED_ROOM" || {
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
  STREAM_PUSH_ENABLED=0 \
  LIVEKIT_API_KEY=parity-key \
  LIVEKIT_API_SECRET=parity-secret \
  LIVEKIT_API_HOST="$MOCK_URL" \
  LIVEKIT_URL="wss://livekit.parity.example.com" \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$GO_PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; kill_tree "$MOCK_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" \
  "$OWNER" "$OWNER_PASS" "$VIEWER" "$VIEWER_PASS" "$OUTSIDER" "$OUTSIDER_PASS" \
  "$MOCK_URL" "$ROOM" "$CLOSED_ROOM" || {
  echo "!! Go 驱动失败"; head -20 "$WORK/go.json"
}
kill_tree "$GO_PID"
kill_tree "$MOCK_PID"

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

FIELDS = ('status', 'body', 'hasToken', 'tokenPayload', 'tokenTTLHours', 'tokenSegments', 'calls')
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
            print('   node:', json.dumps(x.get(field), ensure_ascii=False, sort_keys=True)[:900])
            print('   go  :', json.dumps(y.get(field), ensure_ascii=False, sort_keys=True)[:900])
            break
    if bad:
        continue

total = len(names_a)
print()
if diff == 0:
    print(f'✓ {total} 个步骤完全一致')
else:
    print(f'✗ {diff} / {total} 个步骤存在差异')
sys.exit(0 if diff == 0 else 1)
PY
