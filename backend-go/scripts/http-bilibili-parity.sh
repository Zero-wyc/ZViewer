#!/usr/bin/env bash
# B站 账号域 + 内容浏览域（/api/stream/bilibili/*）—— Node ↔ Go HTTP 对拍。
#
# 与其它 HTTP 对拍脚本同一套机制（起两侧真后端、驱动器按固定步骤打请求），
# 但比较方式分三档（见 http-bilibili-driver.js 头部说明）：
#   exact  比「状态码 + 完整响应体」（参数校验、未绑定账号）
#   shape  比「状态码 + 类型骨架」（会真的打 B站，数据每次不同）
#   status 只比状态码（上游结果不稳定）
#
# 前提：本机可直连 api.bilibili.com（这些端点本身就依赖它）。
# 两侧都**不绑定 B站**：因此收藏夹/追番全部落在 401 分支，这是刻意的——
# 没有真实 Cookie 就不该假装能验「收藏成功」。
#
# 用法：bash backend-go/scripts/http-bilibili-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-bilibili
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-bilibili-driver.js"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 种子：一个未绑定 B站 的普通账号 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('bili-pass-1234',10))")
seed_db() {
  "$PY" - "$1" "$HASH" <<'PY'
import sqlite3, sys
db, pw = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)

# 固定账号：两侧用同一套登录凭据；清掉它的 B站 凭证，保证走 401 分支。
c.execute('DELETE FROM "user" WHERE "username"=?', ('bili-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('bili-user', pw, 'user', 'active'))
uid = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('bili-user',)).fetchone()[0]
c.execute('DELETE FROM "bilibili_credential" WHERE "userId"=?', (str(uid),))
c.execute('DELETE FROM "bilibili_credential" WHERE "userId"=?', (uid,))

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
UNUSED_UPLOADS=$(cygpath -w "$WORK/uploads")
mkdir -p "$WORK/uploads"

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
  UPLOADS_DIR="$UNUSED_UPLOADS" \
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
  UPLOADS_DIR="$UNUSED_UPLOADS" \
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

# 已知且刻意保留的差异：无。
KNOWN_DIFFS = {}

# 真正打 B站线上接口、结果每次不同的步骤。
#
# 两侧各发一次请求，上游的风控/缓存经常只让其中一侧拿到数据（表现为
# items 空 vs 非空、total 为 null vs 数字），这不是实现差异——但会让这条对拍
# 随机红，反过来掩盖真回归。所以这些步骤只比「状态码 + 顶层键集合」：
# 路由没接上、字段改名、整体包错一层，都会在这里现形；条数多少不计。
UPSTREAM_STEPS = {'search'}

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

diff = 0
known = 0
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
    same_status = x.get('status') == y.get('status')
    same_body = x.get('body') == y.get('body')
    if same_status and same_body:
        continue
    if name in UPSTREAM_STEPS and same_status:
        keys_x = sorted((x.get('body') or {}).keys()) if isinstance(x.get('body'), dict) else x.get('body')
        keys_y = sorted((y.get('body') or {}).keys()) if isinstance(y.get('body'), dict) else y.get('body')
        if keys_x == keys_y:
            known += 1
            print(f'~ {name}: 顶层键一致，内容随上游变化（不计差异）')
            continue
    if name in KNOWN_DIFFS:
        known += 1
        print(f'~ {name}: 已知差异（{KNOWN_DIFFS[name]}）')
        continue
    diff += 1
    if not same_status:
        print(f'✗ {name} [{x.get("mode")}]: 状态码不同 node={x.get("status")} go={y.get("status")}')
    if not same_body:
        print(f'✗ {name} [{x.get("mode")}]: 响应骨架/内容不同')
        print('   node:', json.dumps(x.get('body'), ensure_ascii=False, sort_keys=True)[:700])
        print('   go  :', json.dumps(y.get('body'), ensure_ascii=False, sort_keys=True)[:700])

total = len(names_a)
print()
if diff == 0:
    extra = f'，{known} 处已知差异' if known else ''
    print(f'✓ {total} 个步骤完全一致（按各自模式比较）{extra}')
else:
    print(f'✗ {diff} / {total} 个步骤存在差异，{known} 处已知差异')
sys.exit(0 if diff == 0 else 1)
PY
rc=$?
echo "（产物：$WORK/node.json / $WORK/go.json）"
exit $rc
