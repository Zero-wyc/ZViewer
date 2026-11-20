"""Detect anti-bot / human-verification pages from a saved rule.

Rules own the detection conditions so the engine never guesses: URL fragments,
HTTP status, CSS selectors, page title/keywords, or a Node script. When a rule
has no challenge block the engine keeps the old behaviour (parse whatever came
back), which also means local fixture sites are unaffected.
"""
from __future__ import annotations

import re
from html import unescape
from typing import Optional
from urllib.parse import urlsplit

from .dom import parse_html, select_all
from .errors import RuleError

_TAG_RE = re.compile(r"<[^>]+>")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def page_title(html_text: str) -> str:
    match = _TITLE_RE.search(html_text or "")
    if not match:
        return ""
    return " ".join(_TAG_RE.sub(" ", match.group(1)).split())[:200]


def page_text(html_text: str) -> str:
    # Node.text() 在文档根节点上不递归，这里直接去标签，避免漏掉正文。
    return " ".join(unescape(_TAG_RE.sub(" ", html_text or "")).split())


def detect_challenge(rule: dict, page: dict, js=None) -> Optional[dict]:
    """Return challenge details when the response looks like a verification page."""
    challenge = (rule or {}).get("challenge") or {}
    if not challenge.get("enabled"):
        return None
    url = str((page or {}).get("pageUrl") or "")
    status = (page or {}).get("status")
    html_text = str((page or {}).get("text") or "")
    title = page_title(html_text)
    text = page_text(html_text)
    lowered_url = url.lower()
    for fragment in challenge.get("url_contains") or []:
        if fragment.lower() in lowered_url:
            return _details(rule, page, "url_contains:%s" % fragment, title)
    if status in (challenge.get("statuses") or []):
        return _details(rule, page, "status:%s" % status, title)
    for selector in challenge.get("selectors") or []:
        try:
            if select_all(parse_html(html_text), selector):
                return _details(rule, page, "selector:%s" % selector, title)
        except Exception as exc:  # noqa: BLE001 - 选择器由 validate_rule 预校验
            raise RuleError("challenge.selectors 选择器无效: %s" % exc) from exc
    lowered_title = title.lower()
    for fragment in challenge.get("title_contains") or []:
        if fragment.lower() in lowered_title:
            return _details(rule, page, "title:%s" % fragment, title)
    lowered_text = text.lower()
    for keyword in challenge.get("keywords") or []:
        if keyword.lower() in lowered_text:
            return _details(rule, page, "keyword:%s" % keyword, title)
    script = challenge.get("script") or {}
    if script.get("source"):
        if js is None:
            raise RuleError("引擎未配置 JS 运行时，无法执行 challenge.script")
        outcome = js.run(
            script.get("source") or "",
            {"html": html_text, "url": url, "status": status, "title": title},
            timeout_sec=script.get("timeout_sec"),
        )
        if not isinstance(outcome, dict) or not outcome.get("ok"):
            raise RuleError("challenge 脚本执行失败: %s" % ((outcome or {}).get("error") or "未知错误"))
        result = outcome.get("result") or {}
        if isinstance(result, dict) and result.get("challenge"):
            return _details(rule, page, "script:%s" % (result.get("reason") or "matcher"), title)
    return None


def _details(rule: dict, page: dict, reason: str, title: str) -> dict:
    return {
        "reason": reason,
        "ruleId": (rule or {}).get("id") or "",
        "site": (rule or {}).get("site") or "",
        "name": (rule or {}).get("name") or "",
        "pageUrl": (page or {}).get("pageUrl") or "",
        "status": (page or {}).get("status"),
        "title": title,
        "note": ((rule or {}).get("challenge") or {}).get("note") or "",
    }


GENERIC_HINTS = (
    "验证码", "人机验证", "安全验证", "滑动验证", "请完成验证", "访问验证",
    "captcha", "verify you are human", "are you a robot", "cloudflare",
    "challenge-platform", "cf-chl", "geetest", "turnstile", "recaptcha",
)


def generic_signals(html_text: str, url: str = "", status=None) -> dict:
    """Heuristics for the agent: suggest a challenge block for an inspected page."""
    title = page_title(html_text)
    text = page_text(html_text)
    lowered = (title + "\n" + text).lower()
    matched = [hint for hint in GENERIC_HINTS if hint.lower() in lowered]
    lowered_url = (url or "").lower()
    url_hits = [part for part in ("captcha", "verify", "challenge", "challenge-platform") if part in lowered_url]
    selectors = []
    for selector in ("#captcha", ".captcha", "#challenge", ".challenge", "iframe[src*='captcha']",
                     "iframe[src*='challenge']", "[class*='verify']", "[id*='verify']"):
        try:
            if select_all(parse_html(html_text), selector):
                selectors.append(selector)
        except Exception:  # noqa: BLE001
            continue
    fields = {
        field: value for field, value in (
            ("title", title),
            ("url", url),
            ("status", status),
            ("textPreview", text[:1200]),
            ("matchedHints", matched[:10]),
            ("urlHits", url_hits),
            ("detectedSelectors", selectors),
        ) if value
    }
    suggestion = {"enabled": True}
    if url_hits:
        suggestion["url_contains"] = url_hits
    if matched:
        suggestion["keywords"] = matched[:6]
    if selectors:
        suggestion["selectors"] = selectors[:4]
    if title:
        suggestion["title_contains"] = [title[:20]] if any(h in title.lower() for h in ("验证", "captcha", "verify")) else []
    if status in (403, 429, 503):
        suggestion["statuses"] = [status]
    if not any(suggestion.get(key) for key in ("url_contains", "keywords", "selectors", "title_contains", "statuses")):
        suggestion = {}
    return {"success": True, "url": url, "page": fields,
            "likelyChallenge": bool(matched or url_hits or selectors or status in (403, 429, 503)),
            "suggestedChallenge": suggestion}