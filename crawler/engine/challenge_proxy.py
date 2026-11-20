"""Human-verification (challenge) sessions and a same-origin reverse proxy.

A site may answer a search with a captcha / slider / login wall.  We keep a
short-lived session per challenge: it remembers the rule, the keyword and the
cookies collected while the user solves the page.  The page itself is served
back through this process so the user's browser never talks to the site
directly (no mixed-content/CSP problems) and the cookies stay server-side.
"""
from __future__ import annotations

import http.client
import re
import secrets
import threading
import time
from typing import Optional
from urllib.parse import urljoin, urlsplit

from .errors import EngineError

MAX_BODY = 8 * 1024 * 1024
PROXY_PREFIX = "/api/crawler/challenge"

_ATTR_RE = re.compile(
    r"""(?P<name>\b(?:src|href|action|poster|data-src|data-url|data-original)\s*=\s*)(?P<quote>["'])(?P<url>.*?)(?P=quote)""",
    re.I | re.S,
)
_SRCSET_RE = re.compile(
    r"""(?P<name>\bsrcset\s*=\s*)(?P<quote>["'])(?P<url>.*?)(?P=quote)""",
    re.I | re.S,
)
_CSS_URL_RE = re.compile(r'''url\(\s*(["']?)([^"')]+)\1\s*\)''', re.I)
_META_CSP_RE = re.compile(
    r'''<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>''', re.I
)
_BASE_RE = re.compile(r"<base\b[^>]*>", re.I)


def _origin_of(url: str) -> str:
    parsed = urlsplit(url)
    if not parsed.scheme or not parsed.netloc:
        return ""
    return "%s://%s" % (parsed.scheme, parsed.netloc)


def _same_origin(url: str, origin: str) -> bool:
    return bool(origin) and url.lower().startswith(origin.lower().rstrip("/") + "/")


class ChallengeSessionStore:
    """In-memory challenge sessions (15-30 minutes is enough to solve one)."""

    def __init__(self, ttl_sec: int = 1800, max_sessions: int = 200):
        self.ttl_sec = max(60, int(ttl_sec or 1800))
        self.max_sessions = max(1, int(max_sessions or 200))
        self._lock = threading.Lock()
        self._sessions: dict = {}

    # ------------------------------------------------------------- lifecycle
    def create(self, rule: dict, keyword: str, room_id: Optional[str], role: str,
               page: dict, challenge: dict) -> dict:
        now = time.time()
        page_url = str(page.get("pageUrl") or (rule.get("search") or {}).get("request", {}).get("url") or "")
        origin = _origin_of(page_url)
        session = {
            "id": secrets.token_hex(12),
            "ruleId": str(rule.get("id") or ""),
            "site": str(rule.get("site") or ""),
            "name": str(rule.get("name") or rule.get("site") or ""),
            "keyword": keyword,
            "roomId": room_id or "",
            "role": role or "guest",
            "pageUrl": page_url,
            "origin": origin,
            "status": page.get("status") or 0,
            "reason": (challenge or {}).get("reason") or "",
            "note": (challenge or {}).get("note") or "",
            "cookies": {},
            "createdAt": int(now),
            "updatedAt": int(now),
            "expiresAt": int(now + self.ttl_sec),
            "completed": False,
        }
        with self._lock:
            self._prune_locked(now)
            self._sessions[session["id"]] = session
            while len(self._sessions) > self.max_sessions:
                oldest = min(self._sessions.values(), key=lambda item: item["createdAt"])
                self._sessions.pop(oldest["id"], None)
        return session

    def _prune_locked(self, now: Optional[float] = None) -> None:
        now = now or time.time()
        expired = [sid for sid, item in self._sessions.items() if item["expiresAt"] <= now]
        for sid in expired:
            self._sessions.pop(sid, None)

    def get(self, session_id: str) -> dict:
        with self._lock:
            self._prune_locked()
            session = self._sessions.get(session_id)
            if session is None:
                raise EngineError("challenge_not_found", "验证会话不存在或已过期，请重新搜索")
            session["updatedAt"] = int(time.time())
            return session

    def list(self, include_completed: bool = False) -> list:
        """给 GUI 的待处理验证列表（不含 Cookie 值）。"""
        now = time.time()
        with self._lock:
            self._prune_locked(now)
            items = []
            for session in self._sessions.values():
                if session.get("completed") and not include_completed:
                    continue
                items.append({
                    "id": session["id"],
                    "site": session["site"],
                    "name": session["name"],
                    "keyword": session["keyword"],
                    "roomId": session.get("roomId") or "",
                    "pageUrl": session["pageUrl"],
                    "proxyUrl": self.proxy_base(session),
                    "reason": session.get("reason") or "",
                    "note": session.get("note") or "",
                    "status": session.get("status") or 0,
                    "createdAt": session["createdAt"],
                    "expiresAt": session["expiresAt"],
                    "completed": bool(session.get("completed")),
                    "cookies": len(session.get("cookies") or {}),
                })
        items.sort(key=lambda item: item["createdAt"], reverse=True)
        return items

    def delete(self, session_id: str) -> bool:
        with self._lock:
            return self._sessions.pop(session_id, None) is not None

    def mark_completed(self, session_id: str, completed: bool = True) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None:
                session["completed"] = bool(completed)
                session["updatedAt"] = int(time.time())

    def clear(self) -> int:
        with self._lock:
            count = len(self._sessions)
            self._sessions.clear()
            return count

    # --------------------------------------------------------------- cookies
    def _cookie_name(self, session_id: str, name: str) -> str:
        return "zc_%s_%s" % (session_id, name)

    def _cookie_header(self, session: dict) -> str:
        cookies = session.get("cookies") or {}
        return "; ".join("%s=%s" % (name, value) for name, value in cookies.items())

    def absorb_browser_cookies(self, session: dict, header: str) -> None:
        prefix = "zc_%s_" % session["id"]
        for part in (header or "").split(";"):
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            name = name.strip()
            if not name.startswith(prefix):
                continue
            session["cookies"][name[len(prefix):]] = value.strip()

    def absorb_response_cookies(self, session: dict, values) -> list:
        """Store Set-Cookie values and return browser-facing rewritten headers."""
        rewritten = []
        for value in values or []:
            first, _, rest = value.partition(";")
            if "=" not in first:
                continue
            name, cookie_value = first.split("=", 1)
            name = name.strip()
            if not name:
                continue
            session["cookies"][name] = cookie_value.strip()
            rewritten.append(
                "%s=%s; Path=%s/%s/; HttpOnly; SameSite=Lax"
                % (self._cookie_name(session["id"], name), cookie_value.strip(), PROXY_PREFIX, session["id"])
            )
        return rewritten

    # ---------------------------------------------------------------- fetch
    def fetch(self, session: dict, url: str, method: str = "GET", headers: Optional[dict] = None,
              body: bytes = b"", max_redirects: int = 5) -> tuple:
        """Fetch via the session cookie jar; follows redirects, returns raw bytes."""
        headers = dict(headers or {})
        headers["Host"] = urlsplit(url).netloc
        if not self._same_target(session, url):
            raise EngineError("challenge_origin_mismatch", "验证代理只允许访问发起搜索的站点")
        redirects = 0
        while True:
            status, response_headers, raw = self._request(session, url, method, headers, body)
            self.absorb_response_cookies(session, response_headers.get("set-cookie") or [])
            location = response_headers.get("location") or ""
            if status in (301, 302, 303, 307, 308) and location and redirects < max_redirects:
                url = urljoin(url, location)
                if not self._same_target(session, url):
                    break
                if status in (301, 302, 303):
                    method, body = "GET", b""
                redirects += 1
                headers.pop("Content-Type", None)
                headers["Host"] = urlsplit(url).netloc
                continue
            return status, response_headers, raw

    def _same_target(self, session: dict, url: str) -> bool:
        return _origin_of(url) == session.get("origin")

    def _request(self, session: dict, url: str, method: str, headers: dict, body: bytes) -> tuple:
        parsed = urlsplit(url)
        if parsed.scheme not in ("http", "https"):
            raise EngineError("challenge_bad_url", "验证代理只支持 http/https")
        timeout = 30
        if parsed.scheme == "https":
            conn = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout)
        else:
            conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=timeout)
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        out_headers = {
            "User-Agent": headers.get("User-Agent") or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127 Safari/537.36",
            "Accept": headers.get("Accept") or "*/*",
            "Accept-Language": headers.get("Accept-Language") or "zh-CN,zh;q=0.9,en;q=0.6",
            "Accept-Encoding": "identity",
        }
        for name in ("Content-Type", "X-Requested-With", "Range", "Referer", "Origin"):
            if headers.get(name):
                out_headers[name] = headers[name]
        cookie = self._cookie_header(session)
        if cookie:
            out_headers["Cookie"] = cookie
        try:
            conn.request(method.upper(), path, body=body or None, headers=out_headers)
            response = conn.getresponse()
            raw = response.read(MAX_BODY + 1)
            if len(raw) > MAX_BODY:
                raise EngineError("challenge_too_large", "验证页面响应过大")
            headers_out: dict = {}
            header_list = response.getheaders()
            for name, value in header_list:
                key = name.lower()
                headers_out.setdefault(key, []).append(value)
            for key in ("location", "content-type", "cache-control", "set-cookie"):
                if key in headers_out:
                    headers_out[key] = headers_out[key] if key == "set-cookie" else headers_out[key][0]
            return response.status, headers_out, raw
        except (OSError, http.client.HTTPException) as exc:
            raise EngineError("challenge_fetch_failed", "验证页面请求失败: %s" % exc) from exc
        finally:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass

    # --------------------------------------------------------------- rewrite
    def proxy_base(self, session: dict) -> str:
        return "%s/%s/site" % (PROXY_PREFIX, session["id"])

    def _to_proxy(self, session: dict, raw_url: str, base_url: str) -> str:
        raw_url = (raw_url or "").strip()
        if not raw_url or raw_url.startswith(("#", "data:", "blob:", "javascript:", "mailto:", "tel:")):
            return raw_url
        absolute = urljoin(base_url, raw_url)
        if not _same_origin(absolute, session.get("origin") or ""):
            return raw_url
        rest = absolute[len(session["origin"]):]
        return self.proxy_base(session) + rest

    def rewrite_html(self, session: dict, html_text: str) -> str:
        page_url = session["pageUrl"]
        html_text = _META_CSP_RE.sub("", html_text)
        html_text = _BASE_RE.sub("", html_text, count=1)

        def attr(match):
            url = self._to_proxy(session, match.group("url"), page_url)
            return match.group("name") + match.group("quote") + url + match.group("quote")

        html_text = _ATTR_RE.sub(attr, html_text)

        def srcset(match):
            parts = []
            for candidate in match.group("url").split(","):
                bits = candidate.strip().split()
                if not bits:
                    continue
                bits[0] = self._to_proxy(session, bits[0], page_url)
                parts.append(" ".join(bits))
            return match.group("name") + match.group("quote") + ", ".join(parts) + match.group("quote")

        html_text = _SRCSET_RE.sub(srcset, html_text)

        def css_url(match):
            url = self._to_proxy(session, match.group(2), page_url)
            return "url(%s%s%s)" % (match.group(1), url, match.group(1))

        html_text = _CSS_URL_RE.sub(css_url, html_text)
        script = self._shim(session)
        lower = html_text.lower()
        index = lower.find("<head")
        if index >= 0:
            end = lower.find(">", index)
            if end >= 0:
                return html_text[: end + 1] + script + html_text[end + 1:]
        return script + html_text

    def rewrite_css(self, session: dict, css_text: str, css_url: str) -> str:
        return _CSS_URL_RE.sub(
            lambda m: "url(%s%s%s)" % (m.group(1), self._to_proxy(session, m.group(2), css_url), m.group(1)),
            css_text,
        )

    def _shim(self, session: dict) -> str:
        prefix = self.proxy_base(session)
        origin = session.get("origin") or ""
        return """<script>(function(){
var PREFIX=%s, ORIGIN=%s;
function abs(u){try{return new URL(u, document.baseURI).href}catch(e){return u}}
function map(u){
  if(typeof u!=="string")return u;
  if(/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(u))return u;
  var a=abs(u);
  if(a.indexOf(ORIGIN)===0)return PREFIX+a.slice(ORIGIN.length);
  return u;
}
window.__crawlerProxyMap=map;
try{var of=window.fetch;if(of){window.fetch=function(input,init){
  if(typeof input==="string")input=map(input);
  else if(input&&input.url){try{input=new Request(map(input.url),input)}catch(e){}}
  return of.call(this,input,init);
};}}catch(e){}
try{var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=map(u);return xo.apply(this,arguments)};}catch(e){}
try{var ow=window.open;window.open=function(u){return ow.call(this,map(u))};}catch(e){}
})();</script>""" % (_js_string(prefix), _js_string(origin))


def _js_string(value: str) -> str:
    return '"%s"' % value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "").replace("\r", "")


def proxy_cookie_header(session: dict, header: str) -> None:
    # Kept as a module-level helper for callers that do not hold the store.
    store = ChallengeSessionStore()
    store.absorb_browser_cookies(session, header)