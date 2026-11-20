"""Browser bridge tests that do not spawn a real Chromium process."""
from __future__ import annotations

import tempfile
import unittest

from engine.accounts import AccountStore
from engine.app import Engine
from engine.browser import BrowserController, _browser_candidates


class _FakePage:
    url = "https://example.com/"

    def cookies(self, site=""):
        return [
            {"name": "sid", "value": "abc123", "domain": ".example.com"},
            {"name": "theme", "value": "dark", "domain": "example.com"},
            {"name": "other", "value": "x", "domain": "other.com"},
        ]



class _FakeProc:
    def poll(self):
        return None


class _FakeNavPage:
    def __init__(self, url="https://example.com/"):
        self.url = url

    def info(self):
        return {"url": self.url, "title": "Example"}

    def navigate(self, url, timeout=0):
        self.url = url
        return self.info()


class BrowserShowHideTest(unittest.TestCase):
    def test_show_switches_to_visible_and_hide_back(self):
        controller = BrowserController({}, tempfile.mkdtemp(prefix="crawler-browser-"))
        controller._proc = _FakeProc()
        controller._mode = "headless"
        controller._page = _FakeNavPage()
        launched = []

        def fake_launch(mode, url=""):
            launched.append((mode, url))
            controller._mode = mode
            controller._page = _FakeNavPage(url or "about:blank")
            return controller._page.info()

        controller._launch = fake_launch
        shown = controller.show()
        self.assertEqual(shown["mode"], "visible")
        self.assertEqual(launched[0], ("visible", "https://example.com/"))
        hidden = controller.hide()
        self.assertEqual(hidden["mode"], "headless")
        self.assertEqual(launched[-1], ("headless", "https://example.com/"))

class BrowserBridgeTest(unittest.TestCase):
    def test_cookie_summary_filters_domain(self):
        controller = BrowserController({}, tempfile.mkdtemp(prefix="crawler-browser-"))
        controller._require_page = lambda: _FakePage()
        summary = controller.cookie_summary("example.com")
        self.assertEqual(summary["count"], 2)
        self.assertIn("sid", summary["names"])
        self.assertNotIn("other", summary["names"])
        header = controller.cookie_header("example.com")
        self.assertIn("sid=abc123", header)
        self.assertIn("theme=dark", header)
        self.assertNotIn("other=", header)

    def test_save_login_stores_account_without_exposing_cookie(self):
        tmp = tempfile.mkdtemp(prefix="crawler-browser-")
        store = AccountStore(tmp + "/accounts.json")
        controller = BrowserController({}, tmp)
        controller._require_page = lambda: _FakePage()
        result = controller.save_login("example.com", name="示例账号", accounts=store)
        self.assertTrue(result["success"])
        self.assertEqual(result["cookieCount"], 2)
        self.assertNotIn("abc123", result["account"]["cookies"])
        saved = store.get(result["account"]["id"])
        self.assertIn("sid=abc123", saved["cookies"])
        self.assertNotIn("other=", saved["cookies"])

    def test_registry_exposes_browser_tools_only_for_admin(self):
        tmp = tempfile.TemporaryDirectory(prefix="crawler-browser-")
        self.addCleanup(tmp.cleanup)
        engine = Engine(tmp.name)
        self.assertIn("browser_open", engine.admin_registry.names())
        self.assertIn("browser_save_login", engine.admin_registry.names())
        self.assertIn("browser_show", engine.admin_registry.names())
        self.assertIn("browser_hide", engine.admin_registry.names())
        # Agent 的 registry 也注入浏览器工具：登录/验证与 SPA 探查需要 Agent 自己操作窗口。
        self.assertIn("browser_open", engine.registry.names())
        self.assertIn("browser_show", engine.registry.names())

    def test_browser_candidates_are_absolute(self):
        for path in _browser_candidates():
            self.assertTrue(path)


if __name__ == "__main__":
    unittest.main()
