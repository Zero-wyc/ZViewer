"""Submission queue API tests."""
from __future__ import annotations

import tempfile
import threading
import time
import unittest

from engine.api import ApiServer
from engine.app import Engine
from engine.tests.test_api import ApiTest, sample_rule


class SubmissionApiTest(ApiTest):

    def test_submission_run_creates_session_and_streams(self):
        """点击「生成规则」应像人工对话一样：建会话 + 发消息 + 事件流。"""
        self.engine.config["llm"]["api_key"] = "sk-test"
        status, payload = self.call("POST", "/api/crawler/rules", {"rule": sample_rule()})
        self.assertEqual(status, 200)
        rule_id = payload["rule"]["id"]
        status, payload = self.call("POST", "/api/crawler/submissions", {
            "url": "https://example.com", "name": "示例站", "keyword": "流浪地球"})
        self.assertEqual(status, 200)
        submission_id = payload["submission"]["id"]
        captured = {}

        class FakeRun:
            status = "done"
            session_id = ""
            error = ""
            reply = "规则已保存"

        def fake_start(message, session_id="", context=None, reasoning_effort=None,
                       model=None, images=None, on_finish=None):
            captured.update(message=message, session_id=session_id, context=context,
                            effort=reasoning_effort)
            run = FakeRun()
            run.session_id = session_id
            if on_finish is not None:
                on_finish(run)
            return {"success": True, "runId": "run-sub", "sessionId": session_id}

        self.engine.agent_runs.start = fake_start
        self.engine.search.test_rule = lambda rule, keyword, limit=10: {
            "ok": True, "count": 1, "items": [{"title": "流浪地球"}]}
        status, payload = self.call("POST", "/api/crawler/submissions/%s/run" % submission_id, {})
        self.assertEqual(status, 200)
        self.assertTrue(payload["success"])
        self.assertEqual(payload["runId"], "run-sub")
        session_id = payload["sessionId"]
        self.assertTrue(session_id)
        self.assertIn("流浪地球", captured["message"])
        self.assertIn("example.com", captured["message"])
        self.assertEqual(captured["context"], {"submissionId": submission_id})
        session = self.engine.agent._load_session(session_id)
        self.assertTrue(session["title"].startswith("生成规则："))
        status, payload = self.call("GET", "/api/crawler/submissions/" + submission_id)
        self.assertEqual(status, 200)
        self.assertEqual(payload["submission"]["status"], "done")
        self.assertEqual(payload["submission"]["ruleId"], rule_id)
        self.assertEqual(payload["submission"]["sessionId"], session_id)
    def test_submit_list_dedupe_and_delete(self):
        body = {
            "url": "https://example.org",
            "name": "示例资源站",
            "keyword": "流浪地球",
            "roomId": "room-1",
            "roomName": "测试房间",
            "submittedBy": "游客A",
            "note": "只能搜电影",
        }
        status, payload = self.call("POST", "/api/crawler/submissions", body)
        self.assertEqual(status, 200)
        self.assertTrue(payload["success"])
        self.assertFalse(payload["duplicate"])
        submission = payload["submission"]
        self.assertEqual(submission["site"], "example.org")
        self.assertEqual(submission["roomId"], "room-1")
        self.assertEqual(submission["status"], "pending")

        status, payload = self.call("POST", "/api/crawler/submissions", body)
        self.assertEqual(status, 200)
        self.assertTrue(payload["duplicate"])

        status, payload = self.call("GET", "/api/crawler/submissions?status=pending")
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 1)

        status, payload = self.call("DELETE", "/api/crawler/submissions/" + submission["id"])
        self.assertEqual(status, 200)
        self.assertTrue(payload["deleted"])
        status, payload = self.call("GET", "/api/crawler/submissions")
        self.assertEqual(payload["count"], 0)

    def test_manual_generate_runs_agent(self):
        self.engine.config["llm"]["api_key"] = "sk-test"
        rule = sample_rule()
        rule.update({"id": "example-org", "name": "示例资源站", "site": "example.org"})
        status, _payload = self.call("POST", "/api/crawler/rules", {"rule": rule})
        self.assertEqual(status, 200)
        calls = _install_fake_runs(self.engine)
        self.engine.search.test_rule = lambda rule, keyword, limit=10: {
            "ok": True, "count": 1, "items": [{"title": "电影"}]}
        status, payload = self.call("POST", "/api/crawler/submissions", {
            "url": "https://example.org", "keyword": "电影", "roomId": "room-2"})
        submission_id = payload["submission"]["id"]
        status, payload = self.call("POST", "/api/crawler/submissions/%s/generate" % submission_id)
        self.assertEqual(status, 200)
        self.assertTrue(payload["success"])
        item = _wait_terminal(self, submission_id)
        self.assertEqual(item["status"], "done", msg=item.get("error"))
        self.assertEqual(item["ruleId"], "example-org")
        self.assertEqual(len(calls), 1)
        self.assertIn("https://example.org", calls[0]["message"])
        self.assertIn("电影", calls[0]["message"])
        self.assertTrue(item["sessionId"])
        self.assertTrue(calls[0]["session_id"])
        self.assertEqual(item["runId"], "run-1")
        session_path = self.engine.paths.data_dir / "sessions" / (item["sessionId"] + ".json")
        self.assertTrue(session_path.exists(), "生成规则应创建真实会话文件")

    def test_auto_generate_toggle_queues_on_submit(self):
        self.engine.config["llm"]["api_key"] = "sk-test"
        self.engine.config["submissions"]["auto_generate"] = True
        rule = sample_rule()
        rule.update({"id": "auto-rule", "name": "自动站", "site": "auto.example"})
        status, _payload = self.call("POST", "/api/crawler/rules", {"rule": rule})
        self.assertEqual(status, 200)
        calls = _install_fake_runs(self.engine)
        self.engine.search.test_rule = lambda rule, keyword, limit=10: {
            "ok": True, "count": 1, "items": [{"title": "电影"}]}
        status, payload = self.call("POST", "/api/crawler/submissions", {
            "url": "https://auto.example", "keyword": "电影"})
        self.assertEqual(status, 200)
        self.assertTrue(payload.get("autoQueued"), msg=payload)
        submission_id = payload["submission"]["id"]
        item = _wait_terminal(self, submission_id)
        self.assertEqual(item["status"], "done", msg=item.get("error"))
        self.assertEqual(item["ruleId"], "auto-rule")
        self.assertTrue(item["sessionId"])
        self.assertEqual(len(calls), 1)
        self.assertIn("https://auto.example", calls[0]["message"])

    def test_generations_run_one_at_a_time(self):
        """手动连续点两次「生成规则」时，第二条排队，等第一条完成再自动开始。"""
        self.engine.config["llm"]["api_key"] = "sk-test"
        status, _payload = self.call("POST", "/api/crawler/rules", {"rule": sample_rule()})
        self.assertEqual(status, 200)
        calls = _install_fake_runs(self.engine, auto_finish=False)
        self.engine.search.test_rule = lambda rule, keyword, limit=10: {
            "ok": True, "count": 1, "items": [{"title": "电影"}]}
        first = self._submit("https://example.com", "A 站")
        second = self._submit("https://b.example", "B 站")

        status, payload = self.call("POST", "/api/crawler/submissions/%s/run" % first, {})
        self.assertEqual(status, 200)
        self.assertEqual(payload["runId"], "run-1")
        self.assertFalse(payload.get("queued"))
        self.assertEqual(len(calls), 1)

        status, payload = self.call("POST", "/api/crawler/submissions/%s/run" % second, {})
        self.assertEqual(status, 200)
        self.assertTrue(payload["success"])
        self.assertTrue(payload.get("queued"), msg=payload)
        self.assertEqual(payload["position"], 1)
        self.assertTrue(payload.get("sessionId"))
        self.assertNotIn("runId", payload)
        self.assertEqual(len(calls), 1, "第二条不能同时启动")

        status, payload = self.call("GET", "/api/crawler/submissions")
        self.assertEqual(status, 200)
        rows = {item["id"]: item for item in payload["submissions"]}
        self.assertEqual(rows[second]["status"], "queued")
        self.assertEqual(rows[second]["queuePosition"], 1)
        self.assertEqual(self.engine.queue_positions(), {second: 1})

        # 第一条结束 -> 队列自动启动第二条
        fake_run = FakeRun(status="done", session_id=calls[0]["session_id"])
        calls[0]["on_finish"](fake_run)
        self.assertEqual(len(calls), 2)
        self.assertIn("https://b.example", calls[1]["message"])
        self.assertEqual(self.engine.queue_positions(), {})
        status, payload = self.call("GET", "/api/crawler/submissions/" + first)
        self.assertEqual(payload["submission"]["status"], "done")
        status, payload = self.call("GET", "/api/crawler/submissions/" + second)
        self.assertEqual(payload["submission"]["status"], "processing")
        self.assertEqual(payload["submission"]["runId"], "run-2")

    def test_delete_cancels_queued_generation(self):
        self.engine.config["llm"]["api_key"] = "sk-test"
        _install_fake_runs(self.engine, auto_finish=False)
        first = self._submit("https://example.com", "A 站")
        second = self._submit("https://b.example", "B 站")
        self.call("POST", "/api/crawler/submissions/%s/run" % first, {})
        status, payload = self.call("POST", "/api/crawler/submissions/%s/run" % second, {})
        self.assertTrue(payload.get("queued"))
        self.assertEqual(self.engine.queue_positions(), {second: 1})
        status, payload = self.call("DELETE", "/api/crawler/submissions/" + second)
        self.assertEqual(status, 200)
        self.assertTrue(payload["deleted"])
        self.assertEqual(self.engine.queue_positions(), {}, "删除提交应同时取消排队")

    def _submit(self, url, name):
        status, payload = self.call("POST", "/api/crawler/submissions", {
            "url": url, "name": name, "keyword": "电影"})
        self.assertEqual(status, 200)
        return payload["submission"]["id"]


class FakeRun:
    def __init__(self, status="done", session_id="", error="", reply="规则已保存"):
        self.status = status
        self.session_id = session_id
        self.error = error
        self.reply = reply


def _install_fake_runs(engine, auto_finish=True):
    """替换 agent_runs.start：记录调用，默认同步完成，便于测试队列串行语义。"""
    calls = []

    def fake_start(message, session_id="", context=None, reasoning_effort=None,
                   model=None, images=None, on_finish=None):
        calls.append({"message": message, "session_id": session_id,
                      "context": context, "effort": reasoning_effort,
                      "on_finish": on_finish})
        if auto_finish and on_finish is not None:
            on_finish(FakeRun(status="done", session_id=session_id))
        return {"success": True, "runId": "run-%d" % len(calls), "sessionId": session_id}

    engine.agent_runs.start = fake_start
    return calls


def _wait_terminal(case, submission_id, timeout=5):
    deadline = time.time() + timeout
    item = None
    while time.time() < deadline:
        status, payload = case.call("GET", "/api/crawler/submissions/" + submission_id)
        case.assertEqual(status, 200)
        item = payload["submission"]
        if item["status"] in ("done", "failed"):
            break
        time.sleep(0.05)
    return item


if __name__ == "__main__":
    unittest.main()