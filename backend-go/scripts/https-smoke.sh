#!/usr/bin/env bash
# HTTPS / 证书冒烟：`--gen-cert` CLI 与 HTTPS 模式启动。
#
# 为什么没有对拍脚本：ACME 需要一个真实的公网域名 + 80 端口可达，
# 对拍机上无法复现。这里的做法是：
#   - CLI 参数解析、自签证书、HTTPS 启动 → 本脚本（真跑二进制）
#   - ACME 协议本身 → internal/ssl/acme_test.go（假 ACME 服务器跑完整链路，
#     含「CA 真的来取 keyAuthorization」与 CSR 校验）
#
# 覆盖：
#   1. --gen-cert --help 的用法文案
#   2. --gen-cert 缺省生成自签（CN/SAN/有效期）
#   3. 二次运行跳过（不重签）
#   4. --gen-cert <域名> --selfsigned 把域名写进 SAN
#   5. HTTPS=true 且证书缺失 → 自动生成 + TLS 握手 + /health
#
# 用法：bash backend-go/scripts/https-smoke.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
TAG=https-smoke
WORK=/tmp/zv-$TAG
GOBIN="$WORK/zviewerd.exe"

script_dir=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib-proc.sh
. "$script_dir/lib-proc.sh"

rm -rf "$WORK"; mkdir -p "$WORK/cfg"
CFG=$(cygpath -w "$WORK/cfg")
DB="$CFG\\dev.sqlite"
UPLOADS="$CFG\\uploads"

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

echo "=== 编译 Go 服务 ==="
(cd "$REPO/backend-go" && go build -o "$GOBIN" ./cmd/zviewer-server) || exit 1

# ---------------------------------------------------------------------------
# 1. 用法
# ---------------------------------------------------------------------------
echo "=== 1. --gen-cert --help ==="
CONFIG_DIR="$CFG" "$GOBIN" --gen-cert --help > "$WORK/help.txt" 2>&1
grep -q "用法: zviewer-backend --gen-cert \[host\] \[选项\]" "$WORK/help.txt"; check "用法首行" $?
grep -q -- "--selfsigned    强制自签" "$WORK/help.txt"; check "含 --selfsigned 说明" $?
grep -q -- "--staging       使用 Let's Encrypt 测试环境" "$WORK/help.txt"; check "含 --staging 说明" $?

# ---------------------------------------------------------------------------
# 2. 自签（缺省 localhost）
# ---------------------------------------------------------------------------
echo "=== 2. --gen-cert 缺省自签 ==="
CONFIG_DIR="$CFG" "$GOBIN" --gen-cert > "$WORK/gen1.txt" 2>&1
check "退出码 0" $?
[ -f "$WORK/cfg/ssl/cert.pem" ]; check "生成 cert.pem" $?
[ -f "$WORK/cfg/ssl/key.pem" ]; check "生成 key.pem" $?
grep -q "证书主体: CN=localhost" "$WORK/gen1.txt"; check "日志含 CN=localhost" $?
grep -q "IP:127.0.0.1" "$WORK/gen1.txt"; check "SAN 含 127.0.0.1" $?
grep -q "IP:::1" "$WORK/gen1.txt"; check "SAN 含 ::1" $?

CN=$(openssl x509 -in "$WORK/cfg/ssl/cert.pem" -noout -subject 2>/dev/null | grep -c "CN *= *localhost")
check "openssl 读到 CN=localhost" $?

NOT_AFTER=$(openssl x509 -in "$WORK/cfg/ssl/cert.pem" -noout -enddate 2>/dev/null | cut -d= -f2)
NOT_BEFORE=$(openssl x509 -in "$WORK/cfg/ssl/cert.pem" -noout -startdate 2>/dev/null | cut -d= -f2)
YEARS=$(( ( $(date -d "$NOT_AFTER" +%s) - $(date -d "$NOT_BEFORE" +%s) ) / 31536000 ))
[ "$YEARS" -ge 9 ] && [ "$YEARS" -le 11 ]; check "有效期约 10 年（实际 ${YEARS}）" $?

# ---------------------------------------------------------------------------
# 3. 二次运行跳过
# ---------------------------------------------------------------------------
echo "=== 3. 二次运行应跳过 ==="
CONFIG_DIR="$CFG" "$GOBIN" --gen-cert > "$WORK/gen2.txt" 2>&1
grep -q "证书已存在（已包含 localhost），如需重新生成请加 --force" "$WORK/gen2.txt"; check "提示跳过" $?

BEFORE_HASH=$(openssl x509 -in "$WORK/cfg/ssl/cert.pem" -noout -fingerprint -sha256 2>/dev/null)
CONFIG_DIR="$CFG" "$GOBIN" --gen-cert --force > "$WORK/gen3.txt" 2>&1
AFTER_HASH=$(openssl x509 -in "$WORK/cfg/ssl/cert.pem" -noout -fingerprint -sha256 2>/dev/null)
[ "$BEFORE_HASH" != "$AFTER_HASH" ]; check "--force 会重签（指纹变化）" $?

# ---------------------------------------------------------------------------
# 4. 域名的自签
# ---------------------------------------------------------------------------
echo "=== 4. 域名强制自签 ==="
CONFIG_DIR="$CFG" "$GOBIN" --gen-cert example.lan --selfsigned > "$WORK/gen4.txt" 2>&1
grep -q "DNS:example.lan" "$WORK/gen4.txt"; check "SAN 含 example.lan" $?
grep -q "证书主体: CN=example.lan" "$WORK/gen4.txt"; check "CN=example.lan" $?

# ---------------------------------------------------------------------------
# 5. HTTPS 启动（证书缺失 → 自动生成）
# ---------------------------------------------------------------------------
echo "=== 5. HTTPS 模式启动 ==="
cp "$REPO/config/dev.sqlite" "$WORK/cfg/dev.sqlite"
rm -f "$WORK/cfg/ssl/cert.pem" "$WORK/cfg/ssl/key.pem"

PORT=$(pick_port)
(
  HTTPS=true \
  PORT=$PORT \
  DATABASE_URL="$DB" \
  CONFIG_DIR="$CFG" \
  UPLOADS_DIR="$UPLOADS" \
  PROJECT_ROOT="$CFG" \
  "$GOBIN" > "$WORK/https.log" 2>&1
) &
PID=$!

if ! wait_ready "$PORT" "HTTPS 后端" "$WORK/https.log" "监听"; then
  echo "!! HTTPS 后端未就绪"; tail -20 "$WORK/https.log"; kill_tree "$PID"; exit 1
fi

grep -q "\[HTTPS\] SSL 证书不存在，自动生成本地自签证书..." "$WORK/https.log"; check "日志：自动生成" $?
grep -q "\[HTTPS\] 自签证书生成完成" "$WORK/https.log"; check "日志：生成完成" $?

HEALTH=$(curl -sk --max-time 8 "https://127.0.0.1:$PORT/health")
echo "$HEALTH" | grep -q '"status":"ok"'; check "TLS 握手 + /health 200" $?

# 明文 HTTP 打过去不能拿到 /health（Go 会回 400 "Client sent an HTTP request
# to an HTTPS server"，curl 的退出码仍是 0，所以只能看响应体）。
if curl -s --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"status":"ok"'; then
  check "明文 HTTP 拿不到业务响应" 1
else
  check "明文 HTTP 拿不到业务响应" 0
fi

kill_tree "$PID"

# ---------------------------------------------------------------------------
echo
if [ "$fail" -eq 0 ]; then
  echo "✓ $pass 项检查全部通过"
else
  echo "✗ $fail / $((pass + fail)) 项检查失败"
  exit 1
fi
