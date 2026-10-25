#!/usr/bin/env bash
# ani-subs（/api/stream/anisubs/*）—— Node ↔ Go HTTP 对拍。
#
# 上游是本地假站（scripts/mock-anisubs.js）：订阅 JSON + 列表页（a 格式 /
# JSONPath 格式）+ 详情页（无线路 / 线路分组）+ 剧集页 + RSS。
# 数据固定 → 全部按「状态码 + 完整响应体」比较。抓站逻辑（选择器、JSONPath、
# 正则规则、URL 补全、Referer 回落）正是最容易两侧走样的地方。
#
# 用法：bash backend-go/scripts/http-anisubs-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-anisubs
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-anisubs-driver.js"
MOCK="$REPO/backend-go/scripts/mock-anisubs.js"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

# ---------------------------------------------------------------------------
# 假上游（两侧共用，保证数据完全一致）
# ---------------------------------------------------------------------------
MOCK_PORT=$(pick_port)
echo "=== 启动假站（端口 $MOCK_PORT）==="
"$NODE" "$MOCK" "$MOCK_PORT" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if grep -q "^$MOCK_PORT$" "$WORK/mock.log" 2>/dev/null; then break; fi
  sleep 0.2
done
if ! grep -q "^$MOCK_PORT$" "$WORK/mock.log" 2>/dev/null; then
  echo "!! 假站未就绪"; cat "$WORK/mock.log"; kill_tree "$MOCK_PID"; exit 1
fi
MOCK_URL="http://127.0.0.1:$MOCK_PORT"

echo "=== 种子：普通用户 + ani-subs 订阅配置 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('anisubs-pass-1234',10))")
seed_db() {
  "$PY" - "$1" "$HASH" "$MOCK_URL" <<'PY'
import json, sqlite3, sys
db, pw, mock = sys.argv[1], sys.argv[2], sys.argv[3]
c = sqlite3.connect(db)

c.execute('DELETE FROM "user" WHERE "username"=?', ('anisubs-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('anisubs-user', pw, 'user', 'active'))

# 只写 dataSourceConfig，其余列走默认值；先清空避免 dev.sqlite 里的真实订阅干扰。
config = json.dumps({'aniSubsSubscriptions': [mock + '/sub.json']}, ensure_ascii=False)
c.execute('DELETE FROM "system_settings"')
c.execute('INSERT INTO "system_settings" ("dataSourceConfig") VALUES (?)', (config,))

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
  echo "!! Node 后端未就绪"; tail -20 "$WORK/node.log"; kill_tree "$NODE_PID"; kill_tree "$MOCK_PID"; exit 1
fi

echo "=== 在 Node 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" "$MOCK_URL" || {
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
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; kill_tree "$MOCK_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" "$MOCK_URL" || {
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

KNOWN_DIFFS = {}

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
