"""Resolve a site page into a playable media URL.

P0 目标：把「全网搜片」拿到的站点详情页解析成播放器可直接播放的地址。
优先使用规则里的 `play` 段（站点播放器自己的接口），其次做通用兜底：
页面 HTML/JS 里的 m3u8/mp4/flv 直链、CMS 的 player_aaaa 配置、播放页里的直链。

输出统一结构，前端据此构造代理 URL 并交给现有 HLS/FLV 引擎：
    {success, site, title, format, url, headers, pageUrl, episodes, source}
"""
from __future__ import annotations

import json
import re
import time
from typing import Optional
from urllib.parse import urljoin, urlsplit

from .errors import FetchError, RuleError
from .rules import host_of, rule_matches_host
from .store import rule_visible_to

MEDIA_RE = re.compile(r"""https?://[^\s"'\\<>]+?\.(?:m3u8|mp4|flv)(?:\?[^\s"'\\<>]*)?""", re.I)
# 带时效签名的地址（如 auth_/token/expires）在观众端会很快失效，
# 解析时优先选不带这些参数的线路。
AUTH_QUERY_RE = re.compile(
    r"(?:^|[?&])(?:auth_|auth|token|expires?|sign|signature|ts|key|auth_key)=", re.I
)
PLAY_LINK_RE = re.compile(
    r"""<a[^>]+href=["']([^"']*(?:vodplay/|/player\?|/play/)[^"']*)["'][^>]*>(.*?)</a>""",
    re.I | re.S,
)
JSON_URL_RE = re.compile(r"""["']url["']\s*:\s*["']([^"']+\.(?:m3u8|mp4|flv)[^"']*)["']""", re.I)
TITLE_RE = re.compile(r"<h1[^>]*>(.*?)</h1>", re.I | re.S)
OG_TITLE_RE = re.compile(r"""<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']""", re.I)
TAG_RE = re.compile(r"<[^>]+>")

MAX_EPISODES = 200


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", TAG_RE.sub(" ", text or "")).strip()


def detect_format(url: str) -> str:
    lower = (url or "").lower()
    if ".m3u8" in lower:
        return "hls"
    if ".flv" in lower:
        return "flv"
    if ".mp4" in lower:
        return "mp4"
    return ""


MEDIA_FORMATS = {"hls", "flv", "mp4"}
MAX_QUALITIES = 12


def normalize_qualities(raw, base_headers: dict) -> list:
    """把播放脚本返回的 qualities 规范化成 [{name,url,format,headers}]。

    脚本是站点清晰度的唯一来源：站点有多档清晰度（标清/高清/1080P、蓝光等）时，
    每档给一条 {name,url}，url 可以带各自独立的请求头。这里只做格式校验、
    去重与请求头合并，具体选哪档由播放器决定。
    """
    items = raw if isinstance(raw, (list, tuple)) else []
    result = []
    names = set()
    urls = set()
    for item in items:
        if isinstance(item, str):
            entry = {"url": item}
        elif isinstance(item, dict):
            entry = item
        else:
            continue
        url = str(entry.get("url") or entry.get("playUrl") or "").strip()
        if not url or not re.match(r"^https?://", url, re.I) or url in urls:
            continue
        fmt = str(entry.get("format") or "").strip().lower() or detect_format(url)
        if fmt not in MEDIA_FORMATS:
            continue
        headers = dict(base_headers or {})
        raw_headers = entry.get("headers")
        if isinstance(raw_headers, dict):
            headers.update({str(k): str(v) for k, v in raw_headers.items() if v})
        name = str(entry.get("name") or entry.get("label") or "").strip()
        if not name:
            name = fmt.upper()
        unique = name
        index = 2
        while unique in names:
            unique = "%s %d" % (name, index)
            index += 1
        names.add(unique)
        urls.add(url)
        result.append({"name": unique, "url": url, "format": fmt, "headers": headers})
        if len(result) >= MAX_QUALITIES:
            break
    return result


class PlayResolver:
    """规则优先 + 通用兜底的播放地址解析。"""

    def __init__(self, store, fetcher, browser=None, js=None, accounts=None):
        self.store = store
        self.fetcher = fetcher
        # 可选：Node 运行时。规则可以用 play.script 自己调站点接口（反爬站点把
        # 搜索/播放都收在 /api/* 后面，HTTP 直连 403 但脚本运行时可以拿到）。
        self.js = js
        # 可选：受控 Chromium 控制器。反爬站点（403/JS 渲染/接口签名）用它
        # 打开播放页，再从网络事件/performance/video 元素里嗅探媒体地址。
        self.browser = browser
        # 可选：账号库。规则绑定账号后，播放脚本/test_play 能拿到登录态
        # （会员内容、需要登录才回多档清晰度的站点）。
        self.accounts = accounts

    # ---------------------------------------------------------------- helpers
    def _find_rule(self, url: str, room_id: str, role: str):
        host = host_of(url)
        if not host:
            return None
        for rule in self.store.list(include_disabled=False):
            if not rule.get("enabled", True):
                continue
            if not rule_matches_host(rule, host):
                continue
            if not rule_visible_to(rule, room_id, role):
                continue
            return rule
        return None

    def _account(self, rule: dict) -> dict:
        """规则绑定的账号；没有绑定返回空对象。

        play.account_id 优先，兼容只在 search 段绑定过的旧规则。绑定是用户
        自己的操作，即表示同意引擎在该规则的搜索/播放解析/试播中使用这份
        Cookie；没绑定的规则不会带任何账号信息。
        """
        play = (rule or {}).get("play") or {}
        search = (rule or {}).get("search") or {}
        account_id = play.get("account_id") or search.get("account_id") or ""
        if not account_id or self.accounts is None:
            return {}
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

    def _headers(self, rule, page_url: str) -> dict:
        play = (rule or {}).get("play") or {}
        headers = {}
        search = (rule or {}).get("search") or {}
        request = search.get("request") or {}
        for source in (request.get("headers") or {}, play.get("headers") or {}):
            for key, value in source.items():
                if value:
                    headers[str(key)] = str(value)
        if "Referer" not in headers:
            parts = urlsplit(page_url)
            if parts.scheme and parts.netloc:
                headers["Referer"] = parts.scheme + "://" + parts.netloc + "/"
        return headers

    def _title(self, html: str) -> str:
        for pattern in (OG_TITLE_RE, TITLE_RE):
            match = pattern.search(html or "")
            if match:
                title = _clean(match.group(1))
                if title:
                    return title
        return ""

    def _episodes(self, html: str, page_url: str, play_cfg: dict) -> list:
        pattern = PLAY_LINK_RE
        custom = play_cfg.get("episode_regex")
        if custom:
            pattern = re.compile(custom, re.I | re.S)
        seen = set()
        episodes = []
        for match in pattern.finditer(html or ""):
            href = (match.group(1) or "").strip()
            if not href or href.startswith(("javascript:", "#")):
                continue
            url = urljoin(page_url, href)
            if url in seen:
                continue
            seen.add(url)
            name = _clean(match.group(2)) if match.lastindex and match.lastindex >= 2 else ""
            episodes.append({"name": name or ("第 %d 集" % (len(episodes) + 1)), "playPage": url})
            if len(episodes) >= MAX_EPISODES:
                break
        return episodes

    def _match_play_vars(self, url: str, play_cfg: dict) -> dict:
        pattern = play_cfg.get("play_url_regex")
        if not pattern:
            return {}
        match = re.search(pattern, url)
        if not match:
            return {}
        return {key: value for key, value in match.groupdict().items() if value is not None}

    def _media_from_text(self, text: str) -> str:
        match = MEDIA_RE.search(text or "")
        if match:
            return match.group(0)
        match = JSON_URL_RE.search(text or "")
        if match:
            return match.group(1).replace("\\/", "/")
        return ""

    @staticmethod
    def _stability_score(url: str) -> int:
        """无签名参数的地址更稳定：观众端稍后加入也能直接拉。"""
        query = urlsplit(url).query
        if not query:
            return 3
        return 1 if AUTH_QUERY_RE.search("?" + query) else 2

    def _playable(self, url: str, headers: dict) -> bool:
        """探测媒体地址是否真的可拉，跳过会员/过期线路返回的 402/403。"""
        try:
            resp = self.fetcher.fetch(
                url, headers={**headers, "Range": "bytes=0-1", "Accept": "*/*"}, timeout=12
            )
            return 200 <= int(resp.status or 0) < 400
        except FetchError as exc:
            return bool(exc.status and 200 <= exc.status < 400)
        except Exception:  # noqa: BLE001 - 探测失败按不可播放处理
            return False

    def _run_script(self, script: dict, payload: dict) -> dict:
        if self.js is None:
            raise RuleError("引擎未配置 JS 运行时，无法执行播放脚本")
        if (script.get("runtime") or "node") != "node":
            raise RuleError("播放脚本只支持 node 运行时")
        outcome = self.js.run(script.get("source") or "", payload,
                             timeout_sec=script.get("timeout_sec"))
        if not isinstance(outcome, dict):
            raise RuleError("播放脚本输出格式不正确")
        if not outcome.get("ok"):
            raise RuleError("播放脚本执行失败: %s" % (outcome.get("error") or "未知错误"))
        result = outcome.get("result")
        if not isinstance(result, dict):
            raise RuleError("播放脚本必须返回对象")
        return result

    def _result(self, *, rule, page_url: str, title: str, url: str, headers: dict,
                episodes: list, source: str, note: str = "",
                qualities: Optional[list] = None, media_format: str = "") -> dict:
        quality_list = normalize_qualities(qualities, headers)
        if quality_list and not url:
            url = quality_list[0]["url"]
            headers = quality_list[0]["headers"]
            media_format = media_format or quality_list[0]["format"]
        result = {
            "success": True,
            "site": (rule or {}).get("site") or host_of(page_url),
            "ruleId": (rule or {}).get("id") or "",
            "ruleName": (rule or {}).get("name") or "",
            "title": title,
            "format": media_format or detect_format(url),
            "url": url,
            "headers": headers,
            "pageUrl": page_url,
            "episodes": episodes,
            "source": source,
            "note": note,
        }
        if quality_list:
            result["qualities"] = quality_list
        return result

    # ---------------------------------------------------------------- browser
    def _browser_headers(self, target: str, page_url: str, page, rule) -> dict:
        """浏览器兜底时给代理带上的请求头：Referer/UA/Cookie。"""
        headers = dict(self._headers(rule, target))
        parts = urlsplit(page_url or target)
        if parts.scheme and parts.netloc:
            headers.setdefault("Referer", "%s://%s/" % (parts.scheme, parts.netloc))
        try:
            ua = page.evaluate("navigator.userAgent")
            if ua:
                headers.setdefault("User-Agent", str(ua))
        except Exception:
            pass
        try:
            cookie = self.browser.cookie_header(host_of(target))
            if cookie:
                headers["Cookie"] = cookie
        except Exception:
            pass
        return {k: str(v) for k, v in headers.items() if v}

    def _resolve_with_browser(self, target: str, rule, play_cfg: dict):
        browser = self.browser
        if browser is None:
            return None
        try:
            if not browser.available():
                return None
            status = browser.status()
            # 人工登录窗口正在使用时不抢标签页，避免打断登录流程。
            if status.get("running") and status.get("mode") == "visible":
                return None
            info = browser.open(target, wait_sec=2.5)
            page = browser.ensure()
            base_url = str((info or {}).get("url") or page.url or target)
            try:
                html = page.html()
            except Exception:
                html = ""
            title = self._title(html) or str((info or {}).get("title") or "")
            episodes = self._episodes(html, base_url, play_cfg)
            headers = self._browser_headers(target, base_url, page, rule)
            candidates = [base_url]
            for item in episodes[:3]:
                if item["playPage"] not in candidates:
                    candidates.append(item["playPage"])
            best = None  # (score, order, media, page_url)
            for candidate in candidates:
                try:
                    if candidate != page.url:
                        browser.open(candidate, wait_sec=2.0)
                        page = browser.ensure()
                    page.nudge_playback()
                    time.sleep(1.8)
                    media_urls = page.collect_media()
                    if not media_urls:
                        time.sleep(1.8)
                        media_urls = page.collect_media()
                except Exception:
                    continue
                for order, media in enumerate(media_urls):
                    if not detect_format(media):
                        continue
                    if not self._playable(media, headers):
                        continue
                    score = self._stability_score(media)
                    if best is None or score > best[0]:
                        best = (score, order, media, candidate)
            if best is None:
                return None
            result = self._result(
                rule=rule, page_url=best[3], title=title or host_of(target),
                url=best[2], headers=headers, episodes=episodes, source="browser",
            )
            result["note"] = "通过受控浏览器解析（可能依赖站点登录态）"
            return result
        except Exception:
            return None

    # ---------------------------------------------------------------- resolve
    def resolve(self, target: str, room_id: str = "", role: str = "guest", rule: Optional[dict] = None) -> dict:
        target = (target or "").strip()
        if not target:
            raise RuleError("缺少要解析的站点地址")
        if not re.match(r"^https?://", target, re.I):
            raise RuleError("仅支持 http/https 地址")
        host = host_of(target)
        rule = rule or self._find_rule(target, room_id, role)
        play_cfg = (rule or {}).get("play") or {}
        # 用户把账号绑定到规则后，搜索与播放解析都带同一份登录态：
        # 会员/登录后才给多档清晰度的站点靠它取地址。
        account = self._account(rule)
        headers = self._with_account(self._headers(rule, target), account)

        direct = self._media_from_text(target)
        if direct and detect_format(target):
            return self._result(rule=rule, page_url=target, title="", url=target,
                                headers=headers, episodes=[], source="direct")

        # 0) 规则声明的播放脚本：反爬站点的接口签名/校验全在脚本里处理。
        script_cfg = play_cfg.get("script") or {}
        if (script_cfg.get("source") or "").strip():
            try:
                data = self._run_script(script_cfg, {
                    "pageUrl": target, "site": host, "rule": rule,
                    "headers": headers, "account": account,
                })
            except RuleError:
                data = {}
            merged = dict(headers)
            merged.update({str(k): str(v) for k, v in (data.get("headers") or {}).items() if v})
            # 站点有多档清晰度时，脚本在 qualities 里逐档给出 {name,url}（可带各自的
            # format/headers）。这里挑默认档：脚本给的 url 优先，否则按列表顺序取
            # 第一个能拉的，避免默认档过期时整次解析失败。
            qualities = normalize_qualities(data.get("qualities"), merged)
            candidates = []
            media = str(data.get("url") or "").strip()
            if media:
                candidates.append((media, str(data.get("format") or "").strip().lower()
                                   or detect_format(media)))
            for quality in qualities:
                if not any(item[0] == quality["url"] for item in candidates):
                    candidates.append((quality["url"], quality["format"]))
            chosen = ""
            chosen_format = ""
            for candidate_url, candidate_format in candidates[:4]:
                if candidate_format not in MEDIA_FORMATS:
                    continue
                if self._playable(candidate_url, merged):
                    chosen = candidate_url
                    chosen_format = candidate_format
                    break
            if chosen:
                if not any(item["url"] == chosen for item in qualities):
                    qualities.insert(0, {
                        "name": str(data.get("quality") or "默认"),
                        "url": chosen, "format": chosen_format, "headers": merged,
                    })
                script_episodes = []
                for index, item in enumerate(data.get("episodes") or []):
                    if isinstance(item, dict) and item.get("url"):
                        script_episodes.append({
                            "name": str(item.get("name") or ("第 %d 集" % (index + 1))),
                            "url": str(item["url"]),
                            "playPage": str(item.get("playPage") or ""),
                        })
                    elif isinstance(item, str) and item:
                        script_episodes.append({"name": "第 %d 集" % (index + 1), "url": item,
                                                "playPage": ""})
                result = self._result(
                    rule=rule, page_url=target,
                    title=str(data.get("title") or "") or host_of(target),
                    url=chosen, headers=merged, episodes=script_episodes[:MAX_EPISODES],
                    source="rule-script", qualities=qualities, media_format=chosen_format,
                )
                if data.get("note"):
                    result["note"] = str(data["note"])
                return result

        page_url = target
        html = ""
        title = ""
        episodes = []
        fetch_error = None
        try:
            page = self.fetcher.fetch(target, headers=headers)
            page_url = page.url or target
            html = page.text or ""
            title = self._title(html)
            episodes = self._episodes(html, page_url, play_cfg)
        except FetchError as exc:
            # 403/验证码/JS 渲染站点：HTTP 直连拿不到，交给浏览器兜底。
            fetch_error = exc

        # 1) 规则声明的播放接口：逐条线路尝试（会员/iframe 线路失败时继续下一条）
        api_cfg = play_cfg.get("api") or {}
        api_url_template = (api_cfg.get("url") or "").strip()
        iframe_fallback = None
        if api_url_template:
            api_headers = dict(headers)
            api_headers.update({str(k): str(v) for k, v in (api_cfg.get("headers") or {}).items() if v})
            skip_from = {
                str(item).strip().lower()
                for item in (api_cfg.get("skipFrom") or api_cfg.get("skip_from") or [])
                if item
            }
            candidates = []
            for candidate in [page_url] + [item["playPage"] for item in episodes]:
                variables = self._match_play_vars(candidate, play_cfg)
                if not variables:
                    continue
                play_from = str(variables.get("playFrom") or "").strip().lower()
                # 会员/官方线路（bilibili/qq/youku 等）解析出来的是限时地址，
                # 观众端稍后加入就 402；规则可声明跳过这些线路。
                if play_from and play_from in skip_from:
                    continue
                candidates.append(variables)
                if len(candidates) >= 10:
                    break
            best = None  # (score, order, media)
            for order, variables in enumerate(candidates):
                try:
                    api_url = api_url_template.format(**variables)
                except (KeyError, IndexError) as exc:
                    raise RuleError("play.api.url 占位符不完整: %s" % exc) from exc
                try:
                    resp = self.fetcher.fetch(api_url, headers=api_headers)
                    data = json.loads(resp.text)
                except (FetchError, ValueError):
                    continue
                if not isinstance(data, dict):
                    continue
                inner = data.get("data") if isinstance(data.get("data"), dict) else data
                mode = str(inner.get("mode") or "native").lower()
                media = inner.get("url") or inner.get("playUrl") or inner.get("m3u8") or ""
                media = str(media or "").replace("\\/", "/")
                if mode == "iframe" and media:
                    if iframe_fallback is None:
                        iframe_fallback = media
                    continue
                if not (media and detect_format(media)):
                    continue
                if not self._playable(media, headers):
                    continue
                score = self._stability_score(media)
                # 先按稳定性挑，同分再按站点给的线路顺序
                if best is None or score > best[0]:
                    best = (score, order, media)
            if best is not None:
                return self._result(rule=rule, page_url=page_url, title=title, url=best[2],
                                    headers=headers, episodes=episodes, source="rule-api")

        # 2) 页面里直接带媒体地址（少数站点把播放地址写进 HTML/JS）
        direct = self._media_from_text(html)
        if direct:
            return self._result(rule=rule, page_url=page_url, title=title, url=direct,
                                headers=headers, episodes=episodes, source="page")

        # 3) 播放页里再找一次直链
        for item in episodes[:3]:
            try:
                detail = self.fetcher.fetch(item["playPage"], headers=headers)
            except FetchError:
                continue
            media = self._media_from_text(detail.text)
            if media:
                return self._result(rule=rule, page_url=page_url, title=title or item["name"],
                                    url=media, headers=headers, episodes=episodes, source="play-page")

        # 4) 受控浏览器兜底：反爬站点 HTTP 拿不到页面，或页面靠 JS/XHR 拿地址
        browser_result = self._resolve_with_browser(target, rule, play_cfg)
        if browser_result:
            return browser_result

        # 5) 只有 iframe 时明确返回，由前端决定是否降级打开原站
        if iframe_fallback:
            return {
                "success": True, "site": (rule or {}).get("site") or host,
                "ruleId": (rule or {}).get("id") or "",
                "ruleName": (rule or {}).get("name") or "",
                "title": title, "format": "iframe", "url": iframe_fallback,
                "headers": headers, "pageUrl": page_url, "episodes": episodes,
                "source": "rule-api", "note": "该站点正片需要会员或本站不允许直接播放",
            }

        raise RuleError("没有解析到可播放地址（该站点可能需要登录/验证，或暂不支持）")
