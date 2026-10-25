#!/usr/bin/env bash
# OpenList（挂载/浏览/解析/直链/me/搜索/流代理）与 stream 媒体代理 —— Node ↔ Go 对拍。
#
# 为什么要对拍：这 13 条路由此前在 Go 侧**完全缺失**（阶段 5 的端点探测才发现），
# 补齐后必须证明「文案、状态码、错误码、归一化后的 URL」与 Node 逐字一致，
# 否则前端会把预期 400 的分支显示成"加载失败"。
#
# 上游用 scripts/mock-alist.js（固定响应 + 支持 Range），两侧连同一个实例：
# 真实 AList 需要一台 NAS，且版本差异会让 fs/list 字段悄悄变。
#
# 用法：bash backend-go/scripts/http-openlist-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-openlist
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-openlist-driver.js"
MOCK="$REPO/backend-go/scripts/mock-alist.js"

USER_NAME=ol-parity
USER_PASS=ol-parity-pass
MOUNT_ID=901

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

# ---------------------------------------------------------------------------
# 假 AList：密码用「已哈希」形态起，两侧都走 /api/auth/login/hash
# ---------------------------------------------------------------------------
ALIST_PASS_HASH=$("$NODE" -e "
const crypto=require('crypto');
console.log(crypto.createHash('sha256').update('nas-pass' + '-https://github.com/alist-org/alist').digest('hex'));
")
ALIST_PORT=$(pick_port)
echo "=== 启动假 AList（端口 $ALIST_PORT）==="
MOCK_USER=nas-user MOCK_PASS="$ALIST_PASS_HASH" MOCK_SIZE=16 \
  "$NODE" "$MOCK" "$ALIST_PORT" > "$WORK/alist.log" 2>&1 &
ALIST_PID=$!
for _ in $(seq 1 40); do
  grep -q "mock-alist listening" "$WORK/alist.log" 2>/dev/null && break
  sleep 0.2
done
if ! grep -q "mock-alist listening" "$WORK/alist.log" 2>/dev/null; then
  echo "!! 假 AList 未就绪"; cat "$WORK/alist.log"; exit 1
fi
ALIST_BASE="http://127.0.0.1:$ALIST_PORT"

echo "=== 种子：用户 + OpenList 挂载(id=$MOUNT_ID) ==="
USER_HASH=$("$NODE" -e "console.log(require('bcryptjs').hashSync('$USER_PASS',10))")
seed_db() {
  "$PY" - "$1" "$USER_HASH" "$USER_NAME" "$MOUNT_ID" "$ALIST_BASE" "$ALIST_PASS_HASH" <<'PY'
import sqlite3, sys

db, user_hash, user_name, mount_id, alist_base, alist_pass = sys.argv[1:7]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', (user_name,))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          (user_name, user_hash, 'user', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', (user_name,)).fetchone()[0]

c.execute('DELETE FROM "user_mount" WHERE "id"=?', (int(mount_id),))
# 地址存成 /dav 结尾：与 Node 的 normalizeOpenListServerUrl 落库形态一致
c.execute('''INSERT INTO "user_mount"
             ("id","userId","type","name","serverUrl","path","username","password","directLink")
             VALUES (?,?,?,?,?,?,?,?,?)''',
          (int(mount_id), uid, 'openlist', '对拍挂载', alist_base + '/dav', '/movie',
           'nas-user', alist_pass, 0))
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
  echo "!! Node 后端未就绪"; tail -20 "$WORK/node.log"; kill_tree "$NODE_PID"; kill_tree "$ALIST_PID"; exit 1
fi

echo "=== 在 Node 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" \
  "$USER_NAME" "$USER_PASS" "$ALIST_BASE" || {
  echo "!! Node 驱动失败"; head -30 "$WORK/node.json"
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
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; kill_tree "$ALIST_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" \
  "$USER_NAME" "$USER_PASS" "$ALIST_BASE" || {
  echo "!! Go 驱动失败"; head -30 "$WORK/go.json"
}
kill_tree "$GO_PID"
kill_tree "$ALIST_PID"

# ---------------------------------------------------------------------------
# 比较
# ---------------------------------------------------------------------------
echo "=== 逐步骤比较 ==="
"$PY" - "$WORK/node.json" "$WORK/go.json" <<'PY'
import json, sys

a = json.load(open(sys.argv[1], encoding='utf-8'))
b = json.load(open(sys.argv[2], encoding='utf-8'))

aborted = False
if 'error' in a:
    print('Node 驱动异常:', a['error'][:600]); aborted = True
if 'error' in b:
    print('Go 驱动异常:', b['error'][:600]); aborted = True
if aborted:
    print('✗ 驱动器未跑完，对拍无效')
    sys.exit(1)

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
FIELDS = ('status', 'body', 'contentType', 'byteLength', 'head', 'tail', 'acao', 'contentRange')

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
    for field in FIELDS:
        if x.get(field) != y.get(field):
            diff += 1
            print(f'✗ {name}.{field} 不同')
            print('   node:', json.dumps(x.get(field), ensure_ascii=False, sort_keys=True)[:800])
            print('   go  :', json.dumps(y.get(field), ensure_ascii=False, sort_keys=True)[:800])
            break

total = len(names_a)
if diff == 0:
    print(f'✓ {total} 步零差异')
else:
    print(f'✗ {diff} / {total} 步存在差异')
sys.exit(0 if diff == 0 else 1)
PY
