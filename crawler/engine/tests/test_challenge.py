"""Challenge detection and rule schema tests."""
from __future__ import annotations

import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from engine.accounts import AccountStore
from engine.challenge import generic_signals
from engine.errors import ChallengeError, RuleError
from engine.fetch import Fetcher
from engine.rules import validate_rule
from engine.scripts import JsRuntime
from engine.search import SearchService
from engine.store import RuleStore


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        if self.path.startswith("/results"):
            body = ('<html><title>搜索</title><div class="result-item">'
                    '<a class="title" href="/d/1">电影 1</a></div></html>')
        else:
            body = ('<html><title>安全验证</title><body><div id="captcha">'
                    '<p>请完成人机验证后继续</p></div></body></html>')
        raw = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class ChallengeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        (base / "rules").mkdir()
        self.store = RuleStore(base / "rules")
        self.search = SearchService(
            self.store,
            Fetcher(timeout=10, max_bytes=1024 * 1024),
            js=JsRuntime(timeout_sec=20),
            accounts=AccountStore(base / "accounts.json"),
        )

    def tearDown(self):
        self.tmp.cleanup()

    def base(self, path: str) -> str:
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def rule(self, path="/captcha", challenge=None) -> dict:
        rule = {
            "name": "测试站",
            "site": "127.0.0.1",
            "search": {"mode": "http", "request": {"url": self.base(path) + "?q={keyword}"}},
            "parse": {
                "type": "html",
                "container": ".result-item",
                "fields": {"title": {"selector": ".title"}, "url": {"selector": "a", "attr": "href"}},
            },
        }
        if challenge is not None:
            rule["challenge"] = challenge
        return rule

    def test_challenge_block_requires_detector(self):
        with self.assertRaises(RuleError):
            validate_rule(self.rule(challenge={"enabled": True}))

    def test_keyword_detection_raises(self):
        saved = self.store.save(self.rule(challenge={"enabled": True, "keywords": ["人机验证"]}))
        with self.assertRaises(ChallengeError) as ctx:
            self.search.search(saved["id"], "电影", role="root")
        self.assertEqual(ctx.exception.code, "challenge_required")
        self.assertEqual(ctx.exception.details["ruleId"], saved["id"])

    def test_selector_detection_raises(self):
        saved = self.store.save(self.rule(challenge={"enabled": True, "selectors": ["#captcha"]}))
        with self.assertRaises(ChallengeError):
            self.search.search(saved["id"], "电影", role="root")

    def test_no_challenge_block_parses(self):
        saved = self.store.save(self.rule("/results"))
        result = self.search.search(saved["id"], "电影", role="root")
        self.assertEqual(result["count"], 1)

    def test_generic_signals(self):
        info = generic_signals(
            '<html><title>安全验证</title><div id="captcha">请完成人机验证</div></html>',
            "https://x.example.com/verify?next=1", 200)
        self.assertTrue(info["likelyChallenge"])
        self.assertIn("#captcha", info["suggestedChallenge"]["selectors"])
        self.assertIn("安全验证", info["suggestedChallenge"]["keywords"])


if __name__ == "__main__":
    unittest.main()