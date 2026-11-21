"""Agent run manager: executes a chat turn in the background and exposes events.

The GUI polls a run with a cursor to render the live thinking/tool timeline.
A single run has no fixed turn limit beyond the agent's own max_steps; it ends
when the model calls task_complete, the user cancels, or an error occurs.
"""
from __future__ import annotations

import threading
import time
import traceback
from typing import Optional

from .agent import RuleAgent


MAX_EVENTS_PER_RUN = 6000
MAX_RUNS = 60


class AgentRun:
    def __init__(self, run_id: str, session_id: str):
        self.id = run_id
        self.session_id = session_id
        self.status = "running"
        self.error = ""
        self.reply = ""
        self.steps = 0
        self.created_at = time.time()
        self.updated_at = self.created_at
        self.cancel_event = threading.Event()
        self.lock = threading.Lock()
        self.events: list = []
        self.next_seq = 1
        self.thread: Optional[threading.Thread] = None

    def emit(self, event: dict) -> None:
        with self.lock:
            item = dict(event or {})
            item["seq"] = self.next_seq
            item["at"] = int(time.time() * 1000)
            self.next_seq += 1
            if len(self.events) < MAX_EVENTS_PER_RUN:
                self.events.append(item)
            self.updated_at = time.time()

    def cancelled(self) -> bool:
        return self.cancel_event.is_set()

    def snapshot(self, cursor: int = 0) -> dict:
        with self.lock:
            events = [dict(item) for item in self.events if item.get("seq", 0) > cursor]
            next_cursor = events[-1]["seq"] if events else cursor
            return {
                "id": self.id,
                "sessionId": self.session_id,
                "status": self.status,
                "error": self.error,
                "reply": self.reply,
                "steps": self.steps,
                "events": events,
                "nextCursor": next_cursor,
                "done": self.status in ("done", "error", "cancelled"),
                "cancelRequested": self.cancel_event.is_set(),
                "tookMs": int((time.time() - self.created_at) * 1000),
            }


class AgentRunManager:
    def __init__(self, agent: RuleAgent):
        self.agent = agent
        self.lock = threading.Lock()
        self.runs: dict = {}

    def start(self, message: str, session_id: str = "", context: Optional[dict] = None,
              reasoning_effort: Optional[str] = None, model: Optional[str] = None,
              images=None, on_finish=None) -> dict:
        message = (message or "").strip()
        if not message and images:
            message = "请查看图片。"
        if not message:
            raise ValueError("消息不能为空")
        if not session_id:
            session = self.agent.new_session(
                title=message[:24],
                reasoning_effort=reasoning_effort,
                model=model,
            )
            session_id = session["id"]
        run_id = "run-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(int(time.time() * 1000) % 1000)
        run = AgentRun(run_id, session_id)
        with self.lock:
            self._prune_locked()
            self.runs[run_id] = run

        def worker() -> None:
            try:
                result = self.agent.chat(
                    message,
                    session_id=session_id,
                    context=context or {},
                    reasoning_effort=reasoning_effort,
                    model=model,
                    images=images,
                    emit=run.emit,
                    cancel=run.cancelled,
                    autonomous=True,
                )
                run.reply = str(result.get("reply") or "")
                run.steps = int(result.get("steps") or 0)
                if result.get("cancelled"):
                    run.status = "cancelled"
                    run.error = "已停止生成"
                elif result.get("success"):
                    run.status = "done"
                else:
                    run.status = "error"
                    run.error = str(result.get("error") or "执行失败")
            except Exception as exc:  # noqa: BLE001 - 后台线程必须保住进程
                run.status = "error"
                run.error = str(exc)[:1000]
                run.emit({"kind": "error", "error": run.error,
                          "trace": traceback.format_exc()[-4000:]})
            finally:
                run.updated_at = time.time()
                if run.status == "running":
                    run.status = "done"
                # 可选收尾回调：成员提交的「生成规则」把一次普通 run 跑完后，
                # 由 Engine 负责把提交记录标成 done/failed，逻辑与自动生成保持一致。
                if on_finish is not None:
                    try:
                        on_finish(run)
                    except Exception:  # noqa: BLE001 - 收尾失败不能影响 run 状态
                        traceback.print_exc()

        thread = threading.Thread(target=worker, name="crawler-agent-" + run_id, daemon=True)
        run.thread = thread
        thread.start()
        return {"success": True, "runId": run_id, "sessionId": session_id,
                "run": run.snapshot(0)}

    def get(self, run_id: str, cursor: int = 0) -> Optional[dict]:
        with self.lock:
            run = self.runs.get(run_id)
        if run is None:
            return None
        return run.snapshot(cursor)

    def cancel(self, run_id: str) -> Optional[dict]:
        with self.lock:
            run = self.runs.get(run_id)
        if run is None:
            return None
        run.cancel_event.set()
        return run.snapshot(0)

    def active_count(self) -> int:
        with self.lock:
            return len([run for run in self.runs.values() if run.status == "running"])

    def _prune_locked(self) -> None:
        now = time.time()
        stale = [
            run_id for run_id, run in self.runs.items()
            if run.status != "running" and now - run.updated_at > 2 * 3600
        ]
        for run_id in stale:
            self.runs.pop(run_id, None)
        if len(self.runs) > MAX_RUNS:
            ordered = sorted(self.runs.items(), key=lambda pair: pair[1].created_at)
            for run_id, _run in ordered[: len(self.runs) - MAX_RUNS]:
                self.runs.pop(run_id, None)
