"""Bounded search history for debugging rules and captcha flows.

Every search (HTTP API, agent test, MCP) appends one compact record so the
agent can inspect why a site returned nothing without re-running it. Records
never include cookies or response headers; only a short text preview.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Optional

from .rules import now_iso

DEFAULT_LIMIT = 200


def _preview(text: str, size: int = 400) -> str:
    text = " ".join((text or "").split())
    return text[:size]


class SearchLogStore:
    def __init__(self, path, limit: int = DEFAULT_LIMIT):
        self.path = Path(path)
        self.limit = max(10, int(limit or DEFAULT_LIMIT))
        self._lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._entries = self._load()

    def _load(self) -> list:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)][: self.limit]

    def _save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps(self._entries, ensure_ascii=False, indent=1), encoding="utf-8")
            os.replace(tmp, self.path)
        except OSError:
            pass

    def append(self, record: dict) -> dict:
        entry = dict(record or {})
        entry["ts"] = now_iso()
        with self._lock:
            self._entries.insert(0, entry)
            del self._entries[self.limit:]
            self._save()
        return entry

    def list(
        self,
        limit: int = 50,
        site: str = "",
        failures_only: bool = False,
        source: str = "",
    ) -> list:
        size = max(1, min(200, int(limit or 50)))
        site = (site or "").strip().lower()
        out = []
        with self._lock:
            for entry in self._entries:
                if site and site not in (
                    str(entry.get("site") or "").lower(),
                    str(entry.get("siteId") or "").lower(),
                    str(entry.get("siteName") or "").lower(),
                ):
                    continue
                if failures_only and entry.get("ok"):
                    continue
                if source and entry.get("source") != source:
                    continue
                out.append(dict(entry))
                if len(out) >= size:
                    break
        return out

    def clear(self) -> int:
        with self._lock:
            count = len(self._entries)
            self._entries = []
            self._save()
        return count

    def count(self) -> int:
        with self._lock:
            return len(self._entries)

    @staticmethod
    def build_record(
        rule: dict,
        keyword: str,
        room_id: Optional[str],
        role: str,
        page: Optional[dict],
        items: list,
        skipped: int,
        error: str,
        took_ms: int,
        source: str = "search",
        repair: Optional[dict] = None,
    ) -> dict:
        page = page or {}
        parse = (rule or {}).get("parse") or {}
        request = page.get("request") or {}
        text = page.get("text") or ""
        record = {
            "source": source,
            "ok": not error,
            "siteId": (rule or {}).get("id") or "",
            "site": (rule or {}).get("site") or "",
            "siteName": (rule or {}).get("name") or "",
            "keyword": keyword,
            "roomId": room_id or "",
            "role": role or "guest",
            "mode": ((rule or {}).get("search") or {}).get("mode") or "http",
            "parseType": parse.get("type") or "html",
            "container": parse.get("container") or "",
            "count": len(items or []),
            "skipped": int(skipped or 0),
            "tookMs": int(took_ms or 0),
            "pageUrl": page.get("pageUrl") or "",
            "status": page.get("status"),
            "request": {"method": request.get("method") or "", "url": request.get("url") or ""},
            "bytes": len(text.encode("utf-8", "ignore")),
            "bodyPreview": _preview(text),
        }
        if error:
            record["error"] = error[:500]
        if repair:
            record["repair"] = {
                "attempted": bool(repair.get("attempted")),
                "success": bool(repair.get("success")),
                "error": (repair.get("error") or "")[:300],
            }
        return record
