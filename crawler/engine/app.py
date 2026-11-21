"""Engine assembly: config + store + fetcher + search + LLM + tools."""
from __future__ import annotations

import threading
from typing import Optional
from urllib.parse import urlsplit

from .accounts import AccountStore
from .agent import RuleAgent
from .agent_run import AgentRunManager
from .browser import BrowserController
from .challenge_proxy import ChallengeSessionStore
from .config import Paths, load_config
from .errors import LLMError, RuleError
from .fetch import Fetcher
from .llm import LLMClient
from .play import PlayResolver
from .scripts import JsRuntime
from .search import SearchService
from .searchlog import SearchLogStore
from .store import RuleStore
from .submissions import SubmissionStore, public_submission
from .tools import ToolRegistry, build_registry


class Engine:
    def __init__(self, root: Optional[str] = None):
        self.paths = Paths.detect(root)
        self.config = load_config(self.paths)
        self.store = RuleStore(self.paths.rules_dir)
        self.accounts = AccountStore(self.paths.data_dir / "accounts.json")
        self.submissions = SubmissionStore(self.paths.data_dir / "submissions.json")
        self.search_log = SearchLogStore(self.paths.data_dir / "search-logs.json")
        self.challenges = ChallengeSessionStore(
            ttl_sec=int((self.config.get("challenge") or {}).get("ttl_sec") or 1800),
            max_sessions=int((self.config.get("challenge") or {}).get("max_sessions") or 200),
        )
        self.browser = None
        # 规则生成队列：同一时间只跑一个（自动添加与手动点击共用），其余排队等前一个结束。
        self._generation_lock = threading.Lock()
        self._generation_queue: list = []
        self._generation_current: Optional[dict] = None
        self.reload()

    def reload(self) -> None:
        self.config = load_config(self.paths)
        engine_cfg = self.config.get("engine") or {}
        self.fetcher = Fetcher(
            timeout=float(engine_cfg.get("request_timeout_sec") or 25),
            max_bytes=int(engine_cfg.get("max_bytes") or 3145728),
            user_agent=engine_cfg.get("user_agent") or "",
        )
        self.js = JsRuntime(
            node_bin=engine_cfg.get("node_bin") or "",
            timeout_sec=float(engine_cfg.get("script_timeout_sec") or 20),
        )
        self.search = SearchService(
            self.store,
            self.fetcher,
            js=self.js,
            accounts=self.accounts,
            repair_config=self.config.get("repair") or {},
            search_log=self.search_log,
            challenge_store=self.challenges,
        )
        browser_cfg = self.config.get("browser") or {}
        if self.browser is None:
            self.browser = BrowserController(browser_cfg, str(self.paths.data_dir))
        else:
            self.browser.config = browser_cfg
        # 播放解析器（一起看播放入口 + Agent 的 test_play 工具共用）。
        self.play = PlayResolver(self.store, self.fetcher, browser=self.browser, js=self.js,
                                 accounts=self.accounts)
        self.llm = LLMClient(self.config)
        generation = self.config.get("generation") or {}
        self.registry = build_registry(
            self.store,
            self.search,
            self.fetcher,
            max_page_chars=int(generation.get("max_page_chars") or 6000),
            accounts=self.accounts,
            browser=self.browser,
            search_log=self.search_log,
            play=self.play,
        )
        self.agent = RuleAgent(
            self.llm,
            self.registry,
            self.store,
            self.search,
            self.config,
            data_dir=self.paths.data_dir,
        )
        # 搜索失败时由 SearchService 回调 agent.repair 自动修复规则。
        self.search.set_repairer(self.agent)
        self.admin_registry = build_registry(
            self.store,
            self.search,
            self.fetcher,
            max_page_chars=int(generation.get("max_page_chars") or 6000),
            agent=self.agent,
            include_generate=True,
            accounts=self.accounts,
            browser=self.browser,
            search_log=self.search_log,
            play=self.play,
        )
        # 运行中的 Agent 任务由 manager 持有；重新加载配置时复用 manager，
        # 只把新的 agent 换进去，避免正在跑的任务丢失事件。
        if getattr(self, "agent_runs", None) is None:
            self.agent_runs = AgentRunManager(self.agent)
        else:
            self.agent_runs.agent = self.agent

    def llm_configured(self) -> bool:
        return bool((self.config.get("llm") or {}).get("api_key"))

    # -------------------------------------------------------------- browser
    def browser_status(self) -> dict:
        if self.browser is None:
            return {"available": False, "running": False, "reason": "未初始化"}
        return self.browser.status()

    def shutdown(self) -> None:
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:  # noqa: BLE001 - 关停时忽略
                pass

    # ------------------------------------------------------------ submissions
    def submit_site(self, payload: dict) -> dict:
        submission = self.submissions.add(payload)
        auto = bool((self.config.get("submissions") or {}).get("auto_generate"))
        queued = False
        if not submission.get("duplicate") and auto and self.llm_configured():
            session = self.agent.new_session(title=("生成规则：" + str(submission.get("name") or submission.get("site") or ""))[:32])
            self.submissions.update(submission["id"], {"sessionId": session["id"]})
            submission = self.submissions.get(submission["id"]) or submission
            queued = self.queue_generation(submission["id"], session["id"])
            submission = self.submissions.get(submission["id"]) or submission
        view = public_submission(submission)
        if view.get("status") == "queued":
            position = self.queue_positions().get(str(view.get("id") or ""))
            if position:
                view["queuePosition"] = position
        return {
            "success": True,
            "submission": view,
            "duplicate": bool(submission.get("duplicate")),
            "autoEnabled": auto,
            "autoQueued": queued,
            "llmConfigured": self.llm_configured(),
        }

    def queue_generation(self, submission_id: str, session_id: str = "",
                         reasoning_effort: Optional[str] = None,
                         model: Optional[str] = None) -> bool:
        """把一条「生成规则」加入队列（自动添加也走这里），空闲时立即启动。"""
        if not self.llm_configured():
            raise RuleError("还没有配置大模型 API Key，无法生成规则")
        submission = self.submissions.get(submission_id)
        if submission is None:
            raise RuleError("提交记录不存在: %s" % submission_id)
        if not str(submission.get("url") or "").strip():
            raise RuleError("提交记录缺少站点 URL")
        target_session = self._ensure_submission_session(
            submission, session_id, reasoning_effort, model)
        result = self._enqueue_generation(
            submission_id, target_session, reasoning_effort, model)
        return bool(result.get("runId") or result.get("queued"))

    def queue_positions(self) -> dict:
        """排队中的提交 -> 1 起的队列序号（正在跑的不算在队列里）。"""
        with self._generation_lock:
            return {item.get("submissionId"): index + 1
                    for index, item in enumerate(self._generation_queue)}

    def cancel_queued_generation(self, submission_id: str) -> bool:
        """删除提交记录时把还在排队的任务一并挪出队列。"""
        with self._generation_lock:
            for index, item in enumerate(self._generation_queue):
                if item.get("submissionId") == submission_id:
                    del self._generation_queue[index]
                    return True
        return False

    def _ensure_submission_session(self, submission: dict, session_id: str = "",
                                   reasoning_effort=None, model=None) -> str:
        """取提交记录已有的会话；没有就建一个标题可读的会话，返回 sessionId。"""
        _url, name, _keyword, _message = self.submission_message(submission)
        effort = (self.agent.submission_effort if reasoning_effort is None
                  else str(reasoning_effort or "").strip())
        if not session_id:
            session_id = str(submission.get("sessionId") or "")
        title = ("生成规则：" + name)[:32]
        if not session_id:
            return self.agent.new_session(
                title=title, reasoning_effort=effort, model=model)["id"]
        try:
            session = self.agent._load_session(session_id)
        except RuleError:
            session = None
        if session is None:
            return self.agent.new_session(
                title=title, reasoning_effort=effort, model=model)["id"]
        if session.get("title") in (None, "", "新对话"):
            session["title"] = title
            self.agent._save_session(session)
        return session_id

    def _enqueue_generation(self, submission_id: str, session_id: str,
                            reasoning_effort=None, model=None) -> dict:
        entry = {
            "submissionId": submission_id,
            "sessionId": session_id,
            "reasoningEffort": reasoning_effort,
            "model": model,
        }
        with self._generation_lock:
            current = self._generation_current
            if current is not None and current.get("submissionId") == submission_id:
                return {"success": True, "submissionId": submission_id,
                        "sessionId": session_id, "queued": True, "running": True,
                        "position": 0}
            for index, item in enumerate(self._generation_queue):
                if item.get("submissionId") == submission_id:
                    return {"success": True, "submissionId": submission_id,
                            "sessionId": item.get("sessionId") or session_id,
                            "queued": True, "position": index + 1}
            self._generation_queue.append(entry)
        self.submissions.update(submission_id, {
            "status": "queued", "error": "", "sessionId": session_id})
        started = self._pump_generation_queue()
        if started and started.get("submissionId") == submission_id and started.get("runId"):
            return started
        with self._generation_lock:
            position = 0
            for index, item in enumerate(self._generation_queue):
                if item.get("submissionId") == submission_id:
                    position = index + 1
                    break
        return {"success": True, "submissionId": submission_id,
                "sessionId": session_id, "queued": True, "position": position}

    def _pump_generation_queue(self):
        """空闲时取出队首启动；同一时间只跑一个生成任务。"""
        with self._generation_lock:
            if self._generation_current is not None:
                return None
            if not self._generation_queue:
                return None
            entry = self._generation_queue.pop(0)
            self._generation_current = entry
        submission_id = str(entry.get("submissionId") or "")
        try:
            started = self._start_generation(entry)
        except Exception as exc:  # noqa: BLE001 - 启动失败也不能把队列卡住
            try:
                self.submissions.update(submission_id, {
                    "status": "failed", "error": str(exc)[:500]})
            except Exception:  # noqa: BLE001
                pass
            self._generation_finished(submission_id)
            return {"success": False, "submissionId": submission_id, "error": str(exc)}
        if not started.get("runId"):
            self._generation_finished(submission_id)
        return started

    def _start_generation(self, entry: dict) -> dict:
        submission_id = str(entry.get("submissionId") or "")
        submission = self.submissions.get(submission_id)
        if submission is None:
            raise RuleError("提交记录不存在: %s" % submission_id)
        url, name, keyword, message = self.submission_message(submission)
        if not url:
            raise RuleError("提交记录缺少站点 URL")
        effort_arg = entry.get("reasoningEffort")
        session_id = self._ensure_submission_session(
            submission, str(entry.get("sessionId") or ""), effort_arg, entry.get("model"))
        entry["sessionId"] = session_id
        effort = (self.agent.submission_effort if effort_arg is None
                  else str(effort_arg or "").strip())
        self.submissions.update(submission_id, {
            "status": "processing", "error": "", "sessionId": session_id})

        def on_finish(run) -> None:
            self._finalize_submission_run(submission_id, run)

        started = self.agent_runs.start(
            message,
            session_id=session_id,
            context={"submissionId": submission_id},
            reasoning_effort=effort,
            model=entry.get("model"),
            on_finish=on_finish,
        )
        if not started.get("runId"):
            self.submissions.update(submission_id, {
                "status": "failed",
                "error": str(started.get("error") or "无法启动生成任务")[:500]})
            return {"success": False, "submissionId": submission_id}
        self.submissions.update(submission_id, {"runId": started.get("runId")})
        started = dict(started)
        started.update({
            "submissionId": submission_id,
            "sessionId": session_id,
            "message": message,
            "keyword": keyword,
            "queued": False,
            "position": 0,
        })
        return started

    def _generation_finished(self, submission_id: str = "") -> None:
        with self._generation_lock:
            current = self._generation_current
            if current is None:
                return
            if submission_id and current.get("submissionId") != submission_id:
                return
            self._generation_current = None
        # 队列还有任务就立刻开始下一个，实现「等上一个完成再自动进行下一个」。
        self._pump_generation_queue()

    # ---------------------------------------------- submission -> interactive run
    def submission_message(self, submission: dict) -> tuple:
        """把一条提交记录转成给模型的消息（与自动生成共用同一段文案）。"""
        submission = submission or {}
        url = str(submission.get("url") or "").strip()
        name = str(submission.get("name") or "").strip() or url
        keyword = str(submission.get("keyword") or "").strip() or "电影"
        note = str(submission.get("note") or "").strip()
        lines = [
            "请为下面这个成员提交的站点生成一起看搜索规则，并用 test_rule 验证到有结果后保存：",
            "站点地址：%s" % url,
            "站点名称：%s" % name,
            "规则 name 请由你起一个可读的站点名（优先页面标题/品牌名，不要直接填域名）；如果上面的站点名称是域名或空，也请替换成可读名称。",
            "测试关键词：%s" % keyword,
        ]
        if note:
            lines.append("补充说明：%s" % note)
        lines.append("保存后请用一句话说明规则 id 与测试结果；不要新建与现有规则重复的站点规则。")
        return url, name, keyword, "\n".join(lines)

    def start_submission_run(self, submission_id: str, session_id: str = "",
                             reasoning_effort=None, model=None) -> dict:
        """手动「生成规则」：加入串行队列；空闲时立即启动并返回流式 run 信息。"""
        if not self.llm_configured():
            raise RuleError("还没有配置大模型 API Key，无法生成规则")
        submission = self.submissions.get(submission_id)
        if submission is None:
            raise RuleError("提交记录不存在: %s" % submission_id)
        if not str(submission.get("url") or "").strip():
            raise RuleError("提交记录缺少站点 URL")
        target_session = self._ensure_submission_session(
            submission, session_id, reasoning_effort, model)
        return self._enqueue_generation(
            submission_id, target_session, reasoning_effort, model)

    def _finalize_submission_run(self, submission_id: str, run) -> None:
        """回写 run 结果；无论成功失败都要放行队列里的下一条。"""
        try:
            self._apply_run_outcome(submission_id, run)
        finally:
            self._generation_finished(submission_id)

    def _apply_run_outcome(self, submission_id: str, run) -> None:
        submission = self.submissions.get(submission_id)
        if submission is None:
            return
        session_id = str(getattr(run, "session_id", "") or submission.get("sessionId") or "")
        status = str(getattr(run, "status", "") or "")
        if status == "cancelled":
            self.submissions.update(submission_id, {
                "status": "failed", "sessionId": session_id, "error": "已停止生成"})
            return
        if status != "done":
            error = str(getattr(run, "error", "") or "模型调用失败")[:500]
            self.submissions.update(submission_id, {
                "status": "failed", "sessionId": session_id, "error": error})
            return
        url = str(submission.get("url") or "")
        host = (urlsplit(url).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        latest = self.agent._find_rule_for_site(host)
        if latest is None:
            self.submissions.update(submission_id, {
                "status": "failed", "sessionId": session_id,
                "error": "模型已回复但没有保存该站点的规则，可在 Agent 对话里继续要求它保存"})
            return
        keyword = str(submission.get("keyword") or "").strip() or "电影"
        try:
            test = self.search.test_rule(latest, keyword, limit=10)
        except Exception as exc:  # noqa: BLE001 - 测试失败按未通过处理
            test = {"ok": False, "error": str(exc)}
        if test.get("ok"):
            self.submissions.update(submission_id, {
                "status": "done", "sessionId": session_id,
                "ruleId": latest.get("id") or "", "ruleName": latest.get("name") or "", "error": ""})
        else:
            self.submissions.update(submission_id, {
                "status": "failed", "sessionId": session_id,
                "ruleId": latest.get("id") or "", "error": str(test.get("error") or "规则已保存但测试没有结果")[:500]})

    # ------------------------------------------------------------ play resolve
    def resolve_play(self, target: str, room_id: str = "", role: str = "guest") -> dict:
        target = (target or "").strip()
        if not target:
            raise RuleError("缺少要解析的页面地址")
        return self.play.resolve(target, room_id=room_id, role=role)

    # --------------------------------------------------------------- agent run
    def start_agent_run(self, message: str, session_id: str = "", context=None,
                        reasoning_effort=None, model=None, images=None) -> dict:
        try:
            return self.agent_runs.start(
                message,
                session_id=session_id or "",
                context=context if isinstance(context, dict) else {},
                reasoning_effort=reasoning_effort,
                model=model,
                images=images,
            )
        except Exception as exc:  # noqa: BLE001 - API 统一转成错误
            return {"success": False, "code": "agent_run_failed", "error": str(exc)}

    def get_agent_run(self, run_id: str, cursor: int = 0) -> dict:
        snapshot = self.agent_runs.get(run_id, cursor)
        if snapshot is None:
            return {"success": False, "code": "run_not_found", "error": "任务不存在或已过期"}
        return {"success": True, "run": snapshot}

    def cancel_agent_run(self, run_id: str) -> dict:
        snapshot = self.agent_runs.cancel(run_id)
        if snapshot is None:
            return {"success": False, "code": "run_not_found", "error": "任务不存在或已过期"}
        return {"success": True, "run": snapshot}

    def list_models(self, api_key: str = "", base_url: str = "") -> dict:
        try:
            return self.llm.list_models(api_key=api_key or None, base_url=base_url or None)
        except LLMError as exc:
            return {"success": False, "code": exc.code, "error": exc.message}

    # ------------------------------------------------------------- challenge
    def list_challenges(self, include_completed: bool = False) -> dict:
        items = self.challenges.list(include_completed=include_completed)
        return {"success": True, "count": len(items), "challenges": items}

    def challenge_info(self, session_id: str) -> dict:
        session = self.challenges.get(session_id)
        return {
            "success": True,
            "challenge": {
                "id": session["id"],
                "site": session["site"],
                "name": session["name"],
                "keyword": session["keyword"],
                "pageUrl": session["pageUrl"],
                "proxyUrl": self.challenges.proxy_base(session),
                "reason": session["reason"],
                "note": session["note"],
                "status": session["status"],
                "createdAt": session["createdAt"],
                "expiresAt": session["expiresAt"],
                "completed": session["completed"],
            },
        }

    def verify_challenge(self, session_id: str) -> dict:
        """Re-run the search with the cookies collected while solving the page."""
        session = self.challenges.get(session_id)
        rule = self.store.get(session["ruleId"])
        cookie = "; ".join("%s=%s" % (k, v) for k, v in (session.get("cookies") or {}).items())
        if not cookie:
            raise RuleError("网站还没有写入验证 Cookie，请先在验证页完成验证")
        try:
            result = self.search.search(
                rule["id"],
                session["keyword"],
                room_id=session.get("roomId") or None,
                role=session.get("role") or "guest",
                extra_headers={"Cookie": cookie},
                create_challenge=False,
            )
        except EngineError as exc:
            if exc.code == "challenge_required":
                details = dict(exc.details or {})
                details["challengeId"] = session["id"]
                details["proxyUrl"] = self.challenges.proxy_base(session)
                self.challenges.absorb_browser_cookies(session, "")
                raise EngineError("challenge_required", "验证还没有完成，请继续完成页面上的验证", details) from exc
            raise
        self.challenges.mark_completed(session_id)
        return {"success": True, "verified": True, "challengeId": session_id, "result": result}

    def status(self) -> dict:
        rules = self.store.list(include_disabled=True)
        browser_state = self.browser_status()
        return {
            "ok": True,
            "version": "0.1.0",
            "root": str(self.paths.root),
            "rules": len(rules),
            "scriptRules": len([
                rule for rule in rules
                if (rule.get("search") or {}).get("mode") == "script"
                or (rule.get("parse") or {}).get("type") == "script"
            ]),
            "accounts": len(self.accounts.list()),
            "llmConfigured": self.llm_configured(),
            "model": (self.config.get("llm") or {}).get("model"),
            "nodeAvailable": self.js.available(),
            "nodeBin": self.js.node_bin,
            "submissions": len(self.submissions.list()),
            "searchLogCount": self.search_log.count(),
            "pendingSubmissions": len(self.submissions.list(status="pending")),
            "reasoningEffort": self.llm.reasoning_effort,
            "generationReasoningEffort": self.agent.generation_effort,
            "submissionReasoningEffort": self.agent.submission_effort,
            "autoGenerate": bool((self.config.get("submissions") or {}).get("auto_generate")),
            "repairEnabled": bool((self.config.get("repair") or {}).get("enabled", True)),
            "browser": {
                "available": browser_state.get("available"),
                "running": browser_state.get("running"),
                "mode": browser_state.get("mode"),
                "bin": browser_state.get("bin"),
                "debugPort": browser_state.get("debugPort"),
            },
        }