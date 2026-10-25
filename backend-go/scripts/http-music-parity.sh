#!/usr/bin/env bash
# 一起听（/api/music/*）—— Node ↔ Go HTTP 对拍。
#
# 上游是本地假 NCM 服务（scripts/mock-ncm.js）：两侧都通过 NCM_API_BASE 指过去，
# 数据固定 → 全部按「状态码 + 完整响应体」比较（302 那几步只比 Location）。
#
# Node 侧需要把内部 NCM 服务换成「指向假服务」的桩：scripts/ncm-parity-preload.js
# 在加载前把 ncm-api.service 的编译产物塞进 require.cache。详见该文件注释。
#
# 覆盖：游客分支 / Cookie 登录（两种输入格式）/ 凭证落库与退出 / 转发注入 cookie 与
# 剥 cookie·noCookie / 扫码三接口不带 cookie / 上游 3xx 与非 JSON / 专辑匿名补齐 /
# 音质降级链（试听、无版权、非白名单域名、老接口回退）/ 直链 302 与缓存 /
# 音质元数据与缓存 / 云盘 multipart 透传。
#
# 用法：bash backend-go/scripts/http-music-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-music
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-music-driver.js"
MOCK="$REPO/backend-go/scripts/mock-ncm.js"
PRELOAD="$REPO/backend-go/scripts/ncm-parity-preload.js"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

# ---------------------------------------------------------------------------
# 假 NCM 上游（两侧共用）
# ---------------------------------------------------------------------------
MOCK_PORT=$(pick_port)
echo "=== 启动假 NCM 服务（端口 $MOCK_PORT）==="
"$NODE" "$MOCK" "$MOCK_PORT" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do
  if grep -q "^$MOCK_PORT$" "$WORK/mock.log" 2>/dev/null; then break; fi
  sleep 0.2
done
if ! grep -q "^$MOCK_PORT$" "$WORK/mock.log" 2>/dev/null; then
  echo "!! 假服务未就绪"; cat "$WORK/mock.log"; kill_tree "$MOCK_PID"; exit 1
fi
MOCK_URL="http://127.0.0.1:$MOCK_PORT"

echo "=== 种子：普通用户（不预置网易云凭证，登录链路要自己走一遍）==="
HASH=$(cd "$REPO" && node -e "console.log(require('bcryptjs').hashSync('music-pass-1234',10))")
seed_db() {
  "$PY" - "$1" "$HASH" <<'PY'
import sqlite3, sys
db, pw = sys.argv[1], sys.argv[2]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', ('music-user',))
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          ('music-user', pw, 'user', 'active'))
# 清掉历史凭证：否则「登录前是未登录」这一步会撞上真实环境里的残留
c.execute('DELETE FROM "ncm_credential"')
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
  NCM_API_BASE="$MOCK_URL" \
  "$NODE" -r ts-node/register/transpile-only -r "$PRELOAD" src/index.ts \
    > "$WORK/node.log" 2>&1
) &
NODE_PID=$!

if ! wait_ready "$NODE_PORT" "Node 后端" "$WORK/node.log" "Server is running on"; then
  echo "!! Node 后端未就绪"; tail -20 "$WORK/node.log"; kill_tree "$NODE_PID"; kill_tree "$MOCK_PID"; exit 1
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
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$GO_CONFIG" \
  PORT=$GO_PORT \
  NCM_API_BASE="$MOCK_URL" \
  "$GOBIN" > "$WORK/go.log" 2>&1
) &
GO_PID=$!

if ! wait_ready "$GO_PORT" "Go 后端" "$WORK/go.log" "监听"; then
  echo "!! Go 后端未就绪"; tail -20 "$WORK/go.log"; kill_tree "$GO_PID"; kill_tree "$MOCK_PID"; exit 1
fi

echo "=== 在 Go 上跑驱动器 ==="
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" || {
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
    same_location = x.get('location') == y.get('location')
    if same_status and same_body and same_location:
        continue
    if name in KNOWN_DIFFS:
        known += 1
        print(f'~ {name}: 已知差异（{KNOWN_DIFFS[name]}）')
        continue
    diff += 1
    if not same_status:
        print(f'✗ {name}: 状态码不同 node={x.get("status")} go={y.get("status")}')
    if not same_location:
        print(f'✗ {name}: Location 不同 node={x.get("location")} go={y.get("location")}')
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
