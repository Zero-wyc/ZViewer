#!/usr/bin/env bash
set -u
REPO=/f/Code/ZViewer/ZViewer
TESTDIR=/tmp/zvtest
PORT=3401

rm -rf "$TESTDIR"; mkdir -p "$TESTDIR"
cp "$REPO/config/dev.sqlite" "$TESTDIR/dev.sqlite"

CONFIG_DIR="$TESTDIR" PORT="$PORT" PROJECT_ROOT="$REPO" /tmp/zviewerd.exe > "$TESTDIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null' EXIT

for i in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/health"; then break; fi
  sleep 0.25
done

echo "=== 1. /health ==="
curl -s "http://127.0.0.1:$PORT/health"; echo

echo "=== 2. POST /api/auth/guest ==="
GUEST=$(curl -s -X POST "http://127.0.0.1:$PORT/api/auth/guest")
echo "$GUEST" | head -c 400; echo

GO_ACCESS=$(echo "$GUEST" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).accessToken||'')}catch(e){console.log('')}})")
echo "Go 签发 accessToken 长度: ${#GO_ACCESS}"

echo "=== 3. Go token -> Go /me ==="
curl -s -H "Authorization: Bearer $GO_ACCESS" "http://127.0.0.1:$PORT/api/auth/me"; echo

echo "=== 4. 反向：Node 用同一密钥签发，交给 Go 验证 ==="
NODE_RESULT=$(cd "$REPO" && GO_ACCESS="$GO_ACCESS" TESTDIR="$TESTDIR" node -e "
const fs=require('fs'), path=require('path'), jwt=require('jsonwebtoken');
const secrets=JSON.parse(fs.readFileSync(path.join(process.env.TESTDIR,'jwt-secrets.json'),'utf8'));
// (a) Node 校验 Go 签发的 token
const decoded=jwt.verify(process.env.GO_ACCESS, secrets.access);
// (b) Node 签发一个 token 供 Go 校验
const t=jwt.sign({userId:0,role:'guest',username:'guest',issuedAtMs:Date.now(),guestId:'node-signed-001'}, secrets.access, {expiresIn:'1h'});
console.log(JSON.stringify({decoded, nodeToken:t}));
")
echo "$NODE_RESULT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const o=JSON.parse(s);console.log('Node 解析 Go token ->', JSON.stringify(o.decoded))})"

NODE_TOKEN=$(echo "$NODE_RESULT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).nodeToken)})")
echo "=== 5. Node token -> Go /me ==="
curl -s -H "Authorization: Bearer $NODE_TOKEN" "http://127.0.0.1:$PORT/api/auth/me"; echo

echo "=== 6. 无 token 访问 /me ==="
curl -s -o /dev/null -w "status=%{http_code}\n" "http://127.0.0.1:$PORT/api/auth/me"

echo "=== 7. 公开设置 ==="
curl -s "http://127.0.0.1:$PORT/api/auth/public-settings"; echo

echo "=== 8. 未知 API 路径 ==="
curl -s -o /dev/null -w "status=%{http_code}\n" "http://127.0.0.1:$PORT/api/nope"

echo "=== 服务器日志 ==="
cat "$TESTDIR/server.log"
