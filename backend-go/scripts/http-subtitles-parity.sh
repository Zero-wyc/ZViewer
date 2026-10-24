#!/usr/bin/env bash
# 字幕端点（/api/subtitles/*）—— Node ↔ Go HTTP 对拍。
#
# 与 http-serverfiles-parity.sh 同一套机制：起两侧真后端，驱动器按固定影片 id
# 打请求，逐步骤比「状态码 + 响应体」。
#
# 两侧各自有一份结构完全相同的 uploads/ 目录树（影片路径都走 uploads: 前缀，
# 所以库里存的是相对路径，两边同构）。远端源（webdav/ftp/openlist）本轮只覆盖
# 「缺 serverUrl → 400」这类不需要真实服务器的分支；真实取数由各自的
# package 单测与 mount 对拍脚本覆盖。
#
# 用法：bash backend-go/scripts/http-subtitles-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=http-subtitles
WORK=/tmp/zvhttp-$TAG
PY=C:/Users/Zero_/.workbuddy/binaries/python/versions/3.13.12/python.exe
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
GOBIN="$WORK/zviewerd.exe"
DRIVER="$REPO/backend-go/scripts/http-subtitles-driver.js"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/node" "$WORK/go"
cp "$REPO/config/dev.sqlite" "$WORK/node/dev.sqlite"
cp "$REPO/config/dev.sqlite" "$WORK/go/dev.sqlite"

# ---------------------------------------------------------------------------
# 目录树：两侧逐项一致（驱动器断言条目名、顺序、size）
# ---------------------------------------------------------------------------
make_tree() {
  local base=$1
  rm -rf "$base/uploads"
  mkdir -p "$base/uploads/anime/sub" "$base/uploads/other"
  printf 'video-ep01'      > "$base/uploads/anime/EP01.mkv"
  printf '1\n00:00:01,000 --> 00:00:02,000\nchs\n' > "$base/uploads/anime/EP01.chs.srt"
  printf '[Script Info]\n' > "$base/uploads/anime/EP01.ass"
  printf 'other-episode'   > "$base/uploads/anime/EP02.srt"
  printf 'not-a-subtitle'  > "$base/uploads/anime/EP01.txt"
  printf 'hidden'          > "$base/uploads/anime/.hidden"
  printf 'inside'          > "$base/uploads/anime/sub/inside.mkv"
  printf 'a'               > "$base/uploads/anime/阿凡达.srt"
  printf 'b'               > "$base/uploads/anime/波西米亚.srt"
  printf 'readme'          > "$base/uploads/other/readme.txt"
}
make_tree "$WORK/node"
make_tree "$WORK/go"

# 交给两个后端的路径必须是规范 Windows 形式（见 http-serverfiles-parity.sh
# 里那段长注释：Node 的 UPLOADS_ROOT 取 env 原值、不做 path.resolve）。
win() { cygpath -w "$1"; }
NODE_UPLOADS=$(win "$WORK/node/uploads")
NODE_CONFIG=$(win "$WORK/node")
NODE_DB=$(win "$WORK/node/dev.sqlite")
GO_UPLOADS=$(win "$WORK/go/uploads")
GO_CONFIG=$(win "$WORK/go")
GO_DB=$(win "$WORK/go/dev.sqlite")

echo "=== 种子：账号 + 房间 + 固定 id 的影片 ==="
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

owner_id = c.execute('SELECT "id" FROM "user" WHERE "username"=?', ('sio-owner',)).fetchone()[0]

# 房间必须把 lastAccessedAt 设成 now：Node 的 room-cleanup 定时器启动即跑一轮，
# lastAccessedAt 超期的 active 房间会被它单侧删掉，表现为「403 准入失败」这种
# 莫名其妙的差异。
c.execute("DELETE FROM \"room\" WHERE \"roomId\" IN ('SUBROOM','OTHERROOM')")
c.execute('DELETE FROM "session"')
c.execute("DELETE FROM \"movie\"")

for room_id, owner in (('SUBROOM', owner_id), ('OTHERROOM', None)):
    c.execute('''INSERT INTO "room"
                 ("roomId","name","status","mode","ownerUserId","password","maxViewers","lastAccessedAt")
                 VALUES (?,?,?,?,?,?,?,datetime('now'))''',
              (room_id, 'Subtitle Room ' + room_id, 'active', 'screen-share', owner, None, 10))

# 固定 id，驱动器按 id 打请求。
#   id, roomId,      source,        path,                  serverUrl
movies = (
    (1,  'SUBROOM',   'server-files', 'uploads:/anime/EP01.mkv', None),
    (2,  'SUBROOM',   'bilibili',     None,                      None),
    (3,  'SUBROOM',   'server-files', None,                      None),
    (4,  'SUBROOM',   'emby',         'item-1',                  None),
    (5,  'SUBROOM',   'webdav',       '/d/a.mkv',                None),
    (6,  'SUBROOM',   'ftp',          '/d/a.mkv',                None),
    (7,  'SUBROOM',   'openlist',     '/d/a.mkv',                None),
    (8,  'OTHERROOM', 'server-files', 'uploads:/anime/EP01.mkv', None),
    (9,  'SUBROOM',   'server-files', 'uploads:/other/EP02.mkv', None),
    (10, 'SUBROOM',   'emby',         None,                      'http://127.0.0.1:1'),
)
for mid, room_id, source, path, server_url in movies:
    c.execute('''INSERT INTO "movie" ("id","roomId","url","title","source","path","serverUrl")
                 VALUES (?,?,?,?,?,?,?)''',
              (mid, room_id, 'http://example.invalid/v.mp4', 'Movie ' + str(mid),
               source, path, server_url))

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
"$NODE" "$DRIVER" "http://127.0.0.1:$NODE_PORT" "$WORK/node.json" "$NODE_UPLOADS" || {
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
"$NODE" "$DRIVER" "http://127.0.0.1:$GO_PORT" "$WORK/go.json" "$GO_UPLOADS" || {
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
        print(f'   node: {x.get("status")} {json.dumps(x.get("body"), ensure_ascii=False)[:200]}')
        print(f'   go  : {y.get("status")} {json.dumps(y.get("body"), ensure_ascii=False)[:200]}')
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
