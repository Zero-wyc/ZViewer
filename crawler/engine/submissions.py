"""Member-submitted sites waiting for a crawler rule (stdlib only).

The Go backend forwards together-watch member submissions here. The GUI lists
them and can ask the LLM agent to generate a rule, either manually or
automatically (config: submissions.auto_generate).
"""
from __future__ import annotations

import json
import os
import secrets
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from .errors import RuleError

STATUSES = ("pending", "queued", "processing", "done", "failed", "ignored")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _host(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def _slug(value: str) -> str:
    text = "".join(ch if ch.isalnum() else "-" for ch in (value or "").lower())
    while "--" in text:
        text = text.replace("--", "-")
    return text.strip("-") or "site"


class SubmissionStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # 后台生成线程与 API 线程都会写同一个文件，必须串行化读改写。
        self._lock = threading.RLock()
        if not self.path.exists():
            self._write([])

    def _read(self) -> list:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if isinstance(raw, dict):
            raw = raw.get("submissions")
        return [item for item in (raw or []) if isinstance(item, dict)]

    def _write(self, items: list) -> None:
        payload = json.dumps({"submissions": items}, ensure_ascii=False, indent=2) + "\n"
        fd, tmp_name = tempfile.mkstemp(
            prefix=".submissions-", suffix=".tmp", dir=str(self.path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            for attempt in range(5):
                try:
                    os.replace(tmp_name, self.path)
                    return
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.05 * (attempt + 1))
        finally:
            try:
                if os.path.exists(tmp_name):
                    os.unlink(tmp_name)
            except OSError:
                pass

    def list(self, status: Optional[str] = None, limit: int = 200) -> list:
        items = sorted(self._read(), key=lambda item: item.get("createdAt") or "", reverse=True)
        if status:
            items = [item for item in items if item.get("status") == status]
        try:
            limit = max(1, min(int(limit or 200), 500))
        except (TypeError, ValueError):
            limit = 200
        return items[:limit]

    def get(self, submission_id: str) -> Optional[dict]:
        for item in self._read():
            if item.get("id") == submission_id:
                return item
        return None

    def add(self, payload: dict) -> dict:
        url = str(payload.get("url") or "").strip()
        if not url:
            raise RuleError("缺少站点 URL")
        if not (url.startswith("http://") or url.startswith("https://")):
            url = "https://" + url
        host = _host(url)
        if not host or "." not in host:
            raise RuleError("站点 URL 不合法")
        name = str(payload.get("name") or "").strip() or host
        keyword = str(payload.get("keyword") or "").strip()
        room_id = str(payload.get("roomId") or payload.get("room_id") or "").strip()
        room_name = str(payload.get("roomName") or payload.get("room_name") or "").strip()
        submitted_by = str(payload.get("submittedBy") or payload.get("submitted_by") or "").strip()
        note = str(payload.get("note") or "").strip()
        with self._lock:
            items = self._read()
            for item in items:
                if item.get("site") == host and item.get("status") in ("pending", "queued", "processing", "done"):
                    return {**item, "duplicate": True}
            stamp = _now()
            submission = {
                "id": "sub-" + time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3),
                "url": url,
                "site": host,
                "name": name,
                "keyword": keyword,
                "roomId": room_id,
                "roomName": room_name,
                "submittedBy": submitted_by,
                "note": note,
                "status": "pending",
                "sessionId": "",
                "ruleId": "",
                "ruleName": "",
                "error": "",
                "createdAt": stamp,
                "updatedAt": stamp,
            }
            items.append(submission)
            self._write(items)
            return {**submission, "duplicate": False}

    def update(self, submission_id: str, patch: dict) -> dict:
        with self._lock:
            items = self._read()
            for index, item in enumerate(items):
                if item.get("id") != submission_id:
                    continue
                merged = dict(item)
                merged.update({key: value for key, value in (patch or {}).items() if key != "id"})
                merged["id"] = submission_id
                merged["updatedAt"] = _now()
                items[index] = merged
                self._write(items)
                return merged
        raise RuleError("提交记录不存在: %s" % submission_id)

    def delete(self, submission_id: str) -> bool:
        with self._lock:
            items = self._read()
            kept = [item for item in items if item.get("id") != submission_id]
            if len(kept) == len(items):
                return False
            self._write(kept)
            return True


def public_submission(item: dict) -> dict:
    allowed = (
        "id", "url", "site", "name", "keyword", "roomId", "roomName",
        "submittedBy", "note", "status", "sessionId", "runId", "ruleId", "ruleName", "error",
        "createdAt", "updatedAt",
    )
    return {key: item.get(key) for key in allowed}