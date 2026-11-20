"""Tests for the autonomous agent loop, run manager and streaming client."""
from __future__ import annotations

import json
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from engine.agent import RuleAgent
from engine.agent_run import AgentRunManager
from engine.errors import LLMError
from engine.llm import LLMClient


class FakeRegistry:
    def openai_tools(self):
        return []

    def call(self, name, arguments):
        return {"success": True, "name": name}


class ScriptedLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []
        self.models = []

    def chat_stream(self, messages, tools=None, tool_choice="auto", reasoning_effort=None,
                    model=None, on_delta=None, cancel=None):
        self.calls.append(json.loads(json.dumps(messages, ensure_ascii=False)))
        self.models.append(model)
        reply = self.replies.pop(0)
        if on_delta and reply.get("reasoning"):
            on_delta("reasoning", reply["reasoning"])
        if on_delta and reply.get("content"):
            on_delta("content", reply["content"])
        return {
            "content": reply.get("content") or "",
            "reasoning": reply.get("reasoning") or "",
            "toolCalls": reply.get("toolCalls") or [],
        }


def _agent(replies, auto_continue=2):
    tmp = tempfile.TemporaryDirectory()
    agent = RuleAgent(
        ScriptedLLM(replies),
        FakeRegistry(),
        None,
        None,
        {"llm": {}, "generation": {}, "agent": {"max_steps": 8, "auto_continue": auto_continue}},
        data_dir=str(Path(tmp.name)),
    )
    return agent, tmp


class RenameSessionTests(unittest.TestCase):
    def test_agent_can_rename_current_session(self):
        replies = [
            {"toolCalls": [{"id": "r1", "name": "rename_session",
                            "arguments": {"title": "给 example.com 生成规则"}}]},
            {"toolCalls": [{"id": "r2", "name": "task_complete",
                            "arguments": {"summary": "完成"}}]},
        ]
        agent, tmp = _agent(replies)
        try:
            result = agent.chat("帮 example.com 生成规则")
            session = agent.get_session(result["sessionId"])
        finally:
            tmp.cleanup()
        self.assertEqual(session["title"], "给 example.com 生成规则")
        renamed = [event for event in result["events"]
                   if event.get("name") == "rename_session"]
        self.assertTrue(renamed)
        self.assertEqual(renamed[0]["status"], "ok")
        self.assertEqual(renamed[0]["summary"]["title"], "给 example.com 生成规则")


class CustomPromptTests(unittest.TestCase):
    def test_custom_prompt_appended_to_system_message(self):
        tmp = tempfile.TemporaryDirectory(prefix="crawler-agent-")
        self.addCleanup(tmp.cleanup)
        replies = [{"toolCalls": [{"id": "r1", "name": "task_complete",
                                 "arguments": {"summary": "完成"}}]}]
        llm = ScriptedLLM(replies)
        agent = RuleAgent(
            llm, FakeRegistry(), None, None,
            {"llm": {}, "generation": {},
             "agent": {"max_steps": 4, "auto_continue": 0,
                       "custom_prompt": "优先使用 hls 线路"}},
            data_dir=tmp.name,
        )
        agent.chat("你好")
        system = llm.calls[0][0]["content"]
        self.assertIn("管理员自定义指令", system)
        self.assertIn("优先使用 hls 线路", system)


class AutonomyTests(unittest.TestCase):
    def test_agent_continues_and_calls_task_complete(self):
        replies = [
            {
                "reasoning": "先打开页面看看。",
                "content": "我打开页面。",
                "toolCalls": [{"id": "c1", "name": "fetch_page",
                               "arguments": {"url": "https://example.com"}}],
            },
            {"content": "页面已经看完，我继续整理。"},
            {
                "reasoning": "任务完成，给出总结。",
                "toolCalls": [{"id": "c2", "name": "task_complete",
                               "arguments": {"summary": "规则已保存：示例站"}}],
            },
        ]
        agent, tmp = _agent(replies)
        try:
            events = []
            result = agent.chat("帮我生成 example.com 的规则", emit=events.append,
                                autonomous=True)
            session = agent.get_session(result["sessionId"])
        finally:
            tmp.cleanup()
        self.assertTrue(result["success"])
        self.assertEqual(result["reply"], "规则已保存：示例站")
        self.assertEqual(result["steps"], 3)
        self.assertEqual(result["sessionId"], result["sessionId"])
        kinds = [item["kind"] for item in events]
        self.assertIn("thinking", kinds)
        self.assertIn("tool", kinds)
        self.assertIn("continue", kinds)
        self.assertIn("done", kinds)
        tool_rows = [item for item in events if item["kind"] == "tool"]
        self.assertTrue(any(item["name"] == "task_complete" and item["status"] == "ok"
                            for item in tool_rows))
        assistant = session["messages"][-1]
        self.assertEqual(assistant["content"], "规则已保存：示例站")
        self.assertTrue(any(item["kind"] == "thinking" for item in assistant.get("events") or []))

    def test_run_manager_exposes_incremental_events(self):
        replies = [
            {
                "reasoning": "思考一下。",
                "toolCalls": [{"id": "c1", "name": "fetch_page", "arguments": {}}],
            },
            {"toolCalls": [{"id": "c2", "name": "task_complete",
                            "arguments": {"summary": "完成"}}]},
        ]
        agent, tmp = _agent(replies)
        try:
            manager = AgentRunManager(agent)
            started = manager.start("做点事情")
            run_id = started["runId"]
            deadline = time.time() + 5
            snap = None
            while time.time() < deadline:
                snap = manager.get(run_id, 0)
                if snap["done"]:
                    break
                time.sleep(0.05)
            self.assertTrue(snap["done"])
            self.assertEqual(snap["status"], "done")
            self.assertTrue(any(item["kind"] == "thinking" for item in snap["events"]))
            self.assertTrue(any(item["kind"] == "done" for item in snap["events"]))
            self.assertIsNone(manager.get("run-missing", 0))
        finally:
            tmp.cleanup()


class AskUserTests(unittest.TestCase):
    def test_agent_pauses_and_asks_user(self):
        replies = [
            {
                "content": "这个站要登录才能搜，我先确认一下。",
                "toolCalls": [{"id": "q1", "name": "ask_user",
                               "arguments": {
                                   "question": "需要你在这个窗口登录一下，登录好了吗？",
                                   "options": ["已登录，继续", "先跳过这个站"],
                               }}],
            },
        ]
        agent, tmp = _agent(replies)
        try:
            events = []
            result = agent.chat("给需要登录的站点生成规则", emit=events.append,
                                autonomous=True)
            session = agent.get_session(result["sessionId"])
        finally:
            tmp.cleanup()
        self.assertTrue(result["success"])
        self.assertTrue(result["awaitingUser"])
        self.assertEqual(result["steps"], 1)
        self.assertIn("登录好了吗", result["reply"])
        self.assertIn("1. 已登录，继续", result["reply"])
        self.assertIn("2. 先跳过这个站", result["reply"])
        self.assertFalse(any(item["kind"] == "continue" for item in events))
        self.assertTrue(any(item["kind"] == "tool" and item.get("name") == "ask_user"
                            and item.get("status") == "ok" for item in events))
        self.assertEqual(session["messages"][-1]["content"], result["reply"])


class UnlimitedStepsTests(unittest.TestCase):
    def test_zero_max_steps_means_no_tool_call_limit(self):
        replies = [{"toolCalls": [{"id": "s%d" % index, "name": "fetch_page",
                                   "arguments": {"url": "https://example.com/%d" % index}}]}
                   for index in range(10)]
        replies.append({"toolCalls": [{"id": "done", "name": "task_complete",
                                      "arguments": {"summary": "做完了"}}]})
        tmp = tempfile.TemporaryDirectory(prefix="crawler-agent-")
        self.addCleanup(tmp.cleanup)
        agent = RuleAgent(
            ScriptedLLM(replies), FakeRegistry(), None, None,
            {"llm": {}, "generation": {}}, data_dir=tmp.name,
        )
        result = agent.chat("多跑几步", autonomous=True)
        self.assertTrue(result["success"])
        self.assertEqual(result["steps"], 11)
        self.assertFalse(result["truncated"])
        self.assertEqual(result["reply"], "做完了")


class _SSEHandler(BaseHTTPRequestHandler):
    last_payload = {}

    def log_message(self, fmt, *args):
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            type(self).last_payload = json.loads(raw.decode("utf-8"))
        except ValueError:
            type(self).last_payload = {}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "想"}}]},
            {"choices": [{"delta": {"reasoning_content": "一想"}}]},
            {"choices": [{"delta": {"content": "你好"}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "call_1", "function": {"name": "fetch_page", "arguments": "{\"url\":"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": "\"https://example.com\"}"}}]}}]},
            {"choices": [{"delta": {}, "finish_reason": "tool_calls"}], "usage": {"total_tokens": 3}},
        ]
        for chunk in chunks:
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode("utf-8"))
        self.wfile.write(b"data: [DONE]\n\n")


class SessionModelTests(unittest.TestCase):
    def test_session_model_is_passed_and_updated(self):
        agent, tmp = _agent([{"content": "ok"}, {"content": "ok"}], auto_continue=0)
        try:
            session = agent.new_session(model="model-a")
            self.assertEqual(session["model"], "model-a")
            first = agent.chat("hi", session_id=session["id"], autonomous=False)
            self.assertEqual(first["model"], "model-a")
            self.assertEqual(agent.llm.models, ["model-a"])
            second = agent.chat("again", session_id=session["id"], model="model-b",
                                autonomous=False)
            self.assertEqual(second["model"], "model-b")
            self.assertEqual(agent.llm.models[-1], "model-b")
            self.assertEqual(agent.get_session(session["id"])["model"], "model-b")
        finally:
            tmp.cleanup()


class ImageContextTests(unittest.TestCase):
    TINY_PNG = ("data:image/png;base64,"
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")

    def test_images_and_referenced_rules_reach_llm(self):
        agent, tmp = _agent([{"content": "ok"}], auto_continue=0)
        try:
            result = agent.chat(
                "这个规则抓不到，帮我看下",
                context={"rules": [{"id": "rule-1", "name": "示例站", "site": "example.com"}]},
                images=[self.TINY_PNG],
                autonomous=False,
            )
            messages = agent.llm.calls[-1]
            content = messages[-1]["content"]
            self.assertIsInstance(content, list)
            self.assertEqual(content[0]["type"], "text")
            self.assertIn("引用规则 ID: rule-1", content[0]["text"])
            self.assertEqual(content[1]["type"], "image_url")
            self.assertEqual(content[1]["image_url"]["url"], self.TINY_PNG)
            session = agent.get_session(result["sessionId"])
            self.assertIn("这个规则抓不到", session["messages"][-2]["content"])
        finally:
            tmp.cleanup()

    def test_invalid_image_is_rejected(self):
        from engine.errors import RuleError
        agent, tmp = _agent([{"content": "ok"}], auto_continue=0)
        try:
            with self.assertRaises(RuleError):
                agent.chat("看图", images=["http://example.com/a.png"], autonomous=False)
        finally:
            tmp.cleanup()


class StreamingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _SSEHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_stream_parses_reasoning_content_and_tool_calls(self):
        client = LLMClient({
            "llm": {
                "base_url": "http://127.0.0.1:%d/v1" % self.port,
                "api_key": "test-key",
                "model": "test",
            },
        })
        deltas = []
        reply = client.chat_stream(
            [{"role": "user", "content": "hi"}],
            on_delta=lambda kind, text: deltas.append((kind, text)),
        )
        self.assertEqual(reply["reasoning"], "想一想")
        self.assertEqual(reply["content"], "你好")
        self.assertEqual(reply["toolCalls"][0]["name"], "fetch_page")
        self.assertEqual(reply["toolCalls"][0]["arguments"], {"url": "https://example.com"})
        self.assertIn(("reasoning", "想"), deltas)
        self.assertIn(("content", "你好"), deltas)
        self.assertEqual(_SSEHandler.last_payload.get("model"), "test")
        client.chat_stream([{"role": "user", "content": "hi"}], model="test-override")
        self.assertEqual(_SSEHandler.last_payload.get("model"), "test-override")


if __name__ == "__main__":
    unittest.main()


class SessionPersistenceTests(unittest.TestCase):
    def test_user_message_is_saved_before_model_reply(self):
        """模型还没回复（或直接失败）时，会话里也必须先有用户消息。

        生成规则的会话是后台线程跑的，GUI 在完成前打开会话时如果 messages 为空，
        看起来就是“会话内容显示不出来”。
        """

        class FailingLLM:
            def chat_stream(self, *args, **kwargs):
                raise LLMError("模型暂时不可用")

        tmp = tempfile.TemporaryDirectory()
        try:
            agent = RuleAgent(
                FailingLLM(),
                FakeRegistry(),
                None,
                None,
                {"llm": {}, "generation": {},
                 "agent": {"max_steps": 2, "auto_continue": 1}},
                data_dir=str(Path(tmp.name)),
            )
            result = agent.chat("帮我生成 example.com 的规则")
            session = agent.get_session(result["sessionId"])
        finally:
            tmp.cleanup()
        self.assertFalse(result.get("success"))
        self.assertEqual(session["messages"][0]["role"], "user")
        self.assertEqual(session["messages"][0]["content"], "帮我生成 example.com 的规则")
        self.assertEqual(session["title"], "帮我生成 example.com 的规则"[:24])
