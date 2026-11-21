"""Rule persistence: one JSON file per site under data/rules."""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from .errors import RuleError, RuleNotFound
from .rules import (
    default_stats,
    host_of,
    now_iso,
    rule_matches_host,
    validate_rule,
)


def slugify(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value[:48].strip("-")


def rule_visible_to(rule: dict, room_id: Optional[str] = None, role: str = "guest") -> bool:
    """Visibility model shared by the engine, HTTP API and MCP tools.

    - disabled rules are invisible to everyone except admin listing endpoints
    - visibility=root only for root
    - allowed_rooms empty means all rooms; otherwise the room must be listed
    """
    if not rule.get("enabled", True):
        return False
    role = (role or "guest").lower()
    if role == "root":
        return True
    if (rule.get("visibility") or "public") == "root":
        return False
    allowed = rule.get("allowed_rooms") or []
    if allowed and (not room_id or room_id not in allowed):
        return False
    return True


class RuleStore:
    def __init__(self, rules_dir):
        self.dir = Path(rules_dir).resolve()
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def _path(self, rule_id: str) -> Path:
        return self.dir / ("%s.json" % rule_id)

    def _read_file(self, path: Path) -> dict:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuleError("规则文件损坏 %s: %s" % (path.name, exc)) from exc
        if not isinstance(data, dict):
            raise RuleError("规则文件必须是 JSON 对象: %s" % path.name)
        data.setdefault("id", path.stem)
        return data

    def list(self, include_disabled: bool = True) -> list:
        rules = []
        with self._lock:
            for path in sorted(self.dir.glob("*.json")):
                try:
                    rule = self._read_file(path)
                except RuleError:
                    continue
                if not include_disabled and not rule.get("enabled", True):
                    continue
                rules.append(rule)
        rules.sort(key=lambda item: (item.get("name") or item.get("id") or "").lower())
        return rules

    def get(self, rule_id: str) -> dict:
        rule_id = (rule_id or "").strip()
        if not rule_id or "/" in rule_id or "\\" in rule_id:
            raise RuleNotFound(rule_id)
        path = self._path(rule_id)
        if not path.exists():
            raise RuleNotFound(rule_id)
        with self._lock:
            return self._read_file(path)

    def find_by_site(self, site: str) -> Optional[dict]:
        host = host_of(site)
        if not host:
            return None
        candidates = []
        for rule in self.list(include_disabled=False):
            if rule_matches_host(rule, host):
                candidates.append(rule)
        if not candidates:
            return None
        candidates.sort(key=lambda rule: 0 if host_of(rule.get("site") or "") == host else 1)
        return candidates[0]

    def _unique_id(self, base: str) -> str:
        base = slugify(base) or "site"
        candidate = base
        index = 2
        while self._path(candidate).exists():
            candidate = "%s-%d" % (base, index)
            index += 1
        return candidate

    def save(self, raw_rule: dict, rule_id: Optional[str] = None) -> dict:
        rule = validate_rule(raw_rule)
        with self._lock:
            existing = None
            if rule_id:
                existing_id = slugify(rule_id)
                if existing_id and self._path(existing_id).exists():
                    existing = self._read_file(self._path(existing_id))
            elif raw_rule.get("id"):
                maybe_id = slugify(str(raw_rule.get("id")))
                if maybe_id and self._path(maybe_id).exists():
                    existing = self._read_file(self._path(maybe_id))
            if existing:
                rule["id"] = existing["id"]
                rule["created_at"] = existing.get("created_at") or rule["created_at"]
                rule["created_by"] = existing.get("created_by") or rule["created_by"]
                try:
                    rule["version"] = int(existing.get("version") or 1) + 1
                except (TypeError, ValueError):
                    rule["version"] = 2
                rule["stats"] = existing.get("stats") or default_stats()
            else:
                base = raw_rule.get("id") or rule.get("name") or rule.get("site") or "site"
                rule["id"] = self._unique_id(str(base))
                rule["version"] = 1
                rule["stats"] = default_stats()
            rule["updated_at"] = now_iso()
            self._write(rule)
            return rule

    def update(self, rule_id: str, patch: dict) -> dict:
        current = self.get(rule_id)
        merged = dict(current)
        for key, value in (patch or {}).items():
            if key in ("id", "created_at", "created_by", "stats"):
                continue
            if key in ("search", "parse") and isinstance(value, dict):
                section = dict(current.get(key) or {})
                section.update(value)
                merged[key] = section
            else:
                merged[key] = value
        return self.save(merged, rule_id=current["id"])

    def delete(self, rule_id: str) -> bool:
        with self._lock:
            path = self._path((rule_id or "").strip())
            if not path.exists():
                return False
            try:
                path.unlink()
            except OSError as exc:
                raise RuleError("删除规则失败: %s" % exc) from exc
            return True

    def record_search(self, rule_id: str, ok: bool, error: Optional[str] = None) -> None:
        with self._lock:
            try:
                path = self._path(rule_id)
                if not path.exists():
                    return
                rule = self._read_file(path)
            except RuleError:
                return
            stats = default_stats()
            stats.update(rule.get("stats") or {})
            stats["searches"] = int(stats.get("searches") or 0) + 1
            if ok:
                stats["successes"] = int(stats.get("successes") or 0) + 1
                stats["last_error"] = None
            else:
                stats["failures"] = int(stats.get("failures") or 0) + 1
                stats["last_error"] = (error or "")[:500] or "unknown"
            stats["last_used_at"] = now_iso()
            rule["stats"] = stats
            try:
                self._write(rule)
            except Exception:
                pass

    def export_bundle(self, rule_ids: Optional[list] = None) -> dict:
        """One-click export: a portable JSON bundle of full rule documents."""
        wanted = {str(item).strip() for item in (rule_ids or []) if str(item).strip()}
        rules = []
        for rule in self.list(include_disabled=True):
            if wanted and rule.get("id") not in wanted:
                continue
            rules.append(rule)
        return {
            "format": 1,
            "kind": "zviewer-crawler-rules",
            "exported_at": now_iso(),
            "count": len(rules),
            "rules": rules,
        }

    def import_bundle(self, payload, mode: str = "merge", dry_run: bool = False) -> dict:
        """Import rules from a bundle or a bare list.

        merge (default): update rules whose id/name+site already exists, add the rest.
        replace: delete existing rules first, then import everything.
        """
        if isinstance(payload, dict):
            incoming = payload.get("rules")
        else:
            incoming = payload
        if not isinstance(incoming, list):
            raise RuleError("导入内容必须包含 rules 数组")
        mode = (mode or "merge").lower()
        if mode not in ("merge", "replace"):
            raise RuleError("导入模式只能是 merge 或 replace")
        report = {"success": True, "mode": mode, "dryRun": bool(dry_run),
                  "total": len(incoming), "imported": 0, "updated": 0,
                  "skipped": 0, "failed": 0, "items": []}
        if mode == "replace" and not dry_run:
            for rule in self.list(include_disabled=True):
                try:
                    self.delete(rule.get("id") or "")
                except RuleError:
                    pass
        for index, raw in enumerate(incoming):
            label = ""
            try:
                if not isinstance(raw, dict):
                    raise RuleError("规则必须是 JSON 对象")
                label = str(raw.get("name") or raw.get("id") or ("第 %d 条" % (index + 1)))
                candidate = dict(raw)
                incoming_id = str(candidate.get("id") or "").strip()
                existing = None
                if incoming_id:
                    try:
                        existing = self.get(slugify(incoming_id))
                    except RuleNotFound:
                        existing = None
                if existing is None:
                    host = host_of(str(candidate.get("site") or ""))
                    name = str(candidate.get("name") or "").strip()
                    for item in self.list(include_disabled=True):
                        if name and item.get("name") == name and host_of(str(item.get("site") or "")) == host:
                            existing = item
                            break
                if dry_run:
                    validate_rule(candidate)
                    if existing:
                        report["updated"] += 1
                        action = "update"
                    else:
                        report["imported"] += 1
                        action = "create"
                elif existing:
                    saved = self.save(candidate, rule_id=existing["id"])
                    report["updated"] += 1
                    action = "update"
                else:
                    saved = self.save(candidate)
                    report["imported"] += 1
                    action = "create"
                report["items"].append({"name": label, "action": action,
                                        "ruleId": (existing or {}).get("id") if dry_run else saved["id"]})
            except (RuleError, RuleNotFound) as exc:
                report["failed"] += 1
                report["items"].append({"name": label, "action": "failed", "error": str(exc)})
        if report["failed"]:
            report["success"] = False
        return report

    def _write(self, rule: dict) -> None:
        path = self._path(rule["id"])
        tmp = path.with_suffix(".json.tmp")
        payload = json.dumps(rule, ensure_ascii=False, indent=2) + "\n"
        tmp.write_text(payload, encoding="utf-8")
        os.replace(tmp, path)
