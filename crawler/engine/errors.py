"""Structured errors shared by the engine, HTTP API and MCP server."""
from __future__ import annotations


class EngineError(Exception):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}

    def to_dict(self) -> dict:
        data = {"success": False, "code": self.code, "error": self.message}
        if self.details:
            data["details"] = self.details
        return data


class ConfigError(EngineError):
    def __init__(self, message: str, details=None):
        super().__init__("config_error", message, details)


class FetchError(EngineError):
    def __init__(self, message: str, status: int = 0, url: str = "", details=None):
        payload = {"status": status, "url": url}
        if details:
            payload.update(details)
        super().__init__("fetch_error", message, payload)
        self.status = status
        self.url = url


class RuleError(EngineError):
    def __init__(self, message: str, details=None):
        super().__init__("rule_error", message, details)


class RuleNotFound(EngineError):
    def __init__(self, rule_id: str):
        super().__init__("rule_not_found", "规则不存在: %s" % rule_id, {"ruleId": rule_id})


class SearchError(EngineError):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(code, message, details)


class ChallengeError(EngineError):
    """The site returned a human-verification page instead of results."""

    def __init__(self, details: dict):
        details = dict(details or {})
        name = details.get("name") or details.get("site") or "站点"
        details.setdefault("reason", "unknown")
        super().__init__(
            "challenge_required",
            "%s 需要人工验证后才能搜索（%s）" % (name, details.get("reason")),
            details,
        )


class LLMError(EngineError):
    def __init__(self, message: str, details=None):
        super().__init__("llm_error", message, details)