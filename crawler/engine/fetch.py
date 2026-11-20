"""Small HTTP fetcher with charset detection, gzip and retries."""
from __future__ import annotations

import gzip
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
from typing import Optional

from .errors import FetchError


_CHARSET_HEADER_RE = re.compile(r"charset=\"?([\w.-]+)", re.I)
_META_CHARSET_RE = re.compile(
    rb"<meta[^>]+charset=[\"']?\s*([\w.-]+)", re.I
)


@dataclass
class FetchResult:
    status: int
    url: str
    headers: dict = field(default_factory=dict)
    text: str = ""
    raw: bytes = b""
    encoding: str = "utf-8"


def _detect_encoding(headers: dict, raw: bytes) -> str:
    content_type = headers.get("content-type", "")
    match = _CHARSET_HEADER_RE.search(content_type)
    if match:
        return match.group(1).lower()
    match = _META_CHARSET_RE.search(raw[:8192])
    if match:
        try:
            return match.group(1).decode("ascii", "ignore").lower()
        except Exception:
            pass
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return "utf-16"
    return "utf-8"


class Fetcher:
    def __init__(
        self,
        timeout: float = 25,
        max_bytes: int = 3 * 1024 * 1024,
        user_agent: str = "",
        retries: int = 1,
        insecure_tls: bool = False,
    ):
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.user_agent = user_agent or "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        self.retries = max(0, retries)
        self.insecure_tls = insecure_tls
        self._opener = self._build_opener()

    def _build_opener(self):
        handlers = []
        if self.insecure_tls:
            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
            handlers.append(urllib.request.HTTPSHandler(context=context))
        return urllib.request.build_opener(*handlers)

    def fetch(
        self,
        url: str,
        method: str = "GET",
        headers: Optional[dict] = None,
        body: Optional[bytes] = None,
        timeout: Optional[float] = None,
    ) -> FetchResult:
        url = (url or "").strip()
        if not url:
            raise FetchError("URL 为空")
        if not re.match(r"^https?://", url, re.I):
            raise FetchError("仅支持 http/https URL: %s" % url)
        request_headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
            "Accept-Encoding": "gzip, deflate",
        }
        for key, value in (headers or {}).items():
            if value is not None:
                request_headers[str(key)] = str(value)
        attempt = 0
        last_error: Optional[Exception] = None
        while attempt <= self.retries:
            attempt += 1
            try:
                return self._fetch_once(url, method, request_headers, body, timeout)
            except FetchError as exc:
                last_error = exc
                if exc.status and exc.status < 500 and exc.status != 429:
                    raise
                if attempt > self.retries:
                    raise
                time.sleep(0.6 * attempt)
            except Exception as exc:  # noqa: BLE001 - converted to FetchError
                last_error = exc
                if attempt > self.retries:
                    raise FetchError("请求失败: %s" % exc, url=url) from exc
                time.sleep(0.6 * attempt)
        raise FetchError("请求失败: %s" % last_error, url=url)

    def _fetch_once(self, url, method, headers, body, timeout) -> FetchResult:
        request = urllib.request.Request(url, data=body, method=method.upper())
        for key, value in headers.items():
            request.add_header(key, value)
        try:
            response = self._opener.open(request, timeout=timeout or self.timeout)
        except urllib.error.HTTPError as exc:
            snippet = b""
            try:
                snippet = exc.read(2048)
            except Exception:
                pass
            raise FetchError(
                "HTTP %s" % exc.code,
                status=exc.code,
                url=url,
                details={"snippet": snippet.decode("utf-8", "replace")},
            ) from exc
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            raise FetchError("连接失败: %s" % reason, url=url) from exc
        with response:
            raw = response.read(self.max_bytes + 1)
            if len(raw) > self.max_bytes:
                raw = raw[: self.max_bytes]
            headers_out = {key.lower(): value for key, value in response.headers.items()}
            encoding = _detect_encoding(headers_out, raw)
            raw = self._decode_content(headers_out, raw)
            try:
                text = raw.decode(encoding, "replace")
            except LookupError:
                encoding = "utf-8"
                text = raw.decode("utf-8", "replace")
            return FetchResult(
                status=getattr(response, "status", 200),
                url=response.geturl(),
                headers=headers_out,
                text=text,
                raw=raw,
                encoding=encoding,
            )

    @staticmethod
    def _decode_content(headers: dict, raw: bytes) -> bytes:
        encoding = (headers.get("content-encoding") or "").lower()
        try:
            if "gzip" in encoding:
                return gzip.decompress(raw)
            if "deflate" in encoding:
                try:
                    return zlib.decompress(raw)
                except zlib.error:
                    return zlib.decompress(raw, -zlib.MAX_WBITS)
        except Exception:
            return raw
        return raw


def quote_keyword(keyword: str, encoding: str = "utf-8") -> str:
    return urllib.parse.quote((keyword or "").strip(), safe="", encoding=encoding)
