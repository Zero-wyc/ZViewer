#!/usr/bin/env bash
# 上行 Socket 事件对照（65 个业务事件）。
#
# backend/ 还在时用运行时 harness 现采 Node 的事件表（能发现 Node 新增了什么）；
# backend/ 删掉之后自动退回契约快照（backend-go/testdata/contract/events.json）。
# 两种来源都只做一件事：Node 有的事件，Go 是否都注册了处理器。
#
# 用法：bash backend-go/scripts/events-parity.sh
set -u

REPO=/f/Code/ZViewer/ZViewer
NODE=C:/Users/Zero_/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
FIXTURE=backend-go/testdata/contract/events.json

cd "$REPO" || exit 1

echo "=== 上行事件对照 ==="
if [ -d "$REPO/backend/src" ]; then
  echo "（事件清单来源：Node 运行时 createSocketRegistry()）"
  "$NODE" backend-go/scripts/event-audit.js
else
  echo "（事件清单来源：契约快照 $FIXTURE）"
  [ -f "$REPO/$FIXTURE" ] || { echo "!! 契约快照缺失：$FIXTURE"; exit 1; }
  "$NODE" backend-go/scripts/event-audit.js --fixture "$FIXTURE"
fi
exit $?
