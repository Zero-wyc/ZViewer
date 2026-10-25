#!/usr/bin/env bash
# config/ 目录双向兼容验证（阶段 5 检查单第 3 项）。
#
# 目的：切到 Go 之后如果想回滚到 Node，`config/` 里的东西必须还能被 Node 读。
# 这份目录里只有四类东西：dev.sqlite（sql.js 全量写 vs SQLite 页写）、
# jwt-secrets.json、ssl/、uploads|media。
#
# 三轮跑同一个驱动器（写标记 → 注册账号 → 加根目录），比较快照：
#
#   Go 第一次   ：before 为空 → 写入 go 标记
#   Node 第二次 ：before **必须等于** Go 的 after（证明 Node 读得懂 Go 写的东西），
#                 再写入 node 标记
#   Go 第三次   ：before **必须等于** Node 的 after（证明 Go 读得懂 Node 写的）
#
# 另外两条硬断言：
#   - Node 启动后 jwt-secrets.json 的 sha256 不变（能解析、没重生成——否则
#     回滚瞬间全部已签发 token 失效）；
#   - 证书互操作：Node 生成的 ssl/ 能被 Go 加载；Go 生成的能被 Node 加载。
#
# 用法：bash backend-go/scripts/config-roundtrip.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=config-roundtrip
WORK=/tmp/zv-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/config-roundtrip-driver.js"

ADMIN_USER=cfg-admin
ADMIN_PASS=cfg-admin-pass

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/cfg" "$WORK/media" "$WORK/uploads"
cp "$REPO/config/dev.sqlite" "$WORK/cfg/dev.sqlite"
CFG=$(cygpath -w "$WORK/cfg")
DB="$CFG\\dev.sqlite"
UPLOADS=$(cygpath -w "$WORK/uploads")
MEDIA=$(cygpath -w "$WORK/media")

pass=0
fail=0
check() {
  local name="$1" cond="$2"
  if [ "$cond" = "0" ]; then
    echo "  ✓ $name"
    pass=$((pass + 1))
  else
    echo "  ✗ $name"
    fail=$((fail + 1))
  fi
}

echo "=== 种子：admin 账号 ==="
ADMIN_HASH=$("$NODE" -e "console.log(require('bcryptjs').hashSync('$ADMIN_PASS',10))")
"$PY" - "$WORK/cfg/dev.sqlite" "$ADMIN_HASH" "$ADMIN_USER" <<'PY'
import sqlite3, sys
db, pw_hash, name = sys.argv[1:4]
c = sqlite3.connect(db)
c.execute('DELETE FROM "user" WHERE "username"=?', (name,))
# 必须是 root：/api/server-files/roots 只允许超级管理员（admin 会 403）
c.execute('INSERT INTO "user" ("username","passwordHash","role","status") VALUES (?,?,?,?)',
          (name, pw_hash, 'root', 'active'))
c.commit()
PY

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

start_go() {
  local port=$1 log=$2
  (
    PORT="$port" DATABASE_URL="$DB" CONFIG_DIR="$CFG" UPLOADS_DIR="$UPLOADS" \
    MEDIA_DIR="$MEDIA" PROJECT_ROOT="$CFG" \
    "$GOBIN" > "$log" 2>&1
  ) &
  GO_PID=$!
  wait_ready "$port" "Go 后端" "$log" "监听"
}

start_node() {
  local port=$1 log=$2
  (
    cd "$REPO/backend" || exit 1
    PORT="$port" DATABASE_URL="$DB" CONFIG_DIR="$CFG" UPLOADS_DIR="$UPLOADS" \
    MEDIA_DIR="$MEDIA" PROJECT_ROOT="$CFG" STREAM_PUSH_ENABLED=0 \
    "$NODE" ../node_modules/ts-node-dev/lib/bin.js --transpile-only src/index.ts \
      > "$log" 2>&1
  ) &
  NODE_PID=$!
  wait_ready "$port" "Node 后端" "$log" "Server is running on"
}

# ---------------------------------------------------------------------------
# 1. Go 写
# ---------------------------------------------------------------------------
echo "=== 1. Go 写（settings / 注册 / 根目录）==="
PORT=$(pick_port)
if ! start_go "$PORT" "$WORK/go1.log"; then
  echo "!! Go 未就绪"; tail -20 "$WORK/go1.log"; exit 1
fi
"$NODE" "$DRIVER" "http://127.0.0.1:$PORT" "$WORK/go1.json" go \
  "$ADMIN_USER" "$ADMIN_PASS" "$MEDIA" || echo "!! Go 驱动异常"
JWT_HASH_GO=$("$PY" - "$WORK/cfg/jwt-secrets.json" <<'PY'
import hashlib, sys
try:
    print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())
except FileNotFoundError:
    print('missing')
PY
)
kill_tree "$GO_PID"
sleep 0.3
[ "$JWT_HASH_GO" != "missing" ]; check "Go 生成了 jwt-secrets.json" $?
[ -f "$WORK/cfg/dev.sqlite" ]; check "dev.sqlite 仍在" $?

# ---------------------------------------------------------------------------
# 2. Node 读（+ 写 node 标记）
# ---------------------------------------------------------------------------
echo "=== 2. Node 读 Go 写的数据 ==="
PORT=$(pick_port)
if ! start_node "$PORT" "$WORK/node1.log"; then
  echo "!! Node 未就绪"; tail -20 "$WORK/node1.log"; kill_tree "$NODE_PID"; exit 1
fi
JWT_HASH_NODE=$("$PY" - "$WORK/cfg/jwt-secrets.json" <<'PY'
import hashlib, sys
try:
    print(hashlib.sha256(open(sys.argv[1], 'rb').read()).hexdigest())
except FileNotFoundError:
    print('missing')
PY
)
[ "$JWT_HASH_NODE" = "$JWT_HASH_GO" ]; check "Node 启动后 jwt-secrets.json 未被重写（能解析且复用）" $?

"$NODE" "$DRIVER" "http://127.0.0.1:$PORT" "$WORK/node1.json" node \
  "$ADMIN_USER" "$ADMIN_PASS" "$MEDIA" || echo "!! Node 驱动异常"
# sql.js 是 autoSave（写后即导出），但落盘是异步的：留一拍再杀，
# 否则下一步 Go 读到的是「Node 写之前」的文件，会误判成不兼容。
sleep 1
kill_tree "$NODE_PID"
sleep 0.3

# ---------------------------------------------------------------------------
# 3. Go 读 Node 写的数据
# ---------------------------------------------------------------------------
echo "=== 3. Go 读 Node 写的数据 ==="
PORT=$(pick_port)
if ! start_go "$PORT" "$WORK/go2.log"; then
  echo "!! Go 未就绪"; tail -20 "$WORK/go2.log"; exit 1
fi
"$NODE" "$DRIVER" "http://127.0.0.1:$PORT" "$WORK/go2.json" go \
  "$ADMIN_USER" "$ADMIN_PASS" "$MEDIA" || echo "!! Go 驱动异常"
kill_tree "$GO_PID"

# ---------------------------------------------------------------------------
# 4. 证书互操作
# ---------------------------------------------------------------------------
echo "=== 4a. Node 生成的证书 → Go 能加载 ==="
mkdir -p "$WORK/ssl-a/ssl"
cp "$REPO/config/ssl/cert.pem" "$REPO/config/ssl/key.pem" "$WORK/ssl-a/ssl/" 2>/dev/null
CFG_A=$(cygpath -w "$WORK/ssl-a")
if [ -f "$WORK/ssl-a/ssl/cert.pem" ]; then
  PORT=$(pick_port)
  (
    HTTPS=true PORT="$PORT" DATABASE_URL="$DB" CONFIG_DIR="$CFG_A" UPLOADS_DIR="$UPLOADS" \
    PROJECT_ROOT="$CFG_A" "$GOBIN" > "$WORK/https-go.log" 2>&1
  ) &
  GO_PID=$!
  wait_ready "$PORT" "Go(HTTPS)" "$WORK/https-go.log" "监听" >/dev/null 2>&1
  BODY=$(curl -sk --max-time 8 "https://127.0.0.1:$PORT/health" 2>/dev/null)
  echo "$BODY" | grep -q '"status":"ok"'; check "Go 用 node-forge 生成的 cert/key 起 HTTPS 并应答 /health" $?
  kill_tree "$GO_PID"
else
  echo "  · 跳过（仓库 config/ssl 没有证书）"
fi

echo "=== 4b. Go 生成的证书 → Node 能加载 ==="
mkdir -p "$WORK/ssl-b"
CFG_B=$(cygpath -w "$WORK/ssl-b")
CONFIG_DIR="$CFG_B" "$GOBIN" --gen-cert 127.0.0.1 > "$WORK/gencert.log" 2>&1
[ -f "$WORK/ssl-b/ssl/cert.pem" ]; check "Go --gen-cert 生成证书" $?
PORT=$(pick_port)
(
  cd "$REPO/backend" || exit 1
  HTTPS=true PORT="$PORT" DATABASE_URL="$DB" CONFIG_DIR="$CFG_B" UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$CFG_B" STREAM_PUSH_ENABLED=0 \
  "$NODE" ../node_modules/ts-node-dev/lib/bin.js --transpile-only src/index.ts \
    > "$WORK/https-node.log" 2>&1
) &
NODE_PID=$!
wait_ready "$PORT" "Node(HTTPS)" "$WORK/https-node.log" "Server is running on" >/dev/null 2>&1
BODY=$(curl -sk --max-time 8 "https://127.0.0.1:$PORT/health" 2>/dev/null)
echo "$BODY" | grep -q '"status"'; check "Node 用 Go 生成的 cert/key 起 HTTPS 并应答 /health" $?
kill_tree "$NODE_PID"

# ---------------------------------------------------------------------------
# 5. 快照对比
# ---------------------------------------------------------------------------
echo "=== 5. 快照对比 ==="
"$PY" - "$WORK/go1.json" "$WORK/node1.json" "$WORK/go2.json" <<'PY'
import json, sys

go1 = json.load(open(sys.argv[1], encoding='utf-8'))
node1 = json.load(open(sys.argv[2], encoding='utf-8'))
go2 = json.load(open(sys.argv[3], encoding='utf-8'))

diff = 0
for name, obj in (('go1', go1), ('node1', node1), ('go2', go2)):
    if 'error' in obj:
        print(f'✗ {name} 驱动异常: {obj["error"][:400]}')
        diff += 1

GO_MARK = {'autoDeleteAfterHours': 41, 'roomDefaultMusicVolume': 41, 'dashDisabled': True,
           'registrationMode': 'open', 'autoDeleteInactiveRooms': True}
NODE_MARK = {'autoDeleteAfterHours': 52, 'roomDefaultMusicVolume': 52, 'dashDisabled': False,
             'registrationMode': 'open', 'autoDeleteInactiveRooms': True}

def cmp(label, left, right):
    global diff
    if left == right:
        print(f'  ✓ {label}')
    else:
        diff += 1
        print(f'  ✗ {label}')
        print('     left :', json.dumps(left, ensure_ascii=False, sort_keys=True))
        print('     right:', json.dumps(right, ensure_ascii=False, sort_keys=True))

if 'error' not in go1 and 'error' not in node1 and 'error' not in go2:
    # Go 自己写进去的必须原样读回来
    cmp('Go: after 快照等于写入的标记', go1['after']['settings'], GO_MARK)
    cmp('Go: 注册的账号出现在用户列表', 'u-go' in go1['after']['users']['names'], True)
    cmp('Go: 新根目录出现在列表', 'root-go' in go1['after']['roots']['names'], True)
    cmp('Go: 新账号能登录', go1['after']['logins']['u-go'], 200)

    # Node 读到的是 Go 写的
    cmp('Node: before.settings == Go after.settings', node1['before']['settings'], go1['after']['settings'])
    cmp('Node: before.roots == Go after.roots', node1['before']['roots']['names'], go1['after']['roots']['names'])
    cmp('Node: before.users == Go after.users', node1['before']['users']['names'], go1['after']['users']['names'])
    cmp('Node: Go 注册的账号能登录（bcrypt 哈希兼容）', node1['before']['logins']['u-go'], 200)

    # Node 写完之后再交给 Go 读
    cmp('Node: after 快照等于写入的标记', node1['after']['settings'], NODE_MARK)
    cmp('Go 二次: before.settings == Node after.settings', go2['before']['settings'], node1['after']['settings'])
    cmp('Go 二次: before.roots == Node after.roots', go2['before']['roots']['names'], node1['after']['roots']['names'])
    cmp('Go 二次: Node 注册的账号能登录（bcrypt 哈希兼容）', go2['before']['logins']['u-node'], 200)
    cmp('Go 二次: 两个账号都在用户列表', go2['before']['users']['names'],
        sorted(['u-go', 'u-node'] + [n for n in go2['before']['users']['names']
                                     if n not in ('u-go', 'u-node')]))

sys.exit(0 if diff == 0 else 1)
PY
SNAP_CODE=$?

echo
if [ "$fail" -eq 0 ] && [ "$SNAP_CODE" -eq 0 ]; then
  echo "✓ $pass 项硬件断言 + 快照对比全部通过"
else
  echo "✗ 存在失败项（硬件断言 $fail 项，快照差异见上）"
  exit 1
fi
