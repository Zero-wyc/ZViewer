"""Account/credential profiles used by rules that need login cookies.

Stored in data/accounts.json (chmod 600). Only root/administrator tools can read
the secrets; list views mask them.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

from .errors import RuleError


SENSITIVE_HEADERS = {"cookie", "authorization", "x-csrf-token", "token"}


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _slug(value: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", (value or "").strip().lower()).strip("-")
    return value[:40].strip("-") or "account"


def mask_secret(value: str) -> str:
    value = value or ""
    if not value:
        return ""
    if len(value) <= 8:
        return "已设置"
    return value[:4] + "..." + value[-4:]


class AccountStore:
    def __init__(self, path):
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _read(self) -> list:
        if not self.path.exists():
            return []
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuleError("账号文件损坏: %s" % exc) from exc
        if isinstance(data, dict):
            data = data.get("accounts") or []
        return [item for item in data if isinstance(item, dict)]

    def _write(self, accounts: list) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"accounts": accounts}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    @staticmethod
    def public_view(account: dict, mask: bool = True) -> dict:
        headers = account.get("headers") or {}
        view = {
            "id": account.get("id"),
            "name": account.get("name") or account.get("id"),
            "site": account.get("site") or "",
            "username": account.get("username") or "",
            "notes": account.get("notes") or "",
            "hasCookies": bool(account.get("cookies")),
            "hasPassword": bool(account.get("password")),
            "headerKeys": sorted(headers.keys()),
            "createdAt": account.get("created_at"),
            "updatedAt": account.get("updated_at"),
        }
        if not mask:
            view["cookies"] = account.get("cookies") or ""
            view["password"] = account.get("password") or ""
            view["headers"] = headers
        else:
            view["cookies"] = mask_secret(account.get("cookies") or "")
            view["headers"] = {
                key: (mask_secret(value) if key.lower() in SENSITIVE_HEADERS else value)
                for key, value in headers.items()
            }
        return view

    def list(self, mask: bool = True) -> list:
        with self._lock:
            accounts = self._read()
        return [self.public_view(item, mask=mask) for item in accounts]

    def get(self, account_id: str) -> Optional[dict]:
        with self._lock:
            for item in self._read():
                if item.get("id") == account_id:
                    return item
        return None

    def require(self, account_id: str) -> dict:
        account = self.get(account_id)
        if account is None:
            raise RuleError("账号不存在: %s" % account_id)
        return account

    def save(self, raw: dict) -> dict:
        if not isinstance(raw, dict):
            raise RuleError("账号必须是 JSON 对象")
        with self._lock:
            accounts = self._read()
            account_id = _slug(str(raw.get("id") or raw.get("name") or raw.get("site") or "account"))
            existing = None
            for item in accounts:
                if item.get("id") == account_id:
                    existing = item
                    break
            account = {
                "id": account_id,
                "name": (raw.get("name") or (existing or {}).get("name") or account_id).strip(),
                "site": (raw.get("site") or (existing or {}).get("site") or "").strip().lower(),
                "username": (raw.get("username") if raw.get("username") is not None else (existing or {}).get("username") or "").strip(),
                "password": raw.get("password") if raw.get("password") is not None else (existing or {}).get("password") or "",
                "cookies": raw.get("cookies") if raw.get("cookies") is not None else (existing or {}).get("cookies") or "",
                "headers": raw.get("headers") if raw.get("headers") is not None else (existing or {}).get("headers") or {},
                "notes": (raw.get("notes") if raw.get("notes") is not None else (existing or {}).get("notes") or "").strip(),
                "created_at": (existing or {}).get("created_at") or _now(),
                "updated_at": _now(),
            }
            if not isinstance(account["headers"], dict):
                raise RuleError("账号 headers 必须是对象")
            account["headers"] = {str(k): str(v) for k, v in account["headers"].items()}
            if existing:
                index = accounts.index(existing)
                accounts[index] = account
            else:
                accounts.append(account)
            self._write(accounts)
            return account

    def delete(self, account_id: str) -> bool:
        with self._lock:
            accounts = self._read()
            remaining = [item for item in accounts if item.get("id") != account_id]
            if len(remaining) == len(accounts):
                return False
            self._write(remaining)
            return True

    def resolve(self, account_id: str) -> dict:
        if not account_id:
            return {}
        account = self.require(account_id)
        return {
            "id": account.get("id"),
            "username": account.get("username") or "",
            "password": account.get("password") or "",
            "cookies": account.get("cookies") or "",
            "headers": account.get("headers") or {},
        }
