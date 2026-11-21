"""HTTP API for the crawler engine (stdlib only).

The Go backend will call these endpoints later; the GUI talks to Go, and MCP
clients use stdio. Admin endpoints are protected by engine.admin_token when set.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, unquote, urlsplit

from .app import Engine
from .config import mask_secret, save_config
from .errors import EngineError, RuleError
from .rules import public_rule_view
from .submissions import public_submission


MAX_BODY = 2 * 1024 * 1024


def _merge(base: dict, patch: dict) -> dict:
    result = dict(base or {})
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def _submission_view(engine: Engine, item: dict, positions: Optional[dict] = None) -> dict:
    public = public_submission(item)
    if public.get("status") == "queued":
        table = positions if positions is not None else engine.queue_positions()
        position = table.get(str(public.get("id") or ""))
        if position:
            public["queuePosition"] = position
    return public


class ApiServer:
    def __init__(self, engine: Engine, host: Optional[str] = None, port: Optional[int] = None):
        engine_cfg = engine.config.get("engine") or {}
        self.engine = engine
        self.host = host or engine_cfg.get("host") or "127.0.0.1"
        # port=0 disables the fallback so tests and embedded callers can bind an
        # ephemeral port; None means "use the configured port".
        self.port = int(port) if port is not None else int(engine_cfg.get("port") or 3789)
        self.httpd: Optional[ThreadingHTTPServer] = None

    def build(self) -> ThreadingHTTPServer:
        engine = self.engine

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "ZViewerCrawler/0.1"

            def log_message(self, fmt, *args):
                return

            def _send(self, status: int, payload: dict) -> None:
                body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, Authorization")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def _read_raw(self) -> bytes:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    return b""
                if length > 8 * 1024 * 1024:
                    raise EngineError("body_too_large", "请求体过大")
                return self.rfile.read(length)

            def _send_raw(self, status: int, headers: dict, body: bytes) -> None:
                self.send_response(status)
                for name, value in (headers or {}).items():
                    if isinstance(value, (list, tuple)):
                        for item in value:
                            self.send_header(name, item)
                    else:
                        self.send_header(name, value)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def _read_json(self) -> dict:
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0:
                    return {}
                if length > MAX_BODY:
                    raise EngineError("body_too_large", "请求体过大")
                raw = self.rfile.read(length)
                try:
                    data = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError) as exc:
                    raise EngineError("bad_json", "请求体不是有效 JSON: %s" % exc) from exc
                if not isinstance(data, dict):
                    raise EngineError("bad_json", "请求体必须是 JSON 对象")
                return data

            def _authorized(self) -> bool:
                token = (engine.config.get("engine") or {}).get("admin_token") or ""
                if not token:
                    return self.client_address[0] in ("127.0.0.1", "::1", "::ffff:127.0.0.1")
                provided = self.headers.get("X-Admin-Token") or ""
                auth = self.headers.get("Authorization") or ""
                if auth.lower().startswith("bearer "):
                    provided = provided or auth[7:].strip()
                return provided == token

            def _require_admin(self) -> bool:
                if self._authorized():
                    return True
                self._send(401, {"success": False, "code": "unauthorized", "error": "需要管理员令牌"})
                return False

            def do_OPTIONS(self):
                self._send(204, {})

            def do_GET(self):
                self._route("GET")

            def do_POST(self):
                self._route("POST")

            def do_PUT(self):
                self._route("PUT")

            def do_DELETE(self):
                self._route("DELETE")

            def _challenge_route(self, method: str, tail: list, parsed) -> None:
                if not tail:
                    return self._send(404, {"success": False, "code": "not_found", "error": "缺少验证会话"})
                session_id = tail[0]
                action = tail[1] if len(tail) > 1 else ""
                if action in ("site", "") and len(tail) > 1:
                    return self._challenge_proxy(method, session_id, tail[2:], parsed)
                if method == "GET" and not action:
                    return self._send(200, engine.challenge_info(session_id))
                if method == "DELETE" and not action:
                    engine.challenges.delete(session_id)
                    return self._send(200, {"success": True, "deleted": True})
                if method == "POST" and action == "verify":
                    return self._send(200, engine.verify_challenge(session_id))
                return self._send(404, {"success": False, "code": "not_found", "error": "未知验证接口"})

            def _challenge_proxy(self, method: str, session_id: str, rest: list, parsed) -> None:
                session = engine.challenges.get(session_id)
                engine.challenges.absorb_browser_cookies(session, self.headers.get("Cookie") or "")
                prefix = engine.challenges.proxy_base(session)
                if not rest:
                    # 打开验证页时先回到触发验证的那个地址，而不是站点首页。
                    page_url = session.get("pageUrl") or ""
                    location = page_url[len(session["origin"]):] if page_url.startswith(session["origin"]) else "/"
                    return self._send_raw(302, {"Location": prefix + location, "Cache-Control": "no-store"}, b"")
                path = "/" + "/".join(rest)
                target = session["origin"] + path
                if parsed.query:
                    target += "?" + parsed.query
                body = self._read_raw() if method in ("POST", "PUT", "PATCH") else b""
                req_headers = {
                    "Accept": self.headers.get("Accept") or "*/*",
                    "Accept-Language": self.headers.get("Accept-Language") or "",
                    "Content-Type": self.headers.get("Content-Type") or "",
                    "X-Requested-With": self.headers.get("X-Requested-With") or "",
                    "User-Agent": self.headers.get("User-Agent") or "",
                }
                referer = self.headers.get("Referer") or ""
                prefix = engine.challenges.proxy_base(session)
                if referer.startswith(prefix):
                    req_headers["Referer"] = session["origin"] + referer[len(prefix):]
                status, response_headers, raw = engine.challenges.fetch(
                    session, target, method=method, headers=req_headers, body=body)
                content_type = response_headers.get("content-type") or "application/octet-stream"
                charset_match = __import__("re").search(r"charset=([\w.-]+)", content_type, 2)
                charset = charset_match.group(1) if charset_match else "utf-8"
                out_headers = {"Content-Type": content_type, "X-Frame-Options": "ALLOWALL"}
                if content_type.lower().startswith("text/html"):
                    raw = engine.challenges.rewrite_html(session, raw.decode(charset, "replace")).encode("utf-8")
                    out_headers["Content-Type"] = "text/html; charset=utf-8"
                elif content_type.lower().startswith("text/css"):
                    raw = engine.challenges.rewrite_css(session, raw.decode(charset, "replace"), target).encode("utf-8")
                cookies = engine.challenges.absorb_response_cookies(
                    session, response_headers.get("set-cookie") or [])
                if cookies:
                    out_headers["Set-Cookie"] = cookies
                location = response_headers.get("location") or ""
                if location:
                    if location.startswith(session["origin"]):
                        out_headers["Location"] = prefix + location[len(session["origin"]):]
                    else:
                        out_headers["Location"] = location
                return self._send_raw(status, out_headers, raw)

            def _route(self, method: str) -> None:
                parsed = urlsplit(self.path)
                parts = [unquote(part) for part in parsed.path.strip("/").split("/") if part]
                query = parse_qs(parsed.query)
                try:
                    if method == "GET" and parts == ["health"]:
                        return self._send(200, engine.status())
                    if parts[:3] == ["api", "crawler", "challenge"]:
                        return self._challenge_route(method, parts[3:], parsed)
                    if parts[:2] != ["api", "crawler"]:
                        return self._send(404, {"success": False, "code": "not_found", "error": "未知接口"})
                    tail = parts[2:]
                    if method == "GET" and tail == ["status"]:
                        return self._send(200, engine.status())
                    if method == "GET" and tail == ["challenges"]:
                        include_completed = (query.get("all") or [""])[0] in ("1", "true", "yes")
                        return self._send(200, engine.list_challenges(include_completed=include_completed))
                    if method == "GET" and tail == ["sites"]:
                        room_id = (query.get("roomId") or [""])[0]
                        role = (query.get("role") or ["guest"])[0]
                        sites = engine.search.list_sites(room_id=room_id or None, role=role)
                        return self._send(200, {"success": True, "sites": sites, "count": len(sites)})
                    if len(tail) == 2 and tail[0] == "sites" and method == "GET":
                        if not self._require_admin():
                            return
                        rule = engine.store.get(tail[1])
                        return self._send(200, {"success": True, "rule": public_rule_view(rule, include_parse=True)})
                    if method == "POST" and tail == ["search"]:
                        body = self._read_json()
                        result = engine.search.search(
                            body.get("site") or "",
                            body.get("keyword") or "",
                            room_id=body.get("roomId") or body.get("room_id"),
                            role=body.get("role") or "guest",
                            limit=body.get("limit"),
                        )
                        return self._send(200, result)
                    if tail == ["search", "logs"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            limit = (query.get("limit") or ["50"])[0]
                            site = (query.get("site") or [""])[0]
                            failures = (query.get("failures") or ["0"])[0] in ("1", "true", "yes")
                            source = (query.get("source") or [""])[0]
                            logs = engine.search_log.list(limit=limit, site=site, failures_only=failures, source=source)
                            return self._send(200, {"success": True, "logs": logs, "count": len(logs),
                                                    "total": engine.search_log.count()})
                        if method == "DELETE":
                            removed = engine.search_log.clear()
                            return self._send(200, {"success": True, "removed": removed})
                        return self._send(405, {"success": False, "code": "method_not_allowed", "error": "只支持 GET/DELETE"})
                    if tail == ["play", "resolve"]:
                        if method != "POST":
                            return self._send(405, {"success": False, "code": "method_not_allowed", "error": "只支持 POST"})
                        body = self._read_json()
                        try:
                            result = engine.resolve_play(
                                str(body.get("url") or body.get("pageUrl") or ""),
                                room_id=str(body.get("roomId") or body.get("room_id") or ""),
                                role=str(body.get("role") or "guest"),
                            )
                        except RuleError as exc:
                            return self._send(400, {"success": False, "code": "bad_request", "error": str(exc)})
                        return self._send(200, result)
                    if tail == ["submissions"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            status = (query.get("status") or [""])[0] or None
                            limit = (query.get("limit") or ["200"])[0]
                            positions = engine.queue_positions()
                            items = [_submission_view(engine, item, positions)
                                     for item in engine.submissions.list(status=status, limit=limit)]
                            return self._send(200, {"success": True, "submissions": items, "count": len(items)})
                        if method == "POST":
                            body = self._read_json()
                            return self._send(200, engine.submit_site(body))
                    if len(tail) == 3 and tail[0] == "submissions" and tail[2] == "run":
                        if not self._require_admin():
                            return
                        if method != "POST":
                            return self._send(405, {"success": False, "code": "method_not_allowed", "error": "只支持 POST"})
                        body = self._read_json()
                        try:
                            started = engine.start_submission_run(
                                tail[1],
                                session_id=str(body.get("sessionId") or ""),
                                reasoning_effort=body.get("reasoningEffort") if "reasoningEffort" in body else body.get("reasoning_effort"),
                                model=body.get("model"),
                            )
                        except RuleError as exc:
                            return self._send(400, {"success": False, "code": "bad_request", "error": str(exc)})
                        return self._send(200, started)
                    if len(tail) == 3 and tail[0] == "submissions" and tail[2] == "generate":
                        if not self._require_admin():
                            return
                        if method != "POST":
                            return self._send(405, {"success": False, "code": "method_not_allowed", "error": "只支持 POST"})
                        body = self._read_json()
                        engine.queue_generation(
                            tail[1],
                            reasoning_effort=body.get("reasoningEffort") if "reasoningEffort" in body else body.get("reasoning_effort"),
                        )
                        item = engine.submissions.get(tail[1]) or {}
                        return self._send(200, {"success": True, "submission": _submission_view(engine, item)})
                    if len(tail) == 2 and tail[0] == "submissions":
                        if not self._require_admin():
                            return
                        if method == "GET":
                            item = engine.submissions.get(tail[1])
                            if item is None:
                                return self._send(404, {"success": False, "code": "submission_not_found", "error": "提交记录不存在"})
                            return self._send(200, {"success": True, "submission": _submission_view(engine, item)})
                        if method == "DELETE":
                            engine.cancel_queued_generation(tail[1])
                            deleted = engine.submissions.delete(tail[1])
                            return self._send(200 if deleted else 404, {
                                "success": deleted, "deleted": deleted, "submissionId": tail[1]})
                    if method == "GET" and tail == ["rules", "export"]:
                        if not self._require_admin():
                            return
                        ids = (query.get("ids") or [""])[0]
                        rule_ids = [item.strip() for item in ids.split(",") if item.strip()]
                        bundle = engine.store.export_bundle(rule_ids)
                        return self._send(200, {"success": True, "bundle": bundle,
                                                "count": bundle["count"]})
                    if method == "POST" and tail == ["rules", "import"]:
                        if not self._require_admin():
                            return
                        body = self._read_json()
                        payload = body.get("bundle") if "bundle" in body else body.get("rules")
                        if payload is None:
                            payload = body
                        report = engine.store.import_bundle(
                            payload,
                            mode=body.get("mode") or "merge",
                            dry_run=bool(body.get("dryRun") or body.get("dry_run")),
                        )
                        return self._send(200, report)
                    if method == "GET" and tail == ["rules"]:
                        if not self._require_admin():
                            return
                        rules = [public_rule_view(rule, include_parse=True) for rule in engine.store.list()]
                        return self._send(200, {"success": True, "rules": rules, "count": len(rules)})
                    if method == "POST" and tail == ["rules"]:
                        if not self._require_admin():
                            return
                        body = self._read_json()
                        raw = body.get("rule") if isinstance(body.get("rule"), dict) else body
                        saved = engine.store.save(raw)
                        return self._send(200, {"success": True, "rule": public_rule_view(saved, include_parse=True)})
                    if len(tail) == 2 and tail[0] == "rules":
                        rule_id = tail[1]
                        if not self._require_admin():
                            return
                        if method == "GET":
                            return self._send(200, {"success": True, "rule": public_rule_view(engine.store.get(rule_id), include_parse=True)})
                        if method == "PUT":
                            body = self._read_json()
                            patch = body.get("patch") if isinstance(body.get("patch"), dict) else body
                            saved = engine.store.update(rule_id, patch)
                            return self._send(200, {"success": True, "rule": public_rule_view(saved, include_parse=True)})
                        if method == "DELETE":
                            deleted = engine.store.delete(rule_id)
                            status = 200 if deleted else 404
                            return self._send(status, {"success": deleted, "deleted": deleted, "ruleId": rule_id})
                    if method == "POST" and tail == ["generate"]:
                        if not self._require_admin():
                            return
                        body = self._read_json()
                        result = engine.agent.generate(
                            body.get("url") or "",
                            keyword=body.get("keyword") or "",
                            notes=body.get("notes") or "",
                            reasoning_effort=body.get("reasoningEffort") if "reasoningEffort" in body else body.get("reasoning_effort"),
                        )
                        return self._send(200, result)
                    if tail == ["accounts"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            items = engine.accounts.list(mask=True)
                            return self._send(200, {"success": True, "accounts": items, "count": len(items)})
                        if method == "POST":
                            body = self._read_json()
                            raw = body.get("account") if isinstance(body.get("account"), dict) else body
                            saved = engine.accounts.save(raw)
                            return self._send(200, {"success": True, "account": engine.accounts.public_view(saved, mask=True)})
                    if len(tail) == 2 and tail[0] == "accounts":
                        if not self._require_admin():
                            return
                        if method == "DELETE":
                            deleted = engine.accounts.delete(tail[1])
                            return self._send(200 if deleted else 404, {
                                "success": deleted, "deleted": deleted, "accountId": tail[1]})
                        if method == "GET":
                            account = engine.accounts.get(tail[1])
                            if account is None:
                                return self._send(404, {"success": False, "code": "account_not_found", "error": "账号不存在"})
                            return self._send(200, {"success": True, "account": engine.accounts.public_view(account, mask=True)})
                    if tail and tail[0] == "browser":
                        if not self._require_admin():
                            return
                        if tail == ["browser", "status"] and method == "GET":
                            return self._send(200, {"success": True, "browser": engine.browser_status()})
                        if tail == ["browser", "open"] and method == "POST":
                            body = self._read_json()
                            return self._send(200, {"success": True,
                                                    "page": engine.browser.open(body.get("url") or "")})
                        if tail == ["browser", "open-login"] and method == "POST":
                            body = self._read_json()
                            return self._send(200, engine.browser.open_login(body.get("url") or ""))
                        if tail == ["browser", "show"] and method == "POST":
                            body = self._read_json()
                            result = engine.browser.show(
                                body.get("url") or "", wait_sec=body.get("waitSec") or 0)
                            return self._send(200, {"success": True, **result})
                        if tail == ["browser", "hide"] and method == "POST":
                            return self._send(200, {"success": True, **engine.browser.hide()})
                        if tail == ["browser", "save-login"] and method == "POST":
                            body = self._read_json()
                            return self._send(200, engine.browser.save_login(
                                body.get("site") or "", name=body.get("name") or "",
                                accounts=engine.accounts))
                        if tail == ["browser", "close"] and method == "POST":
                            engine.browser.close()
                            return self._send(200, {"success": True, "browser": engine.browser_status()})
                        if tail == ["browser", "clear-profile"] and method == "POST":
                            engine.browser.clear_profile()
                            return self._send(200, {"success": True, "browser": engine.browser_status()})
                        return self._send(404, {"success": False, "code": "not_found", "error": "未知浏览器接口"})
                    if method == "POST" and tail == ["agent", "runs"]:
                        if not self._require_admin():
                            return
                        body = self._read_json()
                        result = engine.start_agent_run(
                            body.get("message") or "",
                            session_id=body.get("sessionId") or body.get("session_id") or "",
                            context=body.get("context") if isinstance(body.get("context"), dict) else {},
                            reasoning_effort=body.get("reasoningEffort") if "reasoningEffort" in body else body.get("reasoning_effort"),
                            model=body.get("model"),
                            images=body.get("images"),
                        )
                        return self._send(200 if result.get("success") else 400, result)
                    if len(tail) == 3 and tail[:2] == ["agent", "runs"] and method == "GET":
                        if not self._require_admin():
                            return
                        try:
                            cursor = int((query.get("cursor") or ["0"])[0] or 0)
                        except (TypeError, ValueError):
                            cursor = 0
                        result = engine.get_agent_run(tail[2], cursor)
                        return self._send(200 if result.get("success") else 404, result)
                    if len(tail) == 4 and tail[:2] == ["agent", "runs"] and tail[3] == "cancel" and method == "POST":
                        if not self._require_admin():
                            return
                        result = engine.cancel_agent_run(tail[2])
                        return self._send(200 if result.get("success") else 404, result)
                    if tail == ["agent", "sessions"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            sessions = engine.agent.list_sessions()
                            return self._send(200, {"success": True, "sessions": sessions, "count": len(sessions)})
                        if method == "POST":
                            body = self._read_json()
                            session = engine.agent.new_session(
                                title=body.get("title") or "",
                                reasoning_effort=body.get("reasoningEffort") or body.get("reasoning_effort"),
                                model=body.get("model"),
                            )
                            return self._send(200, {"success": True, "session": session})
                    if len(tail) == 3 and tail[:2] == ["agent", "sessions"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            return self._send(200, {"success": True, "session": engine.agent.get_session(tail[2])})
                        if method == "PUT":
                            body = self._read_json()
                            session = engine.agent.update_session(
                                tail[2],
                                reasoning_effort=body.get("reasoningEffort") if "reasoningEffort" in body else body.get("reasoning_effort"),
                                title=body.get("title"),
                                model=body.get("model"),
                            )
                            return self._send(200, {"success": True, "session": session})
                        if method == "DELETE":
                            deleted = engine.agent.delete_session(tail[2])
                            return self._send(200 if deleted else 404, {
                                "success": deleted, "deleted": deleted, "sessionId": tail[2]})
                    if method == "POST" and tail == ["agent", "chat"]:
                        if not self._require_admin():
                            return
                        body = self._read_json()
                        result = engine.agent.chat(
                            body.get("message") or "",
                            session_id=body.get("sessionId") or "",
                            context=body.get("context") if isinstance(body.get("context"), dict) else {},
                            reasoning_effort=body.get("reasoningEffort") if "reasoningEffort" in body else body.get("reasoning_effort"),
                            model=body.get("model"),
                            images=body.get("images"),
                        )
                        return self._send(200, result)
                    if tail == ["models"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            api_key = (query.get("key") or [""])[0]
                            base_url = (query.get("base") or [""])[0]
                        elif method == "POST":
                            body = self._read_json()
                            api_key = body.get("apiKey") or body.get("api_key") or ""
                            base_url = body.get("baseUrl") or body.get("base_url") or ""
                        else:
                            return self._send(405, {"success": False, "code": "method_not_allowed", "error": "只支持 GET/POST"})
                        result = engine.list_models(api_key=api_key, base_url=base_url)
                        return self._send(200, result)
                    if tail == ["config"]:
                        if not self._require_admin():
                            return
                        if method == "GET":
                            cfg = json.loads(json.dumps(engine.config))
                            api_key = (cfg.get("llm") or {}).get("api_key") or ""
                            cfg["llm"]["api_key"] = mask_secret(api_key)
                            cfg["llmConfigured"] = bool(api_key)
                            return self._send(200, {"success": True, "config": cfg})
                        if method == "PUT":
                            body = self._read_json()
                            patch = body.get("config") if isinstance(body.get("config"), dict) else body
                            if isinstance(patch.get("llm"), dict) and "api_key" in patch["llm"]:
                                value = str(patch["llm"]["api_key"] or "")
                                current = (engine.config.get("llm") or {}).get("api_key") or ""
                                if value == mask_secret(current):
                                    patch["llm"].pop("api_key", None)
                            merged = _merge(engine.config, patch)
                            save_config(merged, engine.paths)
                            engine.reload()
                            cfg = json.loads(json.dumps(engine.config))
                            cfg["llm"]["api_key"] = mask_secret((cfg.get("llm") or {}).get("api_key") or "")
                            return self._send(200, {"success": True, "config": cfg})
                    return self._send(404, {"success": False, "code": "not_found", "error": "未知接口: %s %s" % (method, parsed.path)})
                except EngineError as exc:
                    status = 400
                    if exc.code in ("rule_not_found", "site_not_found", "submission_not_found"):
                        status = 404
                    elif exc.code == "site_forbidden":
                        status = 403
                    return self._send(status, exc.to_dict())
                except Exception as exc:  # noqa: BLE001
                    return self._send(500, {"success": False, "code": "internal_error", "error": str(exc)})

        httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        httpd.daemon_threads = True
        self.httpd = httpd
        return httpd

    def serve_forever(self) -> None:
        httpd = self.build()
        print("crawler engine listening on http://%s:%d" % (self.host, self.port), flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            httpd.server_close()

    def stop(self) -> None:
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        try:
            self.engine.shutdown()
        except Exception:  # noqa: BLE001 - 测试/退出时忽略
            pass