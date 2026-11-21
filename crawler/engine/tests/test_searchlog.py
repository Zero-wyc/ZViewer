"""Tests for the bounded search log store."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from engine.searchlog import SearchLogStore


class SearchLogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "search-logs.json"

    def tearDown(self):
        self.tmp.cleanup()

    def record(self, **overrides):
        rule = {
            "id": "demo",
            "name": "示例站",
            "site": "demo.example.com",
            "search": {"mode": "http"},
            "parse": {"type": "html", "container": ".item"},
        }
        rule.update(overrides.pop("rule_overrides", {}))
        page = {
            "text": "<html>" + ("x" * 900) + "</html>",
            "status": 200,
            "pageUrl": "https://demo.example.com/search?q=movie",
            "request": {"method": "GET", "url": "https://demo.example.com/search?q=movie"},
        }
        return SearchLogStore.build_record(
            rule, "movie", "room-1", "guest", page, [{"title": "a"}], 0,
            overrides.pop("error", ""), overrides.pop("took_ms", 120), **overrides)

    def test_append_trims_and_filters(self):
        store = SearchLogStore(self.path, limit=10)
        store.append(self.record())
        store.append(self.record(error="empty result"))
        store.append(self.record(rule_overrides={"id": "other", "name": "其他", "site": "other.example.com"}))
        store.append(self.record())
        self.assertEqual(store.count(), 4)
        self.assertEqual(len(store.list(limit=2)), 2)
        failures = store.list(failures_only=True)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["error"], "empty result")
        self.assertEqual(len(store.list(site="demo")), 3)
        self.assertEqual(len(store.list(source="test")), 0)

    def test_record_is_compact(self):
        entry = self.record(source="test", repair={"attempted": True, "success": False, "error": "bad"})
        self.assertLessEqual(len(entry["bodyPreview"]), 400)
        self.assertLessEqual(len(entry["repair"]["error"]), 300)
        self.assertTrue(entry["ok"])
        self.assertEqual(entry["source"], "test")
        self.assertEqual(entry["parseType"], "html")

    def test_clear_and_persist(self):
        store = SearchLogStore(self.path)
        store.append(self.record())
        reloaded = SearchLogStore(self.path)
        self.assertEqual(reloaded.count(), 1)
        self.assertEqual(reloaded.clear(), 1)
        self.assertEqual(SearchLogStore(self.path).count(), 0)


if __name__ == "__main__":
    unittest.main()