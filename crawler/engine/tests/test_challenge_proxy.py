"""Challenge session store, proxy rewriting and verification tests."""
from __future__ import annotations

import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine.api import ApiServer
from engine.app import Engine
from engine.challenge_proxy import ChallengeSessionStore


class OriginHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        cookie = self.headers.get("Cookie") or ""
        if self.path.startswith("/verify") and "auth=ok" in cookie:
            body = ('<html><title>结果</title><div class="item">'
                    '<a class="title" href="/detail/1">电影 1</a></div></html>')
        elif self.path.startswith("/results"):
            body = ('<html><title>结果</title><div class="item">'
                    '<a class="title" href="/detail/1">电影 1</a></div></html>')
        elif self.path.startswith("/page"):
            body = ('<html><head><title>安全验证</title></head><body>'
                    '<div id="captcha">请完成人机验证</div>'
                    '<script src="/static/app.js"></script>'
                    '<a href="/next">继续</a></body></html>')
        elif self.path.startswith("/style.css"):
            self.send_response(200)
            raw = b".bg{background:url(/static/bg.png)}"
            self.send_header("Content-Type", "text/css")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        else:
            body = "<html><body>hello</body></html>"
        raw = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", "sid=ok; Path=/; HttpOnly")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def make_rule(base: str):
    return {
        "name": "验证测试站",
        "site": "verify.test",
        "search": {"mode": "http", "request": {"url": base + "/verify?q={keyword}"}},
        "parse": {
            "type": "html",
            "container": ".item",
            "fields": {
                "title": {"selector": ".title"},
                "url": {"selector": ".title", "attr": "href"},
            },
        },
    }


class ChallengeProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), OriginHandler)
        cls.port = cls.server.server_address[1]
        cls.base = "http://127.0.0.1:%d" % cls.port
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_rewrite_html_and_css(self):
        store = ChallengeSessionStore()
        session = store.create(
            {"id": "r1", "name": "站", "site": "verify.test"},
            "电影", "room1", "guest",
            {"pageUrl": self.base + "/page", "status": 403},
            {"reason": "title"},
        )
        html = store.rewrite_html(session, '<html><head></head><body><script src="/static/app.js"></script>'
                                           '<a href="/next">x</a></body></html>')
        prefix = store.proxy_base(session)
        self.assertIn(prefix + "/static/app.js", html)
        self.assertIn(prefix + "/next", html)
        self.assertIn("__crawlerProxyMap", html)
        css = store.rewrite_css(session, ".bg{background:url(/static/bg.png)}", self.base + "/style.css")
        self.assertIn(prefix + "/static/bg.png", css)

    def test_cookie_roundtrip(self):
        store = ChallengeSessionStore()
        session = store.create(
            {"id": "r1", "name": "站", "site": "verify.test"},
            "电影", None, "guest",
            {"pageUrl": self.base + "/page", "status": 403}, {"reason": "title"},
        )
        rewritten = store.absorb_response_cookies(session, ["sid=abc; Path=/; HttpOnly"])
        self.assertIn("zc_", rewritten[0])
        name = rewritten[0].split("=", 1)[0]
        store.absorb_browser_cookies(session, "%s=abc; other=1" % name)
        self.assertEqual(session["cookies"].get("sid"), "abc")
        status, headers, raw = store.fetch(session, self.base + "/page")
        self.assertEqual(status, 200)
        self.assertIn("安全验证".encode("utf-8"), raw)

    def test_engine_verify_with_cookies(self):
        with tempfile.TemporaryDirectory(prefix="crawler-challenge-") as tmp:
            engine = Engine(tmp)
            rule = engine.store.save(make_rule(self.base))
            session = engine.challenges.create(
                rule, "电影", "room1", "guest",
                {"pageUrl": self.base + "/verify?q=电影", "status": 403}, {"reason": "title"},
            )
            session["cookies"]["auth"] = "ok"
            result = engine.verify_challenge(session["id"])
            self.assertTrue(result["verified"])
            self.assertEqual(result["result"]["count"], 1)
            self.assertTrue(engine.challenges.get(session["id"])["completed"])

    def test_api_proxy_and_status(self):
        with tempfile.TemporaryDirectory(prefix="crawler-challenge-api-") as tmp:
            engine = Engine(tmp)
            rule = engine.store.save(make_rule(self.base))
            session = engine.challenges.create(
                rule, "电影", "room1", "guest",
                {"pageUrl": self.base + "/page", "status": 403}, {"reason": "title"},
            )
            server = ApiServer(engine, host="127.0.0.1", port=0)
            httpd = server.build()
            port = httpd.server_address[1]
            thread = threading.Thread(target=httpd.serve_forever, daemon=True)
            thread.start()
            try:
                import http.client
                import urllib.request
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
                connection.request("GET", "/api/crawler/challenge/%s/site" % session["id"])
                redirect = connection.getresponse()
                redirect.read()
                connection.close()
                self.assertEqual(302, redirect.status)
                self.assertTrue((redirect.getheader("Location") or "").endswith("/site/page"))
                with urllib.request.urlopen(
                        "http://127.0.0.1:%d/api/crawler/challenge/%s/site/page" % (port, session["id"]),
                        timeout=10) as response:
                    body = response.read().decode("utf-8")
                    self.assertIn("__crawlerProxyMap", body)
                    self.assertIn("/api/crawler/challenge/%s/site/static/app.js" % session["id"], body)
            finally:
                server.stop()
                thread.join(timeout=2)