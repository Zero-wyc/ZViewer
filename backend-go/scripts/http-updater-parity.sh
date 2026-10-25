#!/usr/bin/env bash
# 更新器（/api/system/update/*）—— Node ↔ Go HTTP 对拍。
#
# 只比「拒绝路径」：成功路径会真的下载发布包、覆盖程序文件并拉起一个
# 先杀本进程的更新脚本，在对拍机上跑等于自毁。覆盖范围与理由见
# http-updater-driver.js 头部。
#
# 版本判定（releases → hasUpdate / 产物选择）另走
# `node backend-go/scripts/gen-updater-fixtures.js` + Go 单测，
# 因为 GitHub API 是硬编码域名，起不了假站。
#
# 用法：bash backend-go/scripts/http-updater-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-updater
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-updater-driver.js"

ROOT_USER=updater-root
ROOT_PASS=updater-root-pass
NORMAL_USER=updater-user
NORMAL_PASS=updater-user-pass

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

echo "=== 种子：root 与普通用户 ==="
ROOT_HASH=$(cd "$REPO" && "$NODE" -e "console.log(require('bcryptjs').hashSync('$ROOT_PASS',10))")
USER_HASH=$(cd "$REPO" && "$NODE" -e "console.log(require('bcryptjs').hashSync('$NORMAL_PASS',10))")
seed_db() {
  "$PY" - "$1" "$ROOT_HASH" "$USER_HASH" "$ROOT_USER" "$NORMAL_USER" <<'PY'
import sqlite3, sys
db, root_hash, user_hash, root_name, user_name = sys.argv[1:6]
c = sqlite3.connect(db)
for name in (root_name, user_name):
    c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          (root_name, root_hash, 'root', 'active'))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          (user_name, user_hash, 'user', 'active'))
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
  "$ROOT_USER" "$ROOT_PASS" "$NORMAL_USER" "$NORMAL_PASS" || {
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
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$GO_CONFIG" \
  PORT=$GO_PORT \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$GO_PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" \
  "$ROOT_USER" "$ROOT_PASS" "$NORMAL_USER" "$NORMAL_PASS" || {
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

    mode = x.get('mode', 'exact')
    if x.get('status') != y.get('status'):
        diff += 1
        print(f'✗ {name}: 状态码不同 node={x.get("status")} go={y.get("status")}')
        continue
    if mode == 'status':
        continue
    if mode == 'raw':
        if x.get('text') != y.get('text'):
            diff += 1
            print(f'✗ {name}: 原文不同')
            print('   node:', json.dumps(x.get('text'), ensure_ascii=False)[:500])
            print('   go  :', json.dumps(y.get('text'), ensure_ascii=False)[:500])
        continue
    if x.get('body') != y.get('body'):
        diff += 1
        print(f'✗ {name}: 响应体不同')
        print('   node:', json.dumps(x.get('body'), ensure_ascii=False, sort_keys=True)[:500])
        print('   go  :', json.dumps(y.get('body'), ensure_ascii=False, sort_keys=True)[:500])

total = len(names_a)
print()
if diff == 0:
    print(f'✓ {total} 个步骤完全一致')
else:
    print(f'✗ {diff} / {total} 个步骤存在差异')
sys.exit(0 if diff == 0 else 1)
PY
