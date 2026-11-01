#!/usr/bin/env bash
# 从 Piik 上游同步整个服务端媒体面子树。
#
#   ./internal/piik/sync-from-piik.sh /path/to/Piik [commit]
#
# 只做四件事：拷贝、改 import、修夹具路径、去掉上游独有的探针字段。
# 本目录的 README.md / LICENSE / 本脚本不会被覆盖。
set -euo pipefail

SRC=${1:?用法: sync-from-piik.sh <Piik 仓库路径> [commit]}
COMMIT=${2:-}
HERE=$(cd "$(dirname "$0")" && pwd)

if [ ! -d "$SRC/internal/server/route" ]; then
  echo "不是 Piik 仓库: $SRC" >&2
  exit 1
fi

if [ -n "$COMMIT" ]; then
  git -C "$SRC" rev-parse --verify "$COMMIT^{commit}" >/dev/null
  git -C "$SRC" checkout --quiet "$COMMIT"
fi

PACKAGES=(
  server/route server/signal server/protocol server/sfu server/room
  server/config server/ordered media/encoded media/forwarding media/inputroute
  tlsconfig
)

for pkg in "${PACKAGES[@]}"; do
  rm -rf "${HERE:?}/$pkg"
  mkdir -p "$HERE/$pkg"
  cp -r "$SRC/internal/$pkg/." "$HERE/$pkg/"
done

mkdir -p "$HERE/../tests/fixtures"
cp "$SRC/tests/fixtures/"*.json "$HERE/../tests/fixtures/"

python3 - "$HERE" <<'PY'
import os, sys
root = sys.argv[1]

for dirpath, _, files in os.walk(root):
    for name in files:
        if not name.endswith('.go'):
            continue
        path = os.path.join(dirpath, name)
        text = open(path, encoding='utf-8').read()
        text = text.replace(
            'github.com/TNTcraftHIM/Piik/internal/thirdparty/livekit/sendsidebwe',
            'zviewer/backend/internal/thirdparty/livekit/sendsidebwe')
        text = text.replace(
            'github.com/TNTcraftHIM/Piik/internal/diagnostics',
            'zviewer/backend/internal/diagnostics')
        text = text.replace('github.com/TNTcraftHIM/Piik/internal/',
                            'zviewer/backend/internal/piik/')
        text = text.replace('../../../tests/fixtures/', '../../../../tests/fixtures/')
        open(path, 'w', encoding='utf-8').write(text)

# 上游 livekit-server 伪版本独有的字段，ZViewer 钉在上游 tag。
probe = os.path.join(root, 'media/forwarding/publication.go')
if os.path.exists(probe):
    text = open(probe, encoding='utf-8').read()
    old = ('\t\tConfig: streamallocator.DefaultStreamAllocatorConfig, BWE: publication.bandwidth,\n'
           '\t\tAdditionalProbeDemand: publication.encoderProbeDemand,\n'
           '\t\tPacer:                 publication.pacer, Logger: log,\n')
    new = ('\t\tConfig: streamallocator.DefaultStreamAllocatorConfig, BWE: publication.bandwidth,\n'
           '\t\t// AdditionalProbeDemand 是 Piik 所用 livekit-server 版本才有的字段，\n'
           '\t\t// ZViewer 固定在上游 v1.13.11，这里去掉。影响仅是探测略保守，\n'
           '\t\t// 详见 internal/piik/README.md。\n'
           '\t\tPacer: publication.pacer, Logger: log,\n')
    if old in text:
        open(probe, 'w', encoding='utf-8').write(text.replace(old, new))
    elif 'AdditionalProbeDemand' in text:
        sys.exit('publication.go 的探针字段形状变了，手动确认后再同步')

# 这个测试依赖 gopus，会把 go 指令抬到 1.27。
recovery = os.path.join(root, 'media/forwarding/recovery_test.go')
if os.path.exists(recovery):
    os.remove(recovery)
PY

# 上游按自己的模块路径排 import 分组，改写后 gofmt 会要求重排。
gofmt -w "$HERE"

echo "同步完成，执行：cd backend-go && go build ./internal/piik/... && go test ./internal/piik/..."
