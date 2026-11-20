"""End-to-end tests for the crawler engine (stdlib only, local fixture server)."""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from engine.accounts import AccountStore
from engine.dom import parse_html, select_all, select_one
from engine.errors import EngineError, RuleError
from engine.rules import validate_rule
from engine.scripts import JsRuntime
from engine.search import SearchService
from engine.store import RuleStore, rule_visible_to
from engine.tools import RULE_GUIDE, ToolRegistry, build_registry


def _items_html(count: int = 3) -> str:
    rows = []
    for index in range(count):
        rows.append(
            '<div class="result-item"><h3 class="title">电影 %d</h3>'
            '<a class="link" href="/detail/%d">详情</a>'
            '<span class="desc">简介 %d</span></div>' % (index, index, index)
        )
    return "<html><body><div id='list'>%s</div></body></html>" % "".join(rows)


class FixtureHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send(self, status, body, content_type="text/html; charset=utf-8"):
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlsplit(self.path)
        query = parse_qs(parsed.query)
        keyword = (query.get("q") or [""])[0]
        if parsed.path == "/search":
            return self._send(200, _items_html(3))
        if parsed.path == "/json":
            payload = {"data": {"list": [
                {"title": "JSON 结果 %d" % i, "url": "/detail/%d" % i, "cover": "/img/%d.jpg" % i}
                for i in range(2)
            ]}}
            return self._send(200, json.dumps(payload), "application/json")
        if parsed.path == "/need-cookie":
            cookie = self.headers.get("Cookie") or ""
            if "sid=abc" in cookie:
                return self._send(200, _items_html(2))
            return self._send(200, "<html><body>请登录</body></html>")
        if parsed.path == "/sign":
            expected = "sig-" + keyword
            if self.headers.get("X-Sign") != expected:
                return self._send(403, "bad sign")
            return self._send(200, _items_html(2))
        return self._send(404, "not found")


class EngineTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.rules_dir = base / "rules"
        self.rules_dir.mkdir()
        self.store = RuleStore(self.rules_dir)
        from engine.fetch import Fetcher
        self.fetcher = Fetcher(timeout=10, max_bytes=1024 * 1024)
        self.accounts = AccountStore(base / "accounts.json")
        self.js = JsRuntime(timeout_sec=20)
        self.search = SearchService(self.store, self.fetcher, js=self.js, accounts=self.accounts)

    def tearDown(self):
        self.tmp.cleanup()

    def base(self, path: str) -> str:
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def http_rule(self, url: str = "/search?q={keyword}") -> dict:
        return {
            "name": "测试站",
            "site": "127.0.0.1",
            "search": {"mode": "http", "request": {"url": self.base(url)}},
            "parse": {
                "type": "html",
                "container": ".result-item",
                "fields": {
                    "title": {"selector": ".title"},
                    "url": {"selector": "a", "attr": "href"},
                    "description": {"selector": ".desc"},
                },
            },
        }


class DomTests(unittest.TestCase):
    def test_basic_selectors(self):
        root = parse_html("<div class='a'><p id='x'>hi</p><p>two</p></div>")
        self.assertEqual(len(select_all(root, "p")), 2)
        self.assertEqual(select_one(root, "#x").text(), "hi")
        self.assertEqual(select_one(root, ".a > p:nth-child(1)").text(), "hi")

    def test_contains_and_not(self):
        root = parse_html("<ul><li class='k'>apple</li><li class='k'>pear</li></ul>")
        self.assertEqual(len(select_all(root, "li:contains(apple)")), 1)
        self.assertEqual(len(select_all(root, "li:not(:first-child)")), 1)


class RuleValidationTests(EngineTestBase):
    def test_http_rule(self):
        rule = validate_rule(self.http_rule())
        self.assertEqual(rule["parse"]["type"], "html")
        self.assertEqual(rule["search"]["mode"], "http")

    def test_script_rule(self):
        rule = validate_rule({
            "name": "脚本站",
            "site": "example.com",
            "search": {"mode": "script", "script": {"source": "return {items: []}"}},
            "parse": {"type": "script", "script": {"source": "return {items: []}"}},
        })
        self.assertEqual(rule["search"]["script"]["runtime"], "node")

    def test_script_rule_requires_source(self):
        with self.assertRaises(RuleError):
            validate_rule({
                "name": "脚本站",
                "site": "example.com",
                "search": {"mode": "script"},
                "parse": {"type": "script"},
            })


class JsRuntimeTests(EngineTestBase):
    def test_run_simple_script(self):
        result = self.js.run("return {ok: input.keyword.length}", {"keyword": "abc"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["ok"], 3)

    def test_script_can_fetch(self):
        source = (
            "const res = await fetch('%s');\n"
            "const text = await res.text();\n"
            "return {status: res.status, length: text.length};" % self.base("/search?q=x")
        )
        result = self.js.run(source, {})
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["result"]["status"], 200)


class SearchTests(EngineTestBase):
    def test_html_rule(self):
        self.store.save(self.http_rule())
        response = self.search.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 3)
        self.assertEqual(response["items"][0]["title"], "电影 0")
        self.assertTrue(response["items"][0]["url"].startswith("http://127.0.0.1"))

    def test_json_rule(self):
        rule = self.http_rule("/json?q={keyword}")
        rule["parse"] = {
            "type": "json",
            "list_path": "data.list",
            "fields": {"title": {"path": "title"}, "url": {"path": "url"}, "cover": {"path": "cover"}},
        }
        self.store.save(rule)
        response = self.search.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 2)
        self.assertTrue(response["items"][0]["cover"].startswith("http://127.0.0.1"))

    def test_account_cookie_injected(self):
        rule = self.http_rule("/need-cookie?q={keyword}")
        rule["search"]["account_id"] = "bili"
        self.store.save(rule)
        self.accounts.save({"id": "bili", "name": "B站", "site": "127.0.0.1", "cookies": "sid=abc"})
        response = self.search.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 2)

    def test_script_search_builds_request(self):
        source = (
            "const url = 'http://127.0.0.1:%d/sign?q=' + encodeURIComponent(input.keyword);\n"
            "return {request: {url: url, headers: {'X-Sign': 'sig-' + input.keyword}}};" % self.port
        )
        rule = self.http_rule("/search?q={keyword}")
        rule["search"] = {"mode": "script", "script": {"source": source}}
        self.store.save(rule)
        response = self.search.search("测试站", "movie", role="root")
        self.assertEqual(response["count"], 2)

    def test_script_search_returns_items(self):
        source = (
            "const res = await fetch('http://127.0.0.1:%d/json');\n"
            "const data = await res.json();\n"
            "return {items: data.data.list};" % self.port
        )
        rule = self.http_rule("/search?q={keyword}")
        rule["search"] = {"mode": "script", "script": {"source": source}}
        self.store.save(rule)
        response = self.search.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 2)
        self.assertEqual(response["items"][0]["title"], "JSON 结果 0")

    def test_script_parse(self):
        rule = self.http_rule()
        rule["parse"] = {
            "type": "script",
            "script": {"source": "return {items: [{title: input.keyword + '-x', url: input.url}]};"},
        }
        self.store.save(rule)
        response = self.search.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 1)
        self.assertEqual(response["items"][0]["title"], "电影-x")


class RepairTests(EngineTestBase):
    def _service(self, repairer, cooldown=600):
        service = SearchService(
            self.store,
            self.fetcher,
            js=self.js,
            accounts=self.accounts,
            repair_config={"enabled": True, "cooldown_sec": cooldown},
        )
        service.set_repairer(repairer)
        return service

    def _broken_rule(self) -> dict:
        rule = self.http_rule("/search?q={keyword}")
        rule["parse"]["container"] = ".not-there"
        return self.store.save(rule)

    def test_repairs_rule_and_retries(self):
        rule = self._broken_rule()
        store = self.store

        class FakeRepairer:
            calls = 0

            def repair(self, rule, keyword="", error=""):
                FakeRepairer.calls += 1
                current = store.get(rule["id"])
                current["parse"]["container"] = ".result-item"
                store.save(current, rule_id=rule["id"])
                return {"success": True, "ruleId": rule["id"], "steps": 2, "tookMs": 5}

        service = self._service(FakeRepairer())
        response = service.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 3)
        self.assertTrue(response["repaired"])
        self.assertTrue(response["repair"]["success"])
        self.assertEqual(response["repair"]["steps"], 2)
        self.assertEqual(FakeRepairer.calls, 1)
        self.assertEqual(response["warnings"][0], "原规则解析失败，已自动让大模型修复")

    def test_cooldown_blocks_repeated_repair(self):
        self._broken_rule()

        class FailingRepairer:
            calls = 0

            def repair(self, rule, keyword="", error=""):
                FailingRepairer.calls += 1
                return {"success": False, "error": "cannot fix", "steps": 1, "tookMs": 1}

        service = self._service(FailingRepairer())
        first = service.search("测试站", "电影", role="root")
        second = service.search("测试站", "电影", role="root")
        self.assertEqual(FailingRepairer.calls, 1)
        self.assertFalse(first["repaired"])
        self.assertNotIn("repair", second)
        self.assertEqual(second["count"], 0)
        self.assertTrue(any("自动修复未成功" in warn for warn in first["warnings"]))

    def test_repair_failure_keeps_original_error(self):
        self.store.save(self.http_rule("/missing?q={keyword}"))

        class FailingRepairer:
            def repair(self, rule, keyword="", error=""):
                return {"success": False, "error": "cannot fix", "steps": 1, "tookMs": 1}

        service = self._service(FailingRepairer())
        with self.assertRaises(EngineError) as ctx:
            service.search("测试站", "电影", role="root")
        self.assertIn("404", ctx.exception.message)

    def test_repair_can_be_disabled(self):
        self._broken_rule()

        class FakeRepairer:
            calls = 0

            def repair(self, rule, keyword="", error=""):
                FakeRepairer.calls += 1
                return {"success": True, "ruleId": rule["id"], "steps": 1, "tookMs": 1}

        service = SearchService(
            self.store,
            self.fetcher,
            js=self.js,
            accounts=self.accounts,
            repair_config={"enabled": False},
        )
        service.set_repairer(FakeRepairer())
        response = service.search("测试站", "电影", role="root")
        self.assertEqual(response["count"], 0)
        self.assertEqual(FakeRepairer.calls, 0)
        self.assertNotIn("repair", response)


class StoreAndAccountTests(EngineTestBase):
    def test_visibility(self):
        self.store.save({
            "id": "private-rule", "name": "私有", "site": "p.example.com",
            "visibility": "root", "search": {"mode": "http", "request": {"url": "https://p.example.com/?q={keyword}"}},
            "parse": {"type": "html", "container": "li", "fields": {"title": {"selector": "a"}, "url": {"selector": "a", "attr": "href"}}},
        })
        rule = self.store.get("private-rule")
        self.assertFalse(rule_visible_to(rule, room_id="r1", role="guest"))
        self.assertTrue(rule_visible_to(rule, room_id="r1", role="root"))

    def test_export_import_roundtrip(self):
        self.store.save({
            "id": "demo-rule", "name": "示例站", "site": "demo.example.com",
            "search": {"mode": "http", "request": {"url": "https://demo.example.com/?q={keyword}"}},
            "parse": {"type": "html", "container": "li", "fields": {"title": {"selector": "a"}, "url": {"selector": "a", "attr": "href"}}},
        })
        bundle = self.store.export_bundle()
        self.assertEqual(bundle["count"], 1)
        self.assertEqual(bundle["rules"][0]["name"], "示例站")
        self.store.delete("demo-rule")
        report = self.store.import_bundle(bundle)
        self.assertTrue(report["success"])
        self.assertEqual(report["imported"], 1)
        self.assertEqual(len(self.store.list()), 1)
        report = self.store.import_bundle(bundle)
        self.assertEqual(report["updated"], 1)
        self.assertEqual(len(self.store.list()), 1)

    def test_import_dry_run_and_replace(self):
        self.store.save({
            "id": "first", "name": "一", "site": "one.example.com",
            "search": {"mode": "http", "request": {"url": "https://one.example.com/?q={keyword}"}},
            "parse": {"type": "json", "list_path": "data", "fields": {"title": {"path": "title"}, "url": {"path": "url"}}},
        })
        payload = {"rules": [{
            "id": "second", "name": "二", "site": "two.example.com",
            "search": {"mode": "http", "request": {"url": "https://two.example.com/?q={keyword}"}},
            "parse": {"type": "json", "list_path": "data", "fields": {"title": {"path": "title"}, "url": {"path": "url"}}},
        }, {"name": "坏规则"}]}
        dry = self.store.import_bundle(payload, mode="replace", dry_run=True)
        self.assertEqual(len(self.store.list()), 1)
        report = self.store.import_bundle(payload, mode="replace")
        self.assertEqual(report["imported"], 1)
        self.assertEqual(report["failed"], 1)
        self.assertFalse(report["success"])
        self.assertEqual(len(self.store.list()), 1)

    def test_account_masking(self):
        saved = self.accounts.save({"id": "demo", "username": "u", "password": "secret-pass", "cookies": "sid=abcdefghi"})
        view = self.accounts.public_view(saved)
        self.assertNotIn("secret-pass", json.dumps(view))
        self.assertTrue(view["hasPassword"])
        self.assertEqual(self.accounts.resolve("demo")["cookies"], "sid=abcdefghi")

    def test_account_tools(self):
        registry = build_registry(self.store, self.search, self.fetcher, accounts=self.accounts)
        result = registry.call("save_account", {"account": {"id": "demo", "cookies": "sid=abc"}})
        self.assertTrue(result["success"])
        listed = registry.call("list_accounts", {})
        self.assertEqual(listed["count"], 1)
        self.assertNotIn("sid=abc", json.dumps(listed))

    def test_registry_names(self):
        registry = build_registry(self.store, self.search, self.fetcher, accounts=self.accounts)
        for name in ("fetch_page", "test_rule", "save_rule", "list_rules", "get_rule",
                     "update_rule", "delete_rule", "search_site", "list_sites",
                     "save_account", "list_accounts", "delete_account", "bind_account"):
            self.assertIn(name, registry.names())


if __name__ == "__main__":
    unittest.main()
