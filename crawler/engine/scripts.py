"""Node.js sandbox used by script-based rules.

Rules are authored by the trusted root administrator, so scripts are allowed to
use fetch and arbitrary JS, but they run in a separate vm context with a hard
process-level timeout.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from .errors import RuleError


class JsRuntime:
    def __init__(self, node_bin: Optional[str] = None, timeout_sec: float = 20, tmp_dir=None):
        self.node_bin = node_bin or os.environ.get("CRAWLER_NODE_BIN") or "node"
        self.timeout_sec = float(timeout_sec or 20)
        self.tmp_dir = Path(tmp_dir) if tmp_dir else None
        self.runner = Path(__file__).with_name("js_runner.js")

    def resolve_node(self) -> str:
        candidate = shutil.which(self.node_bin) if not os.path.isabs(self.node_bin) else self.node_bin
        if not candidate or not os.path.exists(candidate):
            raise RuleError(
                "找不到 Node.js，脚本规则需要本机安装 Node.js（或设置 engine.node_bin）"
            )
        return candidate

    def available(self) -> bool:
        try:
            self.resolve_node()
            return True
        except RuleError:
            return False

    def run(self, source: str, payload: dict, timeout_sec: Optional[float] = None) -> dict:
        if not (source or "").strip():
            raise RuleError("脚本内容为空")
        node = self.resolve_node()
        if not self.runner.exists():
            raise RuleError("缺少 JS runner: %s" % self.runner)
        directory = self.tmp_dir
        if directory:
            directory = Path(directory)
        else:
            directory = Path(tempfile.gettempdir())
        directory.mkdir(parents=True, exist_ok=True)
        handle, source_path = tempfile.mkstemp(prefix="rule-", suffix=".js", dir=str(directory))
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(source)
            timeout = float(timeout_sec or self.timeout_sec)
            try:
                completed = subprocess.run(
                    [node, str(self.runner), source_path],
                    input=json.dumps(payload, ensure_ascii=False),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired as exc:
                raise RuleError("脚本执行超时（%.0f 秒）" % timeout) from exc
            stdout = (completed.stdout or "").strip()
            if not stdout:
                snippet = (completed.stderr or "")[:800]
                raise RuleError("脚本没有输出: %s" % snippet)
            try:
                result = json.loads(stdout)
            except ValueError as exc:
                raise RuleError("脚本输出不是 JSON: %s" % stdout[:500]) from exc
            if not isinstance(result, dict):
                raise RuleError("脚本输出必须是 JSON 对象")
            if result.get("logs"):
                result["stderr"] = (completed.stderr or "")[:800]
            return result
        finally:
            try:
                os.unlink(source_path)
            except OSError:
                pass
