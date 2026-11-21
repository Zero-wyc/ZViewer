"""MCP server over stdio (newline-delimited JSON-RPC 2.0).

Run: python -m engine.mcp_server [--root DIR]
Configure in an MCP client as command "python", args ["-m", "engine.mcp_server"].
"""
from __future__ import annotations

import argparse
import json
import sys
from typing import Optional

from .app import Engine
from .errors import EngineError
from .tools import ToolRegistry


SUPPORTED_PROTOCOLS = ("2024-11-05", "2025-03-26", "2025-06-18")
LATEST_PROTOCOL = "2025-06-18"


class McpServer:
    def __init__(self, registry: ToolRegistry, version: str = "0.1.0"):
        self.registry = registry
        self.version = version
        self.initialized = False

    def log(self, message: str) -> None:
        sys.stderr.write("[crawler-mcp] %s\n" % message)
        sys.stderr.flush()

    def handle(self, message: dict) -> Optional[dict]:
        if not isinstance(message, dict):
            return self._error(None, -32600, "Invalid Request")
        method = message.get("method") or ""
        request_id = message.get("id")
        params = message.get("params") or {}
        is_notification = "id" not in message
        if method == "initialize":
            requested = (params.get("protocolVersion") or "").strip()
            protocol = requested if requested in SUPPORTED_PROTOCOLS else LATEST_PROTOCOL
            result = {
                "protocolVersion": protocol,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "zviewer-crawler", "version": self.version},
                "instructions": "ZViewer 爬虫引擎：生成、测试、管理站点搜索规则。",
            }
            self.initialized = True
            return self._result(request_id, result)
        if method == "notifications/initialized":
            self.initialized = True
            return None
        if method == "ping":
            return self._result(request_id, {})
        if method == "tools/list":
            return self._result(request_id, {"tools": self.registry.mcp_tools()})
        if method == "tools/call":
            name = params.get("name") or ""
            arguments = params.get("arguments") or {}
            if not isinstance(arguments, dict):
                return self._result(request_id, {
                    "content": [{"type": "text", "text": "arguments 必须是对象"}],
                    "isError": True,
                })
            result = self.registry.call(name, arguments)
            is_error = result.get("success") is False or result.get("ok") is False
            return self._result(request_id, {
                "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": bool(is_error),
            })
        if method in ("resources/list", "prompts/list"):
            key = method.split("/")[0]
            return self._result(request_id, {key: []})
        if is_notification:
            return None
        return self._error(request_id, -32601, "Method not found: %s" % method)

    @staticmethod
    def _result(request_id, result: dict) -> dict:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    @staticmethod
    def _error(request_id, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}

    def serve(self, stdin=None, stdout=None) -> None:
        stdin = stdin or sys.stdin
        stdout = stdout or sys.stdout
        self.log("server started")
        while True:
            line = stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError as exc:
                response = self._error(None, -32700, "Parse error: %s" % exc)
            else:
                try:
                    response = self.handle(message)
                except EngineError as exc:
                    response = self._error(message.get("id") if isinstance(message, dict) else None, -32000, exc.message)
                except Exception as exc:  # noqa: BLE001
                    self.log("internal error: %s" % exc)
                    response = self._error(message.get("id") if isinstance(message, dict) else None, -32603, "Internal error: %s" % exc)
            if response is not None:
                stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
                stdout.flush()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="ZViewer crawler MCP server")
    parser.add_argument("--root", default=None, help="crawler 目录，默认自动探测")
    args = parser.parse_args(argv)
    engine = Engine(args.root)
    server = McpServer(engine.admin_registry, version="0.1.0")
    server.serve()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
