"""Configuration loading for the crawler engine.

Config lives in crawler/config.json. Environment variables override a few
values so the packaged runtime does not need to rewrite the JSON file.
"""
from __future__ import annotations

import copy
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from .errors import ConfigError


DEFAULT_CONFIG = {
    "llm": {
        "base_url": "https://api.deepseek.com/v1",
        "api_key": "",
        "model": "deepseek-chat",
        "temperature": 0.1,
        "max_tokens": 2048,
        "timeout_sec": 90,
        # OpenAI 兼容的思考强度：空字符串表示不传，交给服务端默认。
        # 可选 low / medium / high（部分服务商还支持 minimal / max）。
        "reasoning_effort": "",
    },
    "engine": {
        "host": "127.0.0.1",
        "port": 3789,
        "admin_token": "",
        "request_timeout_sec": 25,
        "max_bytes": 3145728,
        "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "max_concurrent": 2,
        "node_bin": "",
        "script_timeout_sec": 20,
    },
    # 离屏浏览器：agent 通过 CDP 打开/读取/操作页面；人工可切到可见窗口登录。
    "browser": {
        "enabled": True,
        "bin": "",
        "debug_port": 9333,
        "profile_dir": "",
        "page_timeout_sec": 25,
        "user_agent": "",
    },
    # Agent 对话的步数上限：0 = 工具调用次数不设上限；正数才会在达到步数后截断。
    # 需要用户确认时模型会调用 ask_user 暂停本轮；模型提前停顿时最多自动追几次由 auto_continue 控制。
    "agent": {
        "max_steps": 0,
        "auto_continue": 2,
        # GUI 设置页可编辑：追加到 Agent 系统提示词末尾的额外指令（最多 4000 字）。
        "custom_prompt": "",
    },
    "generation": {
        "max_steps": 12,
        "max_page_chars": 6000,
        "sample_keyword": "电影",
        # GUI 手动触发「生成规则」时使用的思考强度。
        "reasoning_effort": "",
    },
    # 成员在一起看页面提交的新站点：auto_generate 打开后，
    # 提交进入队列即自动调用 LLM agent 生成规则。
    "submissions": {
        "auto_generate": False,
        # 成员提交站点后自动生成规则的思考强度（与 Agent 会话独立）。
        "reasoning_effort": "",
    },
    # 规则解析失败时自动交给大模型修复：同一规则在冷却期内最多修一次，
    # 修复后用原关键词重试一次搜索。没有配置 LLM api_key 时自动跳过。
    "repair": {
        "enabled": True,
        "cooldown_sec": 600,
    },
}


@dataclass
class Paths:
    root: Path
    config_file: Path
    data_dir: Path
    rules_dir: Path

    @classmethod
    def detect(cls, root: Optional[str] = None) -> "Paths":
        base = Path(root).resolve() if root else Path(__file__).resolve().parents[1]
        return cls(
            root=base,
            config_file=base / "config.json",
            data_dir=base / "data",
            rules_dir=base / "data" / "rules",
        )


def _deep_merge(base: dict, override: dict) -> dict:
    result = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


def _env_overrides(cfg: dict) -> dict:
    llm = cfg.setdefault("llm", {})
    engine = cfg.setdefault("engine", {})
    if os.environ.get("CRAWLER_LLM_API_KEY"):
        llm["api_key"] = os.environ["CRAWLER_LLM_API_KEY"]
    if os.environ.get("CRAWLER_LLM_BASE_URL"):
        llm["base_url"] = os.environ["CRAWLER_LLM_BASE_URL"]
    if os.environ.get("CRAWLER_LLM_MODEL"):
        llm["model"] = os.environ["CRAWLER_LLM_MODEL"]
    if os.environ.get("CRAWLER_ADMIN_TOKEN"):
        engine["admin_token"] = os.environ["CRAWLER_ADMIN_TOKEN"]
    if os.environ.get("CRAWLER_HOST"):
        engine["host"] = os.environ["CRAWLER_HOST"]
    if os.environ.get("CRAWLER_PORT"):
        engine["port"] = int(os.environ["CRAWLER_PORT"])
    return cfg


def load_config(paths: Optional[Paths] = None, root: Optional[str] = None) -> dict:
    paths = paths or Paths.detect(root)
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    if paths.config_file.exists():
        try:
            raw = json.loads(paths.config_file.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ConfigError("读取配置失败: %s" % exc) from exc
        if not isinstance(raw, dict):
            raise ConfigError("config.json 必须是 JSON 对象")
        cfg = _deep_merge(cfg, raw)
    return _env_overrides(cfg)


def save_config(cfg: dict, paths: Optional[Paths] = None, root: Optional[str] = None) -> None:
    paths = paths or Paths.detect(root)
    paths.root.mkdir(parents=True, exist_ok=True)
    tmp = paths.config_file.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, paths.config_file)


def mask_secret(value: str) -> str:
    value = value or ""
    if len(value) <= 8:
        return "已设置" if value else "未设置"
    return value[:4] + "..." + value[-4:]
