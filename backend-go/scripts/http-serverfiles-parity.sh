#!/usr/bin/env bash
# 服务器文件 / 统计 / 客户端日志 / 直链解析 / CLI 代理 —— Node ↔ Go HTTP 对拍。
#
# 与 sio-* 系列脚本共用同一套「起两侧真后端 + 逐步骤 diff」机制，区别在于：
# 这次比的是 HTTP 响应（状态码 + 头 + 体），不是 socket 事件流。
#
# 两侧各自有一份结构完全相同的目录树（uploads/ + custom/），驱动器把绝对路径
# 规范化成 <UPLOADS>/<CUSTOM>、时间戳规范化成 <TIME> 后逐步骤比较。
#
# 用法：bash backend-go/scripts/http-serverfiles-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-files
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-serverfiles-driver.js"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

# ---------------------------------------------------------------------------
# 目录树：两侧必须逐项一致（驱动器按名字比对排序与内容）
# ---------------------------------------------------------------------------
make_tree() {
  local base=$1
  rm -rf "$base/uploads" "$base/custom"
  mkdir -p "$base/uploads/dirA" "$base/uploads/dirB" "$base/uploads/avatars" "$base/custom"
  printf '12345' > "$base/uploads/z.mp4"                    # 5 字节
  printf '0123456789' > "$base/uploads/sample.mkv"          # 10 字节
  printf 'hidden' > "$base/uploads/.hidden"                 # 隐藏文件，必须被过滤
}
make_tree "$WORK/node"
make_tree "$WORK/go"

# 交给两个后端的路径必须是**规范 Windows 形式**（cygpath -w）。
#
# 不是洁癖：Node 的 `UPLOADS_ROOT` 直接取 env 原值、不做 path.resolve，
# 而 add-root 拿 `path.resolve(absPath)` 与之比较。只要 env 是 POSIX
# （/tmp/...）或正斜杠形式（C:/a/b），两边字符串就不相等，
# 「该目录已是默认空间」的守卫会静默失效，进而让后面对 readonly 根的
# 四个断言全部走偏。生产环境 UPLOADS_DIR 缺省时是 path.join 出来的规范
# 形式，所以只有把测试路径也规范成同一形态，才是在测真实行为。
win() { cygpath -w "$1"; }
NODE_UPLOADS=$(win "$WORK/node/uploads")
NODE_CUSTOM=$(win "$WORK/node/custom")
NODE_CONFIG=$(win "$WORK/node")
NODE_DB=$(win "$WORK/node/dev.sqlite")
GO_UPLOADS=$(win "$WORK/go/uploads")
GO_CUSTOM=$(win "$WORK/go/custom")
GO_CONFIG=$(win "$WORK/go")
GO_DB=$(win "$WORK/go/dev.sqlite")

echo "=== 种子：账号 + 清空自定义根目录表 ==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('sio-pass-1234',10))")
seed_db() {
  "$PY" - "$1" "$HASH" <<'PY'
import sqlite3, sys
db, pw = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
for name, role in (('sio-owner', 'root'), ('sio-viewer', 'user')):
    c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
    c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
              (name, pw, role, 'active'))
# 自定义根目录表必须清空并重置自增：驱动器断言 custom:1 这个 key
c.execute('DELETE FROM "server_folder"')
c.execute('DELETE FROM sqlite_sequence WHERE name = "server_folder"')
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
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" \
  "$NODE_UPLOADS" "$NODE_CUSTOM" || {
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
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" \
  "$GO_UPLOADS" "$GO_CUSTOM" || {
  echo "!! Go 驱动失败"; head -20 "$WORK/go.json"
}
kill_tree "$GO_PID"

# ---------------------------------------------------------------------------
# 比较
# ---------------------------------------------------------------------------
echo "=== 逐步骤比较 ==="
"$PY" - "$WORK/node.json" "$WORK/go.json" <<'PY'
import json, sys

# 已知且刻意保留的差异：Node 侧 multer 的 cb(error) 走 express 默认错误处理，
# 回的是 500 + HTML；Go 回 400 + JSON 文案。前端只需知道「没成功」，
# 返回可读文案比 HTML 堆栈更有用，故不修。
KNOWN_DIFFS = {
    'upload-readonly-root': 'Node 回 500+HTML（multer 错误直落 express 默认处理器），Go 回 400+JSON',
}

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
    same_status = x.get('status') == y.get('status')
    same_body = x.get('body') == y.get('body')
    if same_status and same_body:
        continue
    if name in KNOWN_DIFFS:
        known += 1
        print(f'~ {name}: 已知差异（{KNOWN_DIFFS[name]}）')
        print(f'   node: {x.get("status")} {json.dumps(x.get("body"), ensure_ascii=False)[:160]}')
        print(f'   go  : {y.get("status")} {json.dumps(y.get("body"), ensure_ascii=False)[:160]}')
        continue
    diff += 1
    if not same_status:
        print(f'✗ {name}: 状态码不同 node={x.get("status")} go={y.get("status")}')
    if not same_body:
        print(f'✗ {name}: 响应体不同')
        print('   node:', json.dumps(x.get('body'), ensure_ascii=False, sort_keys=True)[:600])
        print('   go  :', json.dumps(y.get('body'), ensure_ascii=False, sort_keys=True)[:600])

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
