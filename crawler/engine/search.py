"""Search execution: resolve a site rule, fetch or run the script, extract results."""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

from .challenge import detect_challenge
from .errors import ChallengeError, EngineError, FetchError, RuleError, SearchError
from .fetch import Fetcher
from .rules import (
    FIELD_NAMES,
    build_request,
    extract_items,
    public_rule_view,
    validate_rule,
)
from .store import RuleStore, rule_visible_to

logger = logging.getLogger(__name__)


class SearchService:
    def __init__(
        self,
        store: RuleStore,
        fetcher: Fetcher,
        js=None,
        accounts=None,
        repair_config=None,
        search_log=None,
        challenge_store=None,
    ):
        self.store = store
        self.fetcher = fetcher
        self.js = js
        self.accounts = accounts
        # 限量搜索日志：给 Agent 诊断空结果/验证码/选择器漂移用。
        self.search_log = search_log
        # 人机验证会话：搜索命中验证页时创建，用户在网页里解决后带 Cookie 重试。
        self.challenge_store = challenge_store
        # 规则自动修复：搜索失败时回调 agent.repair，修好后用原关键词重试一次。
        self._repairer = None
        self._repair_config = repair_config or {}
        self._repair_lock = threading.Lock()
        self._repair_marks = {}
        self._repair_local = threading.local()

    def set_repairer(self, repairer) -> None:
        self._repairer = repairer

    def _repair_enabled(self) -> bool:
        if self._repairer is None:
            return False
        return bool(self._repair_config.get("enabled", True))

    def _may_repair(self, rule_id: str) -> bool:
        """同一规则在冷却期内只尝试修复一次，避免每次搜索都打模型。"""
        try:
            cooldown = float(self._repair_config.get("cooldown_sec") or 0)
        except (TypeError, ValueError):
            cooldown = 600.0
        with self._repair_lock:
            now = time.time()
            last = self._repair_marks.get(rule_id) or 0
            if cooldown > 0 and now - last < cooldown:
                return False
            self._repair_marks[rule_id] = now
        return True

    def _record(
        self,
        rule: dict,
        keyword: str,
        room_id: Optional[str],
        role: str,
        started: float,
        page: Optional[dict],
        items: list,
        skipped: int,
        error: str = "",
        repair=None,
        source: str = "search",
    ) -> None:
        if self.search_log is None:
            return
        try:
            record = type(self.search_log).build_record(
                rule,
                keyword,
                room_id,
                role,
                page,
                items,
                skipped,
                error,
                int((time.time() - started) * 1000),
                source=source,
                repair=repair,
            )
            self.search_log.append(record)
        except Exception as exc:  # noqa: BLE001 - 日志失败不能影响搜索
            logger.warning("写搜索日志失败: %s", exc)

    def _run_repair(self, rule: dict, keyword: str, error: str):
        if getattr(self._repair_local, "active", False):
            return None
        self._repair_local.active = True
        try:
            return self._repairer.repair(rule=rule, keyword=keyword, error=error)
        except Exception as exc:  # noqa: BLE001 - 修复失败不能影响原搜索错误
            logger.warning("规则自动修复异常: %s", exc)
            return {"success": False, "error": str(exc)}
        finally:
            self._repair_local.active = False

    def list_sites(self, room_id: Optional[str] = None, role: str = "guest") -> list:
        sites = []
        for rule in self.store.list(include_disabled=False):
            if not rule_visible_to(rule, room_id=room_id, role=role):
                continue
            sites.append(public_rule_view(rule, include_parse=False))
        return sites

    def resolve_rule(self, site: str) -> dict:
        site = (site or "").strip()
        if not site:
            raise SearchError("site_required", "缺少站点参数")
        rule = None
        if "/" not in site and " " not in site:
            try:
                rule = self.store.get(site)
            except EngineError:
                rule = None
        if rule is None:
            rule = self.store.find_by_site(site)
        if rule is None:
            for candidate in self.store.list(include_disabled=True):
                if (candidate.get("name") or "") == site:
                    rule = candidate
                    break
        if rule is None:
            raise SearchError(
                "site_not_found",
                "未找到站点规则: %s" % site,
                {"sites": [item.get("id") for item in self.list_sites()]},
            )
        return rule

    # ---------------------------------------------------------------- helpers
    def _account(self, rule: dict) -> dict:
        account_id = (rule.get("search") or {}).get("account_id") or ""
        if not account_id:
            return {}
        if self.accounts is None:
            raise RuleError("引擎未配置账号存储，无法使用账号: %s" % account_id)
        return self.accounts.resolve(account_id)

    @staticmethod
    def _with_account(headers: dict, account: dict) -> dict:
        merged = dict(headers or {})
        if not account:
            return merged
        for key, value in (account.get("headers") or {}).items():
            merged.setdefault(key, value)
        if account.get("cookies") and not any(key.lower() == "cookie" for key in merged):
            merged["Cookie"] = account["cookies"]
        return merged

    def _run_script(self, script: dict, payload: dict, label: str) -> dict:
        if self.js is None:
            raise RuleError("引擎未配置 JS 运行时，无法执行脚本规则")
        if (script.get("runtime") or "node") != "node":
            raise RuleError("%s 脚本只支持 node 运行时" % label)
        outcome = self.js.run(script.get("source") or "", payload, timeout_sec=script.get("timeout_sec"))
        if not isinstance(outcome, dict):
            raise RuleError("%s 脚本输出格式不正确" % label)
        if not outcome.get("ok"):
            raise RuleError("%s 脚本执行失败: %s" % (label, outcome.get("error") or "未知错误"))
        result = outcome.get("result")
        if not isinstance(result, dict):
            raise RuleError("%s 脚本必须返回对象" % label)
        if outcome.get("logs"):
            result.setdefault("logs", outcome.get("logs"))
        return result

    def _fetch_or_challenge_page(self, rule: dict, keyword: str, account: dict,
                                 extra_headers: Optional[dict] = None) -> dict:
        """4xx/5xx 的验证页不应直接当网络错误，先交给 challenge 检测。"""
        try:
            return self._fetch(rule, keyword, account, extra_headers=extra_headers)
        except FetchError as exc:
            challenge_rule = rule.get("challenge") or {}
            statuses = challenge_rule.get("statuses") or []
            snippet = (exc.details or {}).get("snippet") or ""
            if (
                challenge_rule.get("enabled")
                and exc.status
                and int(exc.status) in statuses
                and snippet
            ):
                return {
                    "text": snippet,
                    "pageUrl": exc.url,
                    "status": exc.status,
                    "request": {},
                    "logs": [],
                }
            raise

    def _fetch(self, rule: dict, keyword: str, account: dict,
               extra_headers: Optional[dict] = None) -> dict:
        search = rule.get("search") or {}
        mode = search.get("mode") or "http"
        if mode == "script":
            result = self._run_script(
                search.get("script") or {},
                {
                    "keyword": keyword,
                    "site": rule.get("site"),
                    "rule": rule,
                    "account": account,
                },
                "搜索",
            )
            if isinstance(result.get("items"), list):
                return {
                    "items": result.get("items"),
                    "pageUrl": result.get("pageUrl") or "",
                    "status": result.get("status"),
                    "request": result.get("request") or {},
                    "skipFetch": True,
                    "logs": result.get("logs") or [],
                }
            request = result.get("request")
            if not isinstance(request, dict) or not request.get("url"):
                raise RuleError("搜索脚本必须返回 items 或 {request:{url,...}}")
            url = str(request.get("url"))
            method = str(request.get("method") or "GET").upper()
            headers = self._with_account(request.get("headers") or {}, account)
            if extra_headers:
                headers.update(extra_headers)
            body = request.get("body")
            if isinstance(body, (dict, list)):
                body = __import__("json").dumps(body, ensure_ascii=False)
            response = self.fetcher.fetch(url, method=method, headers=headers, body=body)
            return {
                "text": response.text,
                "pageUrl": response.url,
                "status": response.status,
                "request": {"method": method, "url": url},
                "logs": result.get("logs") or [],
            }
        request = build_request(rule, keyword)
        headers = self._with_account(request["headers"], account)
        if extra_headers:
            headers.update(extra_headers)
        response = self.fetcher.fetch(
            request["url"],
            method=request["method"],
            headers=headers,
            body=request["body"],
        )
        return {
            "text": response.text,
            "pageUrl": response.url,
            "status": response.status,
            "request": {"method": request["method"], "url": request["url"]},
            "logs": [],
        }

    def _extract(self, rule: dict, page: dict, keyword: str, account: dict):
        if page.get("skipFetch"):
            raw_items = page.get("items") or []
            cleaned, skipped = self._clean_items(raw_items, rule)
            return cleaned, skipped
        parse = rule.get("parse") or {}
        if parse.get("type") == "script":
            result = self._run_script(
                parse.get("script") or {},
                {
                    "html": page.get("text") or "",
                    "url": page.get("pageUrl") or "",
                    "keyword": keyword,
                    "rule": rule,
                    "account": account,
                },
                "解析",
            )
            raw_items = result.get("items")
            if not isinstance(raw_items, list):
                raise RuleError("解析脚本必须返回 {items:[...]}")
            cleaned, script_skipped = self._clean_items(raw_items, rule)
            return cleaned, max(int(result.get("skipped") or 0), script_skipped)
        return extract_items(rule, page.get("text") or "", page.get("pageUrl") or "")

    @staticmethod
    def _clean_items(raw_items, rule: dict):
        parse = rule.get("parse") or {}
        limit = int(parse.get("limit") or 30)
        dedupe_by = parse.get("dedupe_by") or "url"
        cleaned = []
        skipped = 0
        seen = set()
        for raw in raw_items or []:
            if not isinstance(raw, dict):
                skipped += 1
                continue
            item = {}
            for name in FIELD_NAMES:
                value = raw.get(name)
                item[name] = "" if value is None else str(value)
            extra = raw.get("extra")
            if isinstance(extra, dict):
                item["extra"] = extra
            if not item.get("title") or not item.get("url"):
                skipped += 1
                continue
            key = item.get(dedupe_by) or ""
            if key and key in seen:
                continue
            if key:
                seen.add(key)
            cleaned.append(item)
            if len(cleaned) >= limit:
                break
        return cleaned, skipped

    # ----------------------------------------------------------------- public
    def search(
        self,
        site: str,
        keyword: str,
        room_id: Optional[str] = None,
        role: str = "guest",
        limit: Optional[int] = None,
        extra_headers: Optional[dict] = None,
        create_challenge: bool = True,
    ) -> dict:
        keyword = (keyword or "").strip()
        if not keyword:
            raise SearchError("keyword_required", "搜索关键词不能为空")
        rule = self.resolve_rule(site)
        if not rule_visible_to(rule, room_id=room_id, role=role):
            raise SearchError(
                "site_forbidden",
                "当前房间没有使用该站点规则的权限: %s" % rule.get("name"),
                {"ruleId": rule.get("id")},
            )
        started = time.time()
        repair_info = None
        attempt = 0
        last_error = None
        items, skipped, page = [], 0, {}
        while True:
            attempt += 1
            try:
                account = self._account(rule)
                page = self._fetch_or_challenge_page(rule, keyword, account, extra_headers=extra_headers)
                challenge = detect_challenge(rule, page, self.js)
                if challenge:
                    if self.challenge_store is not None and create_challenge:
                        session = self.challenge_store.create(
                            rule, keyword, room_id, role, page, challenge)
                        challenge["challengeId"] = session["id"]
                        challenge["proxyUrl"] = self.challenge_store.proxy_base(session)
                        challenge["expiresAt"] = session["expiresAt"]
                    raise ChallengeError(challenge)
                items, skipped = self._extract(rule, page, keyword, account)
                last_error = None
                failure = "" if items else "empty result"
            except EngineError as exc:
                last_error = exc
                items, skipped = [], 0
                failure = exc.message
            except Exception as exc:  # noqa: BLE001
                last_error = SearchError(
                    "search_failed",
                    "搜索失败: %s" % exc,
                    {"ruleId": rule.get("id")},
                )
                items, skipped = [], 0
                failure = last_error.message
            # 解析失败（异常或 0 结果）时，首次尝试交给大模型修复并重试一次。
            if (
                attempt == 1
                and failure
                and self._repair_enabled()
                and self._may_repair(rule["id"])
            ):
                outcome = self._run_repair(rule, keyword, failure)
                if outcome is not None:
                    repair_info = {
                        "attempted": True,
                        "success": bool(outcome.get("success")),
                        "ruleId": outcome.get("ruleId") or "",
                        "error": outcome.get("error") or "",
                        "steps": outcome.get("steps"),
                        "tookMs": outcome.get("tookMs"),
                    }
                    if repair_info["success"]:
                        self._repair_marks.pop(rule["id"], None)
                        try:
                            rule = self.store.get(rule["id"])
                            continue
                        except EngineError as exc:
                            last_error = exc
            break
        if last_error is not None:
            self.store.record_search(rule["id"], False, last_error.message)
            self._record(rule, keyword, room_id, role, started, page, [], 0, last_error.message, repair_info)
            raise last_error
        if limit:
            items = items[: max(1, int(limit))]
        warnings = []
        if skipped:
            warnings.append("%d 条结果缺少标题或链接，已跳过" % skipped)
        if repair_info is not None:
            if repair_info["success"]:
                warnings.append("原规则解析失败，已自动让大模型修复")
            else:
                warnings.append("原规则解析失败，自动修复未成功")
        if not items:
            warnings.append("规则执行成功，但未解析到结果，可能需要更新规则")
        self.store.record_search(rule["id"], bool(items), None if items else "empty result")
        self._record(
            rule,
            keyword,
            room_id,
            role,
            started,
            page,
            items,
            skipped,
            "" if items else "empty result",
            repair_info,
        )
        result = {
            "success": True,
            "site": {
                "id": rule.get("id"),
                "name": rule.get("name"),
                "site": rule.get("site"),
            },
            "ruleId": rule.get("id"),
            "mode": (rule.get("search") or {}).get("mode") or "http",
            "keyword": keyword,
            "count": len(items),
            "items": items,
            "warnings": warnings,
            "pageUrl": page.get("pageUrl") or "",
            "tookMs": int((time.time() - started) * 1000),
        }
        if repair_info is not None:
            result["repair"] = repair_info
            result["repaired"] = repair_info["success"]
        return result

    def test_rule(self, raw_rule: dict, keyword: str, limit: Optional[int] = None) -> dict:
        """Validate and run an unsaved rule; used by the agent and MCP tools."""
        started = time.time()
        page = None
        rule = raw_rule if isinstance(raw_rule, dict) else {}
        try:
            rule = validate_rule(raw_rule)
            account = self._account(rule)
            page = self._fetch_or_challenge_page(rule, keyword, account, extra_headers=None)
            challenge = detect_challenge(rule, page, self.js)
            if challenge:
                if self.challenge_store is not None:
                    session = self.challenge_store.create(rule, keyword, None, "root", page, challenge)
                    challenge["challengeId"] = session["id"]
                    challenge["proxyUrl"] = self.challenge_store.proxy_base(session)
                raise ChallengeError(challenge)
            items, skipped = self._extract(rule, page, keyword, account)
            if limit:
                items = items[: max(1, int(limit))]
            self._record(rule, keyword, None, "root", started, page, items, skipped, source="test")
            return {
                "ok": bool(items),
                "count": len(items),
                "items": items[:10],
                "skipped": skipped,
                "mode": (rule.get("search") or {}).get("mode") or "http",
                "pageUrl": page.get("pageUrl") or "",
                "status": page.get("status"),
                "request": page.get("request") or {},
                "logs": (page.get("logs") or [])[:50],
                "tookMs": int((time.time() - started) * 1000),
                "rule": rule,
            }
        except EngineError as exc:
            self._record(rule, keyword, None, "root", started, page, [], 0, exc.message, source="test")
            return {
                "ok": False,
                "count": 0,
                "items": [],
                "error": exc.message,
                "code": exc.code,
                "details": exc.details,
                "tookMs": int((time.time() - started) * 1000),
            }
        except Exception as exc:  # noqa: BLE001
            self._record(rule, keyword, None, "root", started, page, [], 0, "规则测试失败: %s" % exc, source="test")
            return {
                "ok": False,
                "count": 0,
                "items": [],
                "error": "规则测试失败: %s" % exc,
                "code": "test_failed",
                "tookMs": int((time.time() - started) * 1000),
            }