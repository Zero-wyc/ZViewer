"""播放解析段（play）与 test_play 工具的回归测试。"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from engine.rules import validate_rule
from engine.store import RuleStore
from engine.tools import build_registry


BASE_RULE = {
    "name": "测试站",
    "site": "example.com",
    "search": {
        "mode": "http",
        "request": {"method": "GET", "url": "https://example.com/search?q={keyword}"},
    },
    "parse": {
        "type": "html",
        "container": ".item",
        "fields": {
            "title": {"selector": ".title", "attr": "text"},
            "url": {"selector": "a", "attr": "href", "absolute": True},
        },
    },
}


class FakePlay:
    def __init__(self):
        self.calls = []

    def resolve(self, target, room_id="", role="guest", rule=None):
        self.calls.append({"target": target, "rule": rule})
        return {"success": True, "format": "hls", "url": "https://cdn.example.com/a.m3u8"}


class PlayRuleTests(unittest.TestCase):
    def test_rule_keeps_play_section(self):
        rule = dict(BASE_RULE)
        rule["play"] = {
            "headers": {"Referer": "https://example.com/"},
            "play_url_regex": r"vodplay/(?P<vodId>\d+)-(?P<playFrom>[a-z0-9]+)-(?P<index>\d+)\.html",
            "api": {
                "url": "https://example.com/api/play?vodId={vodId}&from={playFrom}&index={index}",
                "skipFrom": ["bilibili"],
            },
        }
        saved = validate_rule(rule)
        play = saved["play"]
        self.assertEqual(play["api"]["skipFrom"], ["bilibili"])
        self.assertEqual(play["headers"]["Referer"], "https://example.com/")

    def test_store_roundtrip_and_public_view(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = RuleStore(tmp)
            rule = dict(BASE_RULE)
            rule["play"] = {"api": {"url": "https://example.com/api/play?id={id}"}}
            saved = store.save(rule)
            path = Path(tmp) / ("%s.json" % saved["id"])
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertIn("play", on_disk)
            self.assertEqual(store.get(saved["id"])["play"]["api"]["url"],
                             "https://example.com/api/play?id={id}")

    def test_test_play_forwards_rule_override(self):
        fake = FakePlay()
        registry = build_registry(None, None, None, play=fake)
        self.assertIn("test_play", registry.names())
        payload = {"play": {"api": {"url": "https://example.com/api/play?id={id}"}}}
        result = registry.call("test_play", {"detail_url": "https://example.com/detail/1", "rule": payload})
        self.assertTrue(result["success"])
        self.assertEqual(fake.calls[0]["target"], "https://example.com/detail/1")
        self.assertEqual(fake.calls[0]["rule"], payload)

    def test_test_play_without_resolver(self):
        registry = build_registry(None, None, None)
        result = registry.call("test_play", {"detail_url": "https://example.com/detail/1"})
        self.assertFalse(result["success"])
        self.assertEqual(result["code"], "unavailable")


class QualityTests(unittest.TestCase):
    def test_normalize_qualities_filters_and_names(self):
        from engine.play import normalize_qualities

        items = normalize_qualities([
            {"name": "1080P", "url": "https://cdn.example.com/hi.m3u8"},
            {"url": "https://cdn.example.com/hd.m3u8"},
            "https://cdn.example.com/sd.mp4",
            "https://cdn.example.com/hi.m3u8",       # 重复地址丢弃
            {"name": "坏的", "url": "ftp://x/y.m3u8"},  # 非 http 地址丢弃
            {"name": "1080P", "url": "https://cdn.example.com/hi2.m3u8"},  # 同名自动编号
        ], {"Referer": "https://example.com/"})
        self.assertEqual([item["name"] for item in items],
                         ["1080P", "HLS", "MP4", "1080P 2"])
        self.assertEqual(items[0]["format"], "hls")
        self.assertEqual(items[0]["headers"]["Referer"], "https://example.com/")

    def test_result_defaults_to_first_quality(self):
        from engine.play import PlayResolver

        resolver = PlayResolver(None, None)
        result = resolver._result(
            rule={"id": "r1", "name": "测试站", "site": "example.com"},
            page_url="https://example.com/detail/1", title="标题", url="",
            headers={}, episodes=[], source="rule-script",
            qualities=[{"name": "高清", "url": "https://cdn.example.com/hi.m3u8"}],
        )
        self.assertEqual(result["url"], "https://cdn.example.com/hi.m3u8")
        self.assertEqual(result["format"], "hls")
        self.assertEqual(result["qualities"][0]["name"], "高清")

    def test_result_without_qualities_keeps_old_shape(self):
        from engine.play import PlayResolver

        resolver = PlayResolver(None, None)
        result = resolver._result(
            rule=None, page_url="https://example.com/x", title="t",
            url="https://cdn.example.com/a.mp4", headers={}, episodes=[], source="page",
        )
        self.assertNotIn("qualities", result)
        self.assertEqual(result["format"], "mp4")


class FakeAccounts:
    def __init__(self, items):
        self.items = items

    def resolve(self, account_id):
        return dict(self.items.get(account_id) or {})


class FakeJs:
    def __init__(self, result):
        self.result = result
        self.payload = None

    def run(self, source, payload, timeout_sec=None):
        self.payload = payload
        return {"ok": True, "result": self.result}


class FakeFetcher:
    def fetch(self, url, **kwargs):
        return type("Resp", (), {"status": 200, "url": url, "text": "", "final_url": url})()


ACCOUNT = {"id": "demo", "cookies": "SESSDATA=abc", "headers": {"X-Site-Auth": "token-1"}}


class PlayScriptAccountTests(unittest.TestCase):
    """规则绑定账号后，play.script 能拿到登录态做试播。"""

    def _rule(self, *, play_account="", search_account=""):
        return {
            "id": "demo", "name": "测试站", "site": "example.com",
            "search": {"account_id": search_account},
            "play": {
                "account_id": play_account,
                "script": {"runtime": "node", "source": "return {url: 'x'}"},
            },
        }

    def _resolver(self, accounts):
        from engine.play import PlayResolver

        self.js = FakeJs({"url": "https://cdn.example.com/a.m3u8", "format": "hls"})
        return PlayResolver(None, FakeFetcher(), js=self.js, accounts=accounts)

    def test_script_receives_bound_account(self):
        resolver = self._resolver(FakeAccounts({"demo": ACCOUNT}))
        result = resolver.resolve("https://example.com/detail/1",
                                  rule=self._rule(play_account="demo"))
        self.assertTrue(result["success"])
        self.assertEqual(self.js.payload["account"]["cookies"], "SESSDATA=abc")
        self.assertEqual(self.js.payload["headers"]["Cookie"], "SESSDATA=abc")
        self.assertEqual(self.js.payload["headers"]["X-Site-Auth"], "token-1")
        self.assertEqual(self.js.payload["headers"]["Referer"], "https://example.com/")
        self.assertEqual(result["headers"]["Cookie"], "SESSDATA=abc")

    def test_script_falls_back_to_search_binding(self):
        resolver = self._resolver(FakeAccounts({"demo": ACCOUNT}))
        result = resolver.resolve("https://example.com/detail/1",
                                  rule=self._rule(search_account="demo"))
        self.assertTrue(result["success"])
        self.assertEqual(self.js.payload["account"]["cookies"], "SESSDATA=abc")

    def test_unbound_rule_gets_no_account(self):
        resolver = self._resolver(FakeAccounts({}))
        result = resolver.resolve("https://example.com/detail/1", rule=self._rule())
        self.assertTrue(result["success"])
        self.assertEqual(self.js.payload["account"], {})
        self.assertNotIn("Cookie", self.js.payload["headers"])

    def test_resolver_without_account_store_ignores_binding(self):
        resolver = self._resolver(None)
        result = resolver.resolve("https://example.com/detail/1",
                                  rule=self._rule(play_account="demo"))
        self.assertTrue(result["success"])
        self.assertEqual(self.js.payload["account"], {})


class BindAccountPlayTests(unittest.TestCase):
    def _store(self, base):
        store = RuleStore(str(base / "rules"))
        return store

    def test_bind_account_syncs_play_section(self):
        from engine.accounts import AccountStore

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            store = self._store(base)
            rule = dict(BASE_RULE)
            rule["play"] = {"api": {"url": "https://example.com/api/play?id={id}"}}
            saved = store.save(rule)
            registry = build_registry(store, None, None,
                                      accounts=AccountStore(base / "accounts.json"))
            result = registry.call("bind_account", {"rule_id": saved["id"], "account_id": "demo"})
            self.assertTrue(result["success"])
            updated = store.get(saved["id"])
            self.assertEqual(updated["search"]["account_id"], "demo")
            self.assertEqual(updated["play"]["account_id"], "demo")
            self.assertEqual(updated["play"]["api"]["url"],
                             "https://example.com/api/play?id={id}")

    def test_bind_account_without_play_section(self):
        from engine.accounts import AccountStore

        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            store = self._store(base)
            saved = store.save(dict(BASE_RULE))
            registry = build_registry(store, None, None,
                                      accounts=AccountStore(base / "accounts.json"))
            registry.call("bind_account", {"rule_id": saved["id"], "account_id": "demo"})
            updated = store.get(saved["id"])
            self.assertEqual(updated["search"]["account_id"], "demo")
            self.assertNotIn("play", updated)


if __name__ == "__main__":
    unittest.main()
