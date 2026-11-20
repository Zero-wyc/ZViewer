"""JSON rule schema, validation and result extraction."""
from __future__ import annotations

import json
import re
import time
from typing import Any, Optional
from urllib.parse import urljoin, urlsplit

from .dom import Node, parse_html, select_all, select_one
from .errors import RuleError
from .fetch import quote_keyword


RULE_FORMAT = 1
VISIBILITIES = ("public", "root")
CHALLENGE_STATUSES = (403, 429, 503)
FIELD_NAMES = ("title", "url", "cover", "description", "duration", "author")
_PLACEHOLDER_RE = re.compile(r"\{(keyword|query)\}", re.I)


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def default_stats() -> dict:
    return {
        "searches": 0,
        "successes": 0,
        "failures": 0,
        "last_used_at": None,
        "last_error": None,
    }


def host_of(value: str) -> str:
    value = (value or "").strip()
    if not value:
        return ""
    if "://" in value:
        value = urlsplit(value).hostname or ""
    else:
        value = value.split("/")[0].split(":")[0]
    return value.strip().lower().strip(".")


def rule_matches_host(rule: dict, host: str) -> bool:
    host = host_of(host)
    if not host:
        return False
    candidates = [rule.get("site") or ""] + list(rule.get("aliases") or [])
    for candidate in candidates:
        candidate = host_of(candidate)
        if not candidate:
            continue
        if host == candidate or host.endswith("." + candidate) or candidate.endswith("." + host):
            return True
    return False


def _text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def _require(mapping: dict, key: str, label: str, errors: list) -> Any:
    if key not in mapping or mapping[key] in (None, "", [], {}):
        errors.append("%s缺少字段 %s" % (label, key))
        return None
    return mapping[key]


def _string_list(raw) -> list:
    if raw is None:
        return []
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, (list, tuple, set)):
        return []
    return [str(item).strip() for item in raw if str(item).strip()]


def _normalize_script(raw) -> dict:
    if isinstance(raw, str):
        raw = {"source": raw}
    script = dict(raw or {})
    script["runtime"] = _text(script.get("runtime") or "node").lower()
    script["source"] = str(script.get("source") or "")
    try:
        script["timeout_sec"] = float(script.get("timeout_sec") or 20)
    except (TypeError, ValueError):
        script["timeout_sec"] = 20.0
    return script


def _normalize_play(raw) -> dict:
    play = dict(raw or {})
    headers = play.get("headers") or {}
    if not isinstance(headers, dict):
        headers = {}
    play["headers"] = {str(k): str(v) for k, v in headers.items() if v is not None}
    play["script"] = _normalize_script(play.get("script"))
    api = dict(play.get("api") or {})
    api["url"] = _text(api.get("url"))
    api_headers = api.get("headers") or {}
    if not isinstance(api_headers, dict):
        api_headers = {}
    api["headers"] = {str(k): str(v) for k, v in api_headers.items() if v is not None}
    skip = api.get("skipFrom") or api.get("skip_from") or []
    if isinstance(skip, str):
        skip = [skip]
    api["skipFrom"] = [_text(item) for item in skip if _text(item)]
    play["api"] = api
    play["play_url_regex"] = _text(play.get("play_url_regex") or play.get("playUrlRegex"))
    play["episode_regex"] = _text(play.get("episode_regex") or play.get("episodeRegex"))
    # 播放解析用的登录态：绑定账号后 play.script/test_play 会带上该账号 Cookie。
    play["account_id"] = _text(play.get("account_id") or play.get("accountId"))
    return play


def normalize_rule(raw: dict) -> dict:
    """Fill defaults and normalise field types. Does not validate semantics."""
    rule = dict(raw or {})
    rule["format"] = RULE_FORMAT
    rule["name"] = _text(rule.get("name"))
    rule["site"] = host_of(rule.get("site"))
    aliases = rule.get("aliases") or []
    if isinstance(aliases, str):
        aliases = [aliases]
    rule["aliases"] = [host_of(item) for item in aliases if host_of(item)]
    rule["enabled"] = bool(rule.get("enabled", True))
    visibility = _text(rule.get("visibility") or "public").lower()
    rule["visibility"] = visibility if visibility in VISIBILITIES else "public"
    rooms = rule.get("allowed_rooms") or []
    if isinstance(rooms, str):
        rooms = [rooms]
    rule["allowed_rooms"] = [_text(item) for item in rooms if _text(item)]
    rule["created_by"] = _text(rule.get("created_by") or "root")
    rule["created_at"] = _text(rule.get("created_at") or now_iso())
    rule["updated_at"] = _text(rule.get("updated_at") or now_iso())
    try:
        rule["version"] = int(rule.get("version") or 1)
    except (TypeError, ValueError):
        rule["version"] = 1
    rule["description"] = _text(rule.get("description"))
    stats = default_stats()
    stats.update(rule.get("stats") or {})
    rule["stats"] = stats

    search = dict(rule.get("search") or {})
    search["mode"] = _text(search.get("mode") or "http").lower()
    request = dict(search.get("request") or {})
    request["method"] = _text(request.get("method") or "GET").upper()
    request["url"] = _text(request.get("url"))
    headers = request.get("headers") or {}
    if not isinstance(headers, dict):
        headers = {}
    request["headers"] = {str(k): str(v) for k, v in headers.items() if v is not None}
    request["body"] = "" if request.get("body") is None else str(request.get("body"))
    request["body_type"] = _text(request.get("body_type") or "raw").lower()
    search["request"] = request
    search["encoding"] = _text(search.get("encoding")) or "utf-8"
    search["script"] = _normalize_script(search.get("script"))
    search["account_id"] = _text(search.get("account_id") or search.get("accountId"))
    rule["search"] = search

    parse = dict(rule.get("parse") or {})
    parse["type"] = _text(parse.get("type") or "html").lower()
    parse["script"] = _normalize_script(parse.get("script"))
    if parse["type"] == "html":
        container = parse.get("container") or parse.get("item_selector") or ""
        parse["container"] = _text(container)
        fields = parse.get("fields") or {}
        if isinstance(fields, dict):
            fields = {
                key: ({"selector": value} if isinstance(value, str) else dict(value or {}))
                for key, value in fields.items()
            }
        else:
            fields = {}
        parse["fields"] = fields
        parse["dedupe_by"] = _text(parse.get("dedupe_by") or "url")
    elif parse["type"] == "json":
        parse["list_path"] = _text(parse.get("list_path"))
        fields = parse.get("fields") or {}
        if isinstance(fields, dict):
            fields = {
                key: ({"path": value} if isinstance(value, str) else dict(value or {}))
                for key, value in fields.items()
            }
        else:
            fields = {}
        parse["fields"] = fields
        parse["dedupe_by"] = _text(parse.get("dedupe_by") or "url")
    parse["base_url"] = _text(parse.get("base_url"))
    try:
        parse["limit"] = max(1, min(100, int(parse.get("limit") or 30)))
    except (TypeError, ValueError):
        parse["limit"] = 30
    rule["parse"] = parse

    challenge = dict(rule.get("challenge") or {})
    challenge["enabled"] = bool(challenge.get("enabled", False))
    challenge["url_contains"] = _string_list(challenge.get("url_contains") or challenge.get("urlContains"))
    challenge["title_contains"] = _string_list(challenge.get("title_contains") or challenge.get("titleContains"))
    challenge["keywords"] = _string_list(challenge.get("keywords"))
    challenge["selectors"] = _string_list(challenge.get("selectors"))
    statuses = []
    for value in _string_list(challenge.get("statuses")):
        try:
            status = int(value)
        except (TypeError, ValueError):
            continue
        if 100 <= status <= 599:
            statuses.append(status)
    challenge["statuses"] = statuses
    challenge["script"] = _normalize_script(challenge.get("script"))
    challenge["wait_selector"] = _text(challenge.get("wait_selector") or challenge.get("waitSelector"))
    try:
        wait_seconds = float(challenge.get("wait_seconds") or challenge.get("waitSeconds") or 0)
    except (TypeError, ValueError):
        wait_seconds = 0.0
    challenge["wait_seconds"] = max(0.0, min(600.0, wait_seconds))
    challenge["note"] = _text(challenge.get("note"))
    rule["challenge"] = challenge

    if isinstance(raw.get("play"), dict) and raw.get("play"):
        rule["play"] = _normalize_play(raw.get("play"))
    return rule


def validate_rule(raw: dict) -> dict:
    """Normalise and validate a rule. Returns the normalised copy or raises RuleError."""
    if not isinstance(raw, dict):
        raise RuleError("规则必须是 JSON 对象")
    rule = normalize_rule(raw)
    errors: list = []
    if not rule["name"]:
        errors.append("缺少规则名称 name")
    if not rule["site"]:
        errors.append("缺少站点域名 site（例如 example.com）")
    search = rule["search"]
    if search["mode"] not in ("http", "script"):
        errors.append("search.mode 只支持 http 或 script")
    if search["mode"] == "http":
        request = search["request"]
        if request["method"] not in ("GET", "POST"):
            errors.append("search.request.method 只支持 GET/POST")
        url = request["url"]
        if not re.match(r"^https?://", url, re.I):
            errors.append("search.request.url 必须是 http(s) 绝对地址")
        if not (_PLACEHOLDER_RE.search(url) or _PLACEHOLDER_RE.search(request["body"])):
            errors.append("search.request.url 或 body 必须包含 {keyword} 占位符")
        headers = request["headers"]
        for key, value in headers.items():
            if "\n" in key or "\n" in value:
                errors.append("search.request.headers 不能包含换行")
                break
    else:
        if not (search.get("script") or {}).get("source"):
            errors.append("search.mode=script 时 search.script.source 不能为空")
        if (search.get("script") or {}).get("runtime") != "node":
            errors.append("search.script.runtime 目前只支持 node")
    parse = rule["parse"]
    if parse["type"] not in ("html", "json", "script"):
        errors.append("parse.type 只支持 html/json/script")
    if parse["type"] == "script":
        if not (parse.get("script") or {}).get("source"):
            errors.append("parse.type=script 时 parse.script.source 不能为空")
        if (parse.get("script") or {}).get("runtime") != "node":
            errors.append("parse.script.runtime 目前只支持 node")
    elif parse["type"] == "html":
        if not parse["container"]:
            errors.append("parse.container 不能为空（搜索结果条目的选择器）")
        fields = parse["fields"]
        for name in ("title", "url"):
            spec = fields.get(name)
            if not isinstance(spec, dict) or not spec.get("selector"):
                errors.append("parse.fields.%s 缺少 selector" % name)
        for key, spec in fields.items():
            if key not in FIELD_NAMES and key != "extra":
                errors.append("parse.fields 不支持字段 %s" % key)
            if not isinstance(spec, dict) or not spec.get("selector"):
                errors.append("parse.fields.%s 缺少 selector" % key)
    else:
        if not parse["list_path"]:
            errors.append("parse.list_path 不能为空（例如 data.list）")
        fields = parse["fields"]
        for name in ("title", "url"):
            spec = fields.get(name)
            if not isinstance(spec, dict) or not spec.get("path"):
                errors.append("parse.fields.%s 缺少 path" % name)
    challenge = rule["challenge"]
    if challenge["enabled"]:
        has_detector = bool(
            challenge["url_contains"]
            or challenge["title_contains"]
            or challenge["keywords"]
            or challenge["selectors"]
            or challenge["statuses"]
            or challenge["script"]["source"]
        )
        if not has_detector:
            errors.append("challenge.enabled=true 时至少需要一个检测条件（url_contains/title_contains/keywords/selectors/statuses/script）")
        if challenge["script"]["source"] and challenge["script"]["runtime"] != "node":
            errors.append("challenge.script.runtime 目前只支持 node")
        for selector in challenge["selectors"]:
            try:
                select_all(parse_html("<html></html>"), selector)
            except Exception as exc:
                errors.append("challenge.selectors 选择器无效 %s: %s" % (selector, exc))
                break
    play = rule.get("play") or {}
    if play:
        script = play.get("script") or {}
        if script.get("source") and script.get("runtime") != "node":
            errors.append("play.script.runtime 目前只支持 node")
        api = play.get("api") or {}
        if api.get("url") and not re.match(r"^https?://", api.get("url") or "", re.I):
            errors.append("play.api.url 必须是 http(s) 绝对地址")
        if play.get("play_url_regex"):
            try:
                re.compile(play["play_url_regex"])
            except re.error as exc:
                errors.append("play.play_url_regex 不是合法正则: %s" % exc)
    if errors:
        raise RuleError("规则校验失败: " + "；".join(errors), {"errors": errors})
    return rule


def build_request(rule: dict, keyword: str) -> dict:
    """Return a request description with the keyword substituted and encoded."""
    keyword = (keyword or "").strip()
    if not keyword:
        raise RuleError("搜索关键词不能为空")
    if len(keyword) > 100:
        raise RuleError("搜索关键词过长")
    search = rule["search"]
    encoded = quote_keyword(keyword, search.get("encoding") or "utf-8")
    request = search["request"]
    url = _PLACEHOLDER_RE.sub(encoded, request["url"])
    body_text = _PLACEHOLDER_RE.sub(encoded, request.get("body") or "")
    headers = dict(request.get("headers") or {})
    body: Optional[bytes] = None
    if request["method"] == "POST" and body_text:
        body = body_text.encode("utf-8")
        if not any(key.lower() == "content-type" for key in headers):
            if request.get("body_type") == "json":
                headers["Content-Type"] = "application/json; charset=utf-8"
            else:
                headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8"
    return {"method": request["method"], "url": url, "headers": headers, "body": body}


def _strip_tags(html_text: str) -> str:
    return re.sub(r"<[^>]+>", " ", html_text or "")


def _apply_field(value: str, spec: dict) -> str:
    value = value or ""
    pattern = spec.get("regex")
    if pattern:
        try:
            match = re.search(pattern, value, re.S)
        except re.error:
            match = None
        if match:
            try:
                value = match.group(int(spec.get("group") or 0))
            except (IndexError, ValueError):
                value = match.group(0)
        else:
            value = ""
    prefix = spec.get("prefix")
    if prefix:
        value = str(prefix) + value
    return re.sub(r"\s+", " ", value).strip()


def _html_field(node: Optional[Node], spec: dict, base_url: str, field_name: str) -> str:
    attr = _text(spec.get("attr") or "text") or "text"
    if node is None:
        return ""
    if attr == "innerHTML":
        value = "".join(child.html() for child in node.children)
    elif attr in ("text", "innerText"):
        value = node.text()
    else:
        value = node.get(attr) or ""
    value = _apply_field(value, spec)
    absolute = spec.get("absolute")
    if absolute is None:
        absolute = field_name in ("url", "cover")
    if absolute and value:
        value = urljoin(base_url, value)
    return value


def _extract_html(rule: dict, html_text: str, page_url: str) -> tuple:
    parse = rule["parse"]
    base_url = parse.get("base_url") or page_url
    root = parse_html(html_text or "")
    try:
        containers = select_all(root, parse["container"])
    except Exception as exc:  # selector errors surface as rule errors
        raise RuleError("parse.container 选择器无效: %s" % exc) from exc
    items: list = []
    skipped = 0
    for container in containers:
        item: dict = {}
        for field_name, spec in parse["fields"].items():
            selector = _text(spec.get("selector"))
            try:
                target = select_one(container, selector) if selector else container
            except Exception as exc:
                raise RuleError("parse.fields.%s 选择器无效: %s" % (field_name, exc)) from exc
            item[field_name] = _html_field(target, spec, base_url, field_name)
        if not item.get("title") or not item.get("url"):
            skipped += 1
            continue
        items.append(item)
    return items, skipped


def _json_path(data: Any, path: str) -> list:
    path = (path or "").strip()
    if path.startswith("$"):
        path = path[1:]
    tokens: list = []
    for part in re.split(r"\.(?![^\[]*\])", path):
        part = part.strip()
        if not part:
            continue
        match = re.match(r"^([^\[\]]*)((?:\[[^\]]*\])*)$", part)
        if not match:
            raise RuleError("JSON 路径无效: %s" % path)
        name, brackets = match.groups()
        if name:
            tokens.append(("key", name))
        for bracket in re.findall(r"\[([^\]]*)\]", brackets):
            bracket = bracket.strip()
            if bracket in ("*", ""):
                tokens.append(("all", None))
            else:
                try:
                    tokens.append(("index", int(bracket)))
                except ValueError:
                    tokens.append(("key", bracket.strip("\"'")))
    values = [data]
    for kind, token in tokens:
        next_values = []
        for value in values:
            if kind == "all":
                if isinstance(value, list):
                    next_values.extend(value)
                elif isinstance(value, dict):
                    next_values.extend(value.values())
            elif kind == "index":
                if isinstance(value, list) and -len(value) <= token < len(value):
                    next_values.append(value[token])
            else:
                if isinstance(value, dict) and token in value:
                    next_values.append(value[token])
        values = next_values
    return values


def _extract_json(rule: dict, text: str, page_url: str) -> tuple:
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise RuleError("站点返回的不是有效 JSON: %s" % exc) from exc
    parse = rule["parse"]
    raw_items = _json_path(data, parse["list_path"])
    if len(raw_items) == 1 and isinstance(raw_items[0], list):
        raw_items = raw_items[0]
    items = []
    skipped = 0
    for raw_item in raw_items:
        item = {}
        for field_name, spec in parse["fields"].items():
            values = _json_path(raw_item, _text(spec.get("path")))
            value = values[0] if values else ""
            if isinstance(value, (dict, list)):
                value = json.dumps(value, ensure_ascii=False)
            value = _apply_field(_text(value), spec)
            absolute = spec.get("absolute")
            if absolute is None:
                absolute = field_name in ("url", "cover")
            if absolute and value:
                value = urljoin(parse.get("base_url") or page_url, value)
            item[field_name] = value
        if not item.get("title") or not item.get("url"):
            skipped += 1
            continue
        items.append(item)
    return items, skipped


def extract_items(rule: dict, text: str, page_url: str) -> tuple:
    """Parse a fetched page into items. Returns (items, skipped_count)."""
    parse = rule["parse"]
    if parse["type"] == "json":
        items, skipped = _extract_json(rule, text, page_url)
    elif parse["type"] == "script":
        raise RuleError("parse.type=script 需要由 JS 运行时执行，不能走 extract_items")
    else:
        items, skipped = _extract_html(rule, text, page_url)
    dedupe_by = parse.get("dedupe_by") or "url"
    seen = set()
    unique = []
    for item in items:
        key = item.get(dedupe_by) or ""
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        unique.append(item)
        if len(unique) >= parse["limit"]:
            break
    return unique, skipped


def public_rule_view(rule: dict, include_parse: bool = False) -> dict:
    view = {
        "id": rule.get("id"),
        "name": rule.get("name"),
        "site": rule.get("site"),
        "aliases": rule.get("aliases") or [],
        "enabled": rule.get("enabled", True),
        "visibility": rule.get("visibility"),
        "allowedRooms": rule.get("allowed_rooms") or [],
        "description": rule.get("description") or "",
        "createdBy": rule.get("created_by"),
        "createdAt": rule.get("created_at"),
        "updatedAt": rule.get("updated_at"),
        "version": rule.get("version"),
        "stats": rule.get("stats") or default_stats(),
    }
    if include_parse:
        view["search"] = rule.get("search")
        view["parse"] = rule.get("parse")
        view["challenge"] = rule.get("challenge")
        if rule.get("play"):
            view["play"] = rule.get("play")
    return view