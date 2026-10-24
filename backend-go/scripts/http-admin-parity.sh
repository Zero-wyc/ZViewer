#!/usr/bin/env bash
# 管理端（/api/admin 12 个端点）—— Node ↔ Go HTTP 对拍。
#
# 与 http-serverfiles-parity.sh 同一套机制（起两侧真后端 + 逐步骤 diff），
# 但比的是管理端响应：状态码 + 响应体。种子数据刻意做成**两份完全相同的库**，
# 步骤序列有状态（删房间/改设置会影响后续步骤），所以两侧必须同序执行。
#
# 用法：bash backend-go/scripts/http-admin-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-admin
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-admin-driver.js"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

win() { cygpath -w "$1"; }
NODE_CONFIG=$(win "$WORK/node")
NODE_DB=$(win "$WORK/node/dev.sqlite")
NODE_UPLOADS=$(win "$WORK/node/uploads")
GO_CONFIG=$(win "$WORK/go")
GO_DB=$(win "$WORK/go/dev.sqlite")
GO_UPLOADS=$(win "$WORK/go/uploads")
mkdir -p "$WORK/node/uploads" "$WORK/go/uploads"

echo "=== 种子：五个账号 + 五个房间 + 会话 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('sio-pass-1234',10))")
seed_db() {
  "$PY" - "$1" "$HASH" <<'PY'
import sqlite3, sys
db, pw = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)

accounts = (
    ('sio-owner', 'root', 'active'),
    ('sio-admin', 'admin', 'active'),
    ('sio-viewer', 'user', 'active'),
    ('sio-guest', 'guest', 'pending'),
    ('sio-doomed', 'user', 'active'),
)
for i, (name, role, status) in enumerate(accounts):
    c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
    # 显式错开 createdAt：管理端列表按 createdAt DESC 排序，
    # 同秒创建时并列行的顺序由 SQLite 决定（虽然两侧一致，但断言会变脆）。
    c.execute('''INSERT INTO "user" ("username","passwordHash","role","status","createdAt","updatedAt")
                 VALUES (?,?,?,?,datetime('now', ?),datetime('now'))''',
              (name, pw, role, status, f'-{100 - i} seconds'))

def uid(name):
    return c.execute('SELECT "id" FROM "user" WHERE "username"=?', (name,)).fetchone()[0]

admin_id = uid('sio-admin')

# 房间表必须**整表清空**再种。
#
# 不清的话，dev.sqlite 里的历史房间会被 Node 的「自动清理不活跃房间」
# 定时任务删掉（room-cleanup.service.ts：启动即跑一轮，删 status=active
# 且 lastAccessedAt 早于 autoDeleteAfterHours 的房间），而 Go 侧还没有这个
# 调度器——于是 Node 的列表少一行、count 也差一，对拍全是假差异。
c.execute('DELETE FROM "room"')
c.execute('DELETE FROM sqlite_sequence WHERE name = "room"')

rooms = (
    # roomId,      status,     owner,    password, createdAt offset
    ('ADMROOM01', 'active', admin_id, 'x', '-40 seconds'),  # 有会话，末尾单独删
    ('ADMROOM02', 'active', None,     None, '-30 seconds'),  # admin 非房主 → 403；root 可删
    ('ADMROOM03', 'closed', None,     None, '-20 seconds'),  # 重开用例
    ('ADMROOM04', 'active', None,     None, '-10 seconds'),  # 无人 → cleanup 清掉
    ('ADMROOM05', 'active', None,     None, '-5 seconds'),   # 有观众 → cleanup 必须保留
)
for room_id, status, owner, password, offset in rooms:
    # lastAccessedAt 用"现在"：刚种下去的房间不能被自动清理任务盯上。
    c.execute('''INSERT INTO "room" ("roomId","name","status","mode","ownerUserId","password",
                                    "maxViewers","createdAt","lastAccessedAt")
                 VALUES (?,?,?,?,?,?,?,datetime('now', ?),datetime('now'))''',
              (room_id, 'AdminRoom ' + room_id, status, 'screen-share', owner, password, 10, offset))

c.execute('DELETE FROM sqlite_sequence WHERE name = "session"')
c.execute('DELETE FROM "session"')
sessions = (
    ('ADMROOM01', 'adm-sock-host', 'sharer', admin_id),
    ('ADMROOM01', 'adm-sock-view', 'viewer', uid('sio-viewer')),
    ('ADMROOM05', 'adm-sock-v5', 'viewer', uid('sio-viewer')),
)
for room_id, sock, role, user_id in sessions:
    c.execute('''INSERT INTO "session" ("roomId","socketId","role","userId")
                 VALUES (?,?,?,?)''', (room_id, sock, role, user_id))
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
  DATABASE_URL="$NODE_DB" \
  CONFIG_DIR="$NODE_CONFIG" \
  UPLOADS_DIR="$NODE_UPLOADS" \
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
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" || {
  echo "!! Node 驱动失败"; head -20 "$WORK/node.json"
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
  DATABASE_URL="$GO_DB" \
  CONFIG_DIR="$GO_CONFIG" \
  UPLOADS_DIR="$GO_UPLOADS" \
  PROJECT_ROOT="$GO_CONFIG" \
  PORT=$GO_PORT \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$GO_PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" || {
  echo "!! Go 驱动失败"; head -20 "$WORK/go.json"
}
kill_tree "$GO_PID"

# ---------------------------------------------------------------------------
# 比较
# ---------------------------------------------------------------------------
echo "=== 逐步骤比较 ==="
"$PY" - "$WORK/node.json" "$WORK/go.json" <<'PY'
import json, sys

# 已知且刻意保留的差异：留空表示管理端目前应当**完全一致**。
# 加条目时必须写清原因，否则等于把回归网剪了个洞。
KNOWN_DIFFS = {}

a = json.load(open(sys.argv[1], encoding='utf-8'))
b = json.load(open(sys.argv[2], encoding='utf-8'))

if 'error' in a:
    print('Node 驱动异常:', a['error'][:800])
if 'error' in b:
    print('Go 驱动异常:', b['error'][:800])

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

diff = 0
known = 0
for name in names_a:
    if name not in sb:
        print(f'✗ {name}: Go 侧缺少该步骤')
        diff += 1
        continue
    x, y = sa[name], sb[name]
    same_status = x.get('status') == y.get('status')
    same_body = x.get('body') == y.get('body')
    if same_status and same_body:
        continue
    if name in KNOWN_DIFFS:
        known += 1
        print(f'~ {name}: 已知差异（{KNOWN_DIFFS[name]}）')
        continue
    diff += 1
    if not same_status:
        print(f'✗ {name}: 状态码不同 node={x.get("status")} go={y.get("status")}')
    if not same_body:
        print(f'✗ {name}: 响应体不同')
        print('   node:', json.dumps(x.get('body'), ensure_ascii=False, sort_keys=True)[:700])
        print('   go  :', json.dumps(y.get('body'), ensure_ascii=False, sort_keys=True)[:700])

total = len(names_a)
print()
if diff == 0:
    extra = f'，{known} 处已知差异' if known else ''
    print(f'✓ {total} 个步骤完全一致（状态码 + 响应体）{extra}')
else:
    print(f'✗ {diff} / {total} 个步骤存在差异，{known} 处已知差异')
sys.exit(0 if diff == 0 else 1)
PY
rc=$?
echo "（产物：$WORK/node.json / $WORK/go.json）"
exit $rc
