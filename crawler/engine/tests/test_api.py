"""HTTP API tests for the crawler engine."""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from engine.api import ApiServer
from engine.app import Engine


def sample_rule():
    return {
        "name": "示例站",
        "site": "example.com",
        "search": {"mode": "http", "request": {"url": "https://example.com/search?q={keyword}"}},
        "parse": {
            "type": "json",
            "list_path": "data",
            "fields": {"title": {"path": "title"}, "url": {"path": "url"}},
        },
    }


class ApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="crawler-api-")
        self.engine = Engine(self.tmp.name)
        self.server = ApiServer(self.engine, host="127.0.0.1", port=0)
        httpd = self.server.build()
        self.port = httpd.server_address[1]
        self.thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.stop()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def call(self, method, path, body=None, token=None):
        data = None
        headers = {}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["X-Admin-Token"] = token
        request = Request("http://127.0.0.1:%d%s" % (self.port, path), data=data,
                          headers=headers, method=method)
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read().decode("utf-8"))
            finally:
                exc.close()

    def test_health_and_manual_rule_crud(self):
        status, payload = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["rules"], 0)

        status, payload = self.call("POST", "/api/crawler/rules", {"rule": sample_rule()})
        self.assertEqual(status, 200)
        rule_id = payload["rule"]["id"]
        self.assertEqual(status, 200)
        self.assertEqual(payload["rule"]["name"], "示例站")

        status, payload = self.call("GET", "/api/crawler/rules")
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 1)

        status, payload = self.call(
            "PUT", "/api/crawler/rules/" + rule_id,
            {"patch": {"description": "手动添加", "enabled": False}},
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["rule"]["description"], "手动添加")
        self.assertFalse(payload["rule"]["enabled"])

    def test_disabled_rule_hidden_and_unusable(self):
        status, payload = self.call("POST", "/api/crawler/rules", {"rule": sample_rule()})
        rule_id = payload["rule"]["id"]
        status, sites = self.call("GET", "/api/crawler/sites")
        self.assertEqual(status, 200)
        self.assertEqual(sites["count"], 1)

        status, payload = self.call("PUT", "/api/crawler/rules/" + rule_id,
                                    {"patch": {"enabled": False}})
        self.assertEqual(status, 200)
        self.assertFalse(payload["rule"]["enabled"])

        # 停用后网页端列表不显示，也不能再用于搜索；规则文件仍然保留。
        status, sites = self.call("GET", "/api/crawler/sites")
        self.assertEqual(status, 200)
        self.assertEqual(sites["count"], 0)
        status, payload = self.call("POST", "/api/crawler/search",
                                    {"site": rule_id, "keyword": "电影"})
        self.assertEqual(status, 403)
        self.assertEqual(payload.get("code"), "site_forbidden")
        status, payload = self.call("GET", "/api/crawler/rules/" + rule_id)
        self.assertEqual(status, 200)
        self.assertFalse(payload["rule"]["enabled"])

    def test_export_import_roundtrip(self):
        self.call("POST", "/api/crawler/rules", {"rule": sample_rule()})
        status, payload = self.call("GET", "/api/crawler/rules/export")
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 1)
        bundle = payload["bundle"]
        self.assertEqual(bundle["kind"], "zviewer-crawler-rules")

        status, payload = self.call("POST", "/api/crawler/rules/import",
                                    {"bundle": bundle, "dryRun": True})
        self.assertEqual(status, 200)
        self.assertTrue(payload["dryRun"])
        self.assertEqual(payload["updated"], 1)
        self.assertEqual(payload["failed"], 0)

        status, payload = self.call("POST", "/api/crawler/rules/import",
                                    {"rules": bundle["rules"], "mode": "replace"})
        self.assertEqual(status, 200)
        self.assertTrue(payload["success"])
        self.assertEqual(payload["imported"], 1)
        self.assertEqual(self.engine.store.list().__len__(), 1)

    def test_admin_token_required_when_configured(self):
        self.engine.config["engine"]["admin_token"] = "secret-token"
        try:
            status, payload = self.call("GET", "/api/crawler/rules")
            self.assertEqual(status, 401)
            self.assertFalse(payload["success"])
            status, payload = self.call("GET", "/api/crawler/rules", token="secret-token")
            self.assertEqual(status, 200)
            self.assertTrue(payload["success"])
        finally:
            self.engine.config["engine"]["admin_token"] = ""

    def test_config_api_masks_key(self):
        status, payload = self.call("PUT", "/api/crawler/config",
                                    {"llm": {"api_key": "sk-test-1234567890"}})
        self.assertEqual(status, 200)
        self.assertNotEqual(payload["config"]["llm"]["api_key"], "sk-test-1234567890")
        status, payload = self.call("GET", "/api/crawler/config")
        self.assertEqual(status, 200)
        self.assertTrue(payload["config"]["llmConfigured"])


if __name__ == "__main__":
    unittest.main()
