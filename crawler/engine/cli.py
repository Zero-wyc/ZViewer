"""Command line entry point for the crawler engine.

Examples (run from the crawler/ directory):
    python -m engine serve
    python -m engine rules list
    python -m engine rules add rule.json
    python -m engine rules export -o rules-backup.json
    python -m engine rules import rules-backup.json --mode merge
    python -m engine search bilibili 流浪地球 --room R1 --role guest
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .app import Engine
from .api import ApiServer
from .config import save_config
from .errors import EngineError
from .rules import public_rule_view


def _print(value) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def _engine(args) -> Engine:
    return Engine(args.root)


def cmd_serve(args) -> int:
    engine = _engine(args)
    print("crawler root: %s" % engine.paths.root, flush=True)
    if not engine.llm_configured():
        print("提示: 还没有配置大模型 API key，agent 生成/对话不可用。", flush=True)
    if not engine.js.available():
        print("提示: 没有找到 Node.js，脚本规则不可用。", flush=True)
    ApiServer(engine, host=args.host, port=args.port).serve_forever()
    return 0


def cmd_mcp(args) -> int:
    from .mcp_server import main as mcp_main

    argv = ["--root", args.root] if args.root else []
    return mcp_main(argv)


def cmd_status(args) -> int:
    engine = _engine(args)
    _print(engine.status())
    return 0


def cmd_rules_list(args) -> int:
    engine = _engine(args)
    rules = engine.store.list()
    if args.json:
        _print({"success": True, "count": len(rules), "rules": rules})
    else:
        for rule in rules:
            print("%-24s %-20s %-28s %s" % (
                rule.get("id", ""), rule.get("name", ""), rule.get("site", ""),
                "enabled" if rule.get("enabled", True) else "disabled"))
        print("共 %d 条规则" % len(rules))
    return 0


def cmd_rules_get(args) -> int:
    _print(_engine(args).store.get(args.rule_id))
    return 0


def cmd_rules_add(args) -> int:
    engine = _engine(args)
    if args.file:
        raw = json.loads(Path(args.file).read_text(encoding="utf-8"))
    else:
        raw = json.loads(sys.stdin.read() or "{}")
    if isinstance(raw, dict) and isinstance(raw.get("rule"), dict):
        raw = raw["rule"]
    saved = engine.store.save(raw)
    _print({"success": True, "rule": public_rule_view(saved, include_parse=True)})
    return 0


def cmd_rules_delete(args) -> int:
    engine = _engine(args)
    deleted = engine.store.delete(args.rule_id)
    _print({"success": deleted, "deleted": deleted, "ruleId": args.rule_id})
    return 0 if deleted else 1


def cmd_rules_export(args) -> int:
    engine = _engine(args)
    bundle = engine.store.export_bundle(args.id or [])
    if args.out:
        path = Path(args.out)
        path.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        _print({"success": True, "path": str(path.resolve()), "count": bundle["count"]})
    else:
        _print(bundle)
    return 0


def cmd_rules_import(args) -> int:
    engine = _engine(args)
    payload = json.loads(Path(args.file).read_text(encoding="utf-8"))
    report = engine.store.import_bundle(payload, mode=args.mode, dry_run=args.dry_run)
    _print(report)
    return 0 if report["success"] else 1


def cmd_search(args) -> int:
    engine = _engine(args)
    result = engine.search.search(args.site, args.keyword, room_id=args.room,
                                  role=args.role, limit=args.limit)
    if args.json:
        _print(result)
    else:
        print("站点 %s · %s · %d 条 · %s" % (
            result.get("site", {}).get("name", args.site), args.keyword,
            result.get("count", 0), result.get("pageUrl", "")))
        for index, item in enumerate(result.get("items") or [], 1):
            print("%2d. %s\n    %s" % (index, item.get("title", ""), item.get("url", "")))
    return 0


def cmd_config_get(args) -> int:
    engine = _engine(args)
    cfg = json.loads(json.dumps(engine.config))
    key = (cfg.get("llm") or {}).get("api_key") or ""
    if key:
        cfg["llm"]["api_key"] = key[:6] + "..." + key[-4:]
    _print(cfg)
    return 0


def cmd_config_set(args) -> int:
    engine = _engine(args)
    patch = {}
    if args.api_key is not None:
        patch.setdefault("llm", {})["api_key"] = args.api_key
    if args.base_url is not None:
        patch.setdefault("llm", {})["base_url"] = args.base_url
    if args.model is not None:
        patch.setdefault("llm", {})["model"] = args.model
    if args.admin_token is not None:
        patch.setdefault("engine", {})["admin_token"] = args.admin_token
    merged = json.loads(json.dumps(engine.config))
    for section, values in patch.items():
        merged.setdefault(section, {}).update(values)
    save_config(merged, engine.paths)
    _print({"success": True, "config": {"llm": {"base_url": merged["llm"].get("base_url"),
                                               "model": merged["llm"].get("model"),
                                               "apiKeySaved": bool(merged["llm"].get("api_key"))}}})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m engine", description="ZViewer 一起看爬虫引擎")
    parser.add_argument("--root", default="", help="引擎数据目录（默认 crawler/）")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="启动 HTTP API")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    serve.set_defaults(func=cmd_serve)

    sub.add_parser("status", help="查看引擎状态").set_defaults(func=cmd_status)
    sub.add_parser("mcp", help="以 MCP stdio 服务运行（供大模型客户端调用）").set_defaults(func=cmd_mcp)

    rules = sub.add_parser("rules", help="规则管理")
    rules_sub = rules.add_subparsers(dest="rules_command", required=True)
    rules_list = rules_sub.add_parser("list", help="列出规则")
    rules_list.add_argument("--json", action="store_true")
    rules_list.set_defaults(func=cmd_rules_list)
    rules_get = rules_sub.add_parser("get", help="查看单条规则")
    rules_get.add_argument("rule_id")
    rules_get.set_defaults(func=cmd_rules_get)
    rules_add = rules_sub.add_parser("add", help="手动添加规则（JSON 文件或 stdin）")
    rules_add.add_argument("--file", default="")
    rules_add.set_defaults(func=cmd_rules_add)
    rules_delete = rules_sub.add_parser("delete", help="删除规则")
    rules_delete.add_argument("rule_id")
    rules_delete.set_defaults(func=cmd_rules_delete)
    rules_export = rules_sub.add_parser("export", help="一键导出全部规则")
    rules_export.add_argument("-o", "--out", default="", help="输出文件；留空打印到 stdout")
    rules_export.add_argument("--id", action="append", help="只导出指定规则 id，可重复")
    rules_export.set_defaults(func=cmd_rules_export)
    rules_import = rules_sub.add_parser("import", help="一键导入规则")
    rules_import.add_argument("file")
    rules_import.add_argument("--mode", choices=("merge", "replace"), default="merge")
    rules_import.add_argument("--dry-run", action="store_true")
    rules_import.set_defaults(func=cmd_rules_import)

    search = sub.add_parser("search", help="按站点规则搜索")
    search.add_argument("site")
    search.add_argument("keyword")
    search.add_argument("--room", default="")
    search.add_argument("--role", default="root")
    search.add_argument("--limit", type=int, default=None)
    search.add_argument("--json", action="store_true")
    search.set_defaults(func=cmd_search)

    config = sub.add_parser("config", help="查看/修改配置")
    config_sub = config.add_subparsers(dest="config_command", required=True)
    config_get = config_sub.add_parser("get", help="查看配置（API key 掩码）")
    config_get.set_defaults(func=cmd_config_get)
    config_set = config_sub.add_parser("set", help="修改配置")
    config_set.add_argument("--api-key", dest="api_key", default=None)
    config_set.add_argument("--base-url", dest="base_url", default=None)
    config_set.add_argument("--model", default=None)
    config_set.add_argument("--admin-token", dest="admin_token", default=None)
    config_set.set_defaults(func=cmd_config_set)
    return parser


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args) or 0)
    except EngineError as exc:
        print(json.dumps(exc.to_dict(), ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
