"""Tool registry shared by the LLM agent and the MCP server.

Every tool returns a JSON-serialisable dict. Errors are returned as
{"success": false, "code": ..., "error": ...} instead of raising, so both
OpenAI-style function calling and MCP tools/call can forward them verbatim.
"""
from __future__ import annotations

import json
from typing import Callable, Optional
from urllib.parse import urljoin

from .challenge import generic_signals
from .dom import parse_html, select_all, select_one
from .errors import EngineError
from .fetch import Fetcher, quote_keyword
from .rules import public_rule_view, validate_rule
from .search import SearchService
from .store import RuleStore, rule_visible_to


RULE_GUIDE = """规则是一个 JSON 对象，结构如下：
{
  "name": "站点名称",
  "site": "example.com",
  "aliases": ["www.example.com"],
  "enabled": true,
  "visibility": "public",            // public=所有人可用，root=仅管理员
  "allowed_rooms": [],               // 空数组=所有房间；否则为房间 ID 列表
  "description": "说明",
  "search": {
    "mode": "http",
    "request": {
      "method": "GET",
      "url": "https://example.com/search?q={keyword}",
      "headers": {"User-Agent": "..."},
      "body": "",                    // POST 时的请求体，可含 {keyword}
      "body_type": "form"            // form 或 json
    },
    "encoding": "utf-8"
  },
  "parse": {
    "type": "html",                  // html 或 json
    "container": ".result-item",     // 每条结果的选择器
    "fields": {
      "title": {"selector": ".title", "attr": "text"},
      "url": {"selector": "a", "attr": "href", "absolute": true},
      "cover": {"selector": "img", "attr": "src", "absolute": true},
      "description": {"selector": ".desc", "attr": "text"}
    },
    "dedupe_by": "url",
    "limit": 30
  },
  "play": {                          // 可选：把详情页解析成可播放地址（一起看播放用）
    "headers": {"Referer": "https://example.com/"},
    "play_url_regex": "vodplay/(?P<vodId>\\d+)-(?P<playFrom>[a-z0-9]+)-(?P<index>\\d+)\\.html",
    "api": {                         // 站点自己的播放接口（模板用上面的命名捕获组）
      "url": "https://example.com/api/play?vodId={vodId}&from={playFrom}&index={index}",
      "headers": {"Referer": "https://example.com/"},
      "skipFrom": ["bilibili", "qq"] // 可选：跳过会返回限时地址的会员线路
    },
    "script": {"runtime": "node", "source": "..."}  // 可选：脚本直接调 /api/* 拿地址（反爬站点）
  },
  "challenge": {                     // 可选：站点返回人机验证页时如何识别
    "enabled": true,
    "url_contains": ["captcha", "/verify"],
    "statuses": [403, 429],
    "selectors": ["#captcha", ".verify-box"],
    "title_contains": ["安全验证"],
    "keywords": ["验证码", "人机验证"],
    "wait_selector": ".result-item", // 人工验证完成后出现的结果选择器（可选）
    "wait_seconds": 0,               // 等待用户完成验证的最长秒数（可选）
    "note": "说明"
  }
}
JSON 站点把 parse.type 设为 "json"，用 "list_path": "data.list" 取列表，
fields 里用 {"path": "title"} 取值。选择器支持 tag/#id/.class/[attr]、
后代与 > 子代、逗号分组、:first-child/:last-child/:nth-child/:contains/:not。
url 与 cover 默认 absolute=true。

脚本规则（适合需要签名/加密/JS 渲染/自定义请求的站点，运行在本机 Node.js 沙箱）：
- 搜索：search.mode="script"，search.script={"runtime":"node","source":"...","timeout_sec":20}。
  入参 input={keyword,site,rule,account}；可返回 {request:{url,method,headers,body}} 交给引擎抓取，
  也可直接返回 {items:[{title,url,cover,description,duration,author}]}。
- 解析：parse.type="script"，parse.script={"runtime":"node","source":"..."}；
  入参 {html,url,keyword,rule,account}，返回 {items:[...]}。
- 脚本内可直接用 fetch/URL/URLSearchParams/TextEncoder/TextDecoder/atob/btoa，用 return 返回结果，console.log 会回传。
- 账号：rule.search.account_id 绑定账号库；HTTP 模式自动合并 account.headers 与 Cookie 头，脚本内用 input.account 读取。
  绑定账号需经用户同意（绑定即授权引擎在该规则的搜索、播放解析与 test_play 中使用该账号 Cookie）；不要自行绑定，也不要把账号用于其他站点。

页面需要登录或由 JS 动态渲染时，用离屏浏览器工具：
- browser_open(url) 用无头浏览器打开页面，browser_text/browser_html/browser_eval 读取渲染后的内容。
- 遇到登录墙时，由你决定是否调用 browser_show(url) 把浏览器窗口显示给用户人工登录；
  登录完成后调用 browser_save_login(site, name) 把 Cookie 存成账号，再用 bind_account 绑定到规则。
  之后可以调用 browser_hide() 把窗口收回后台。不要把密码写进规则或对话。
- 站点规则解析仍在后端执行；浏览器只用于生成/调试规则。

播放解析（play 段，让「全网搜片」的结果能直接加入一起看）：
- 搜索结果 url 通常是详情页，play 段负责把它变成 m3u8/mp4/flv 地址。解析顺序：play.script → play.api → 页面里的直链 → 播放页直链 → 受控浏览器嗅探。
- play.script（最优先，运行在 Node 沙箱）：入参 {pageUrl,site,rule,headers,account}（account 仅在规则绑定账号时非空），自己 fetch 站点接口选线路，返回 {url,format,title,headers,episodes:[{name,url}],note}。站点有多档清晰度（标清/高清/1080P/蓝光等）时再返回 qualities:[{name,url,format?,headers?}]——name 用站点自己的叫法，url 仍是默认档，播放器会让用户自己切；能拿到几档就给几档，不要编造。
- 找清晰度（qualities）的常见位置：站点播放接口里表示画质的参数（qn / definition / defn / quality / clarity / p）、播放器初始化 JSON 或页面上的清晰度按钮列表、多路播放地址（不同线路/不同码率）。一条 m3u8 主列表内部的自适应码率不需要 qualities，只有站点给出多个独立地址时才返回多档。
- 档位名照抄站点文案（如「蓝光1080P」「高清」「标清」）；测试时用 test_play 返回的 qualities 核对档位名和地址都能拉起来，不确定的档位宁可不给。
- play.api：用 play_url_regex 的命名捕获组填 api.url 模板，逐条线路请求；返回 {mode:"native",url} 或 {mode:"iframe",url}。带 auth/token/expires 等签名的地址容易过期，可用 skipFrom 跳过会员线路。play.api 本身不支持多档清晰度，站点有多档地址时改用 play.script。
- 用 test_play(detail_url, rule?) 验证：success=true 且 url 可拉才算通过；iframe 只说明站点不允许直接播放；返回里的 qualities 是解析器整理过的档位列表（含默认档）。规则绑定了账号时，test_play 会带上该账号的 Cookie 与请求头（用户绑定即同意），可用来验证会员/登录后才可用的线路。
- 只给确实能播放的站点加 play 段；纯元数据站（豆瓣等）不要编造，直接说明不可播放。"""


def _err(exc: Exception) -> dict:
    if isinstance(exc, EngineError):
        return exc.to_dict()
    return {"success": False, "code": "internal_error", "error": str(exc)}


class Tool:
    def __init__(self, name: str, description: str, input_schema: dict, handler: Callable):
        self.name = name
        self.description = description
        self.input_schema = input_schema
        self.handler = handler

    def openai_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }

    def mcp_schema(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
        }


class ToolRegistry:
    def __init__(self):
        self._tools: dict = {}

    def register(self, name, description, input_schema, handler) -> None:
        self._tools[name] = Tool(name, description, input_schema, handler)

    def has(self, name: str) -> bool:
        return name in self._tools

    def names(self) -> list:
        return sorted(self._tools)

    def call(self, name: str, arguments: dict) -> dict:
        tool = self._tools.get(name)
        if tool is None:
            return {"success": False, "code": "unknown_tool", "error": "未知工具: %s" % name}
        try:
            result = tool.handler(**(arguments or {}))
            if not isinstance(result, dict):
                return {"success": True, "result": result}
            return result
        except TypeError as exc:
            return {"success": False, "code": "bad_arguments", "error": "工具参数错误: %s" % exc}
        except Exception as exc:  # noqa: BLE001
            return _err(exc)

    def openai_tools(self) -> list:
        return [tool.openai_schema() for tool in self._tools.values()]

    def mcp_tools(self) -> list:
        return [tool.mcp_schema() for tool in self._tools.values()]


def _page_summary(fetcher: Fetcher, url: str, max_chars: int) -> dict:
    response = fetcher.fetch(url)
    root = parse_html(response.text)
    title_node = select_one(root, "title")
    title = title_node.text() if title_node else ""
    desc_node = select_one(root, 'meta[name="description"]')
    description = (desc_node.get("content") if desc_node else "") or ""
    body = select_one(root, "body") or root
    text = body.text()
    forms = []
    for form in select_all(root, "form")[:5]:
        inputs = []
        for field in select_all(form, "input,select,textarea")[:20]:
            inputs.append({
                "name": field.get("name") or "",
                "type": field.get("type") or field.tag,
                "value": field.get("value") or "",
                "placeholder": field.get("placeholder") or "",
            })
        forms.append({
            "action": urljoin(response.url, form.get("action") or ""),
            "method": (form.get("method") or "GET").upper(),
            "inputs": inputs,
        })
    links = []
    for anchor in select_all(root, "a[href]")[:60]:
        links.append({
            "text": anchor.text()[:60],
            "href": urljoin(response.url, anchor.get("href") or ""),
        })
    content_type = response.headers.get("content-type", "")
    kind = "json" if "json" in content_type else "html"
    return {
        "success": True,
        "url": url,
        "finalUrl": response.url,
        "status": response.status,
        "kind": kind,
        "title": title[:200],
        "description": description[:300],
        "text": text[:max_chars],
        "textLength": len(text),
        "forms": forms,
        "links": links,
        "encoding": response.encoding,
    }


def build_registry(
    store: RuleStore,
    search: SearchService,
    fetcher: Fetcher,
    max_page_chars: int = 6000,
    agent=None,
    include_generate: bool = False,
    accounts=None,
    browser=None,
    search_log=None,
    play=None,
) -> ToolRegistry:
    registry = ToolRegistry()

    def fetch_page(url: str, max_chars: Optional[int] = None) -> dict:
        chars = max(500, min(20000, int(max_chars or max_page_chars)))
        return _page_summary(fetcher, url, chars)

    registry.register(
        "fetch_page",
        "抓取一个网页并返回标题、正文摘要、表单和链接，用于寻找站点的搜索入口。",
        {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "http(s) 页面地址"},
                "max_chars": {"type": "integer", "description": "正文摘要最大字符数"},
            },
            "required": ["url"],
        },
        fetch_page,
    )

    def inspect_html(url: str, selector: str, limit: int = 5) -> dict:
        response = fetcher.fetch(url)
        root = parse_html(response.text)
        nodes = select_all(root, selector)
        samples = []
        for node in nodes[: max(1, min(20, int(limit or 5)))]:
            samples.append({
                "tag": node.tag,
                "text": node.text()[:200],
                "attrs": {key: value for key, value in node.attrs.items() if key in ("class", "id", "href", "src", "title")},
                "html": node.html()[:500],
            })
        return {
            "success": True,
            "url": response.url,
            "selector": selector,
            "count": len(nodes),
            "samples": samples,
        }

    registry.register(
        "inspect_html",
        "在网页上执行 CSS 选择器，返回匹配数量与样本 HTML，用于验证规则选择器。",
        {
            "type": "object",
            "properties": {
                "url": {"type": "string"},
                "selector": {"type": "string", "description": "CSS 选择器"},
                "limit": {"type": "integer"},
            },
            "required": ["url", "selector"],
        },
        inspect_html,
    )

    def inspect_challenge(url: str, keyword: str = "") -> dict:
        target = url
        if keyword:
            target = target.replace("{keyword}", quote_keyword(keyword))
            target = target.replace("{query}", quote_keyword(keyword))
        response = fetcher.fetch(target)
        result = generic_signals(response.text, response.url, response.status)
        result["request"] = {"url": target, "status": response.status}
        if keyword:
            result["keyword"] = keyword
        return result

    registry.register(
        "inspect_challenge",
        "检查一个页面是否是人机验证/反爬挑战页，返回标题、命中关键词、可疑选择器和建议的 challenge 规则片段。",
        {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "页面地址，可含 {keyword}"},
                "keyword": {"type": "string", "description": "可选，用来替换 URL 里的 {keyword}"},
            },
            "required": ["url"],
        },
        inspect_challenge,
    )

    def detect_challenge_html(html: str, url: str = "", status: int = 200) -> dict:
        return generic_signals(html or "", url, status)

    registry.register(
        "detect_challenge_html",
        "分析一段已经取到的 HTML（例如 browser_html 渲染结果），判断是否包含人机验证特征并给出 challenge 规则建议。",
        {
            "type": "object",
            "properties": {
                "html": {"type": "string"},
                "url": {"type": "string"},
                "status": {"type": "integer"},
            },
            "required": ["html"],
        },
        detect_challenge_html,
    )

    def test_rule(rule: dict, keyword: str = "", limit: int = 10) -> dict:
        keyword = (keyword or "").strip() or "电影"
        return search.test_rule(rule, keyword, limit=limit)

    registry.register(
        "test_rule",
        "不保存规则，直接用一条搜索关键词测试规则是否能抓到结果。",
        {
            "type": "object",
            "properties": {
                "rule": {"type": "object", "description": "完整规则对象"},
                "keyword": {"type": "string", "description": "测试关键词"},
                "limit": {"type": "integer"},
            },
            "required": ["rule"],
        },
        test_rule,
    )

    def test_play(detail_url: str, rule: Optional[dict] = None) -> dict:
        if play is None:
            return {"success": False, "code": "unavailable", "error": "播放解析未启用"}
        try:
            # 规则（含临时传入的 rule）绑定账号时，解析器会自动带上该账号的
            # Cookie 与请求头；绑定是用户同意的操作，脚本不用自己处理登录态。
            return play.resolve(detail_url, rule=rule if isinstance(rule, dict) else None)
        except EngineError as exc:
            return exc.to_dict()

    registry.register(
        "test_play",
        "不保存规则，用一个详情页地址试播：返回解析出的播放地址、格式、请求头和选集；站点有多档清晰度时还会返回 qualities 列表（播放器据此让用户切换清晰度）。传 rule 可测试尚未保存的 play 配置。规则绑定了账号（search.account_id 或 play.account_id）时会带上该账号 Cookie，可验证登录后才可用的线路。",
        {
            "type": "object",
            "properties": {
                "detail_url": {"type": "string", "description": "站点详情页地址（搜索结果里的 url）"},
                "rule": {"type": "object", "description": "可选：带 play 段的规则对象，用来测试还没保存的配置"},
            },
            "required": ["detail_url"],
        },
        test_play,
    )

    def save_rule(rule: dict) -> dict:
        saved = store.save(rule, rule_id=(rule or {}).get("id"))
        return {"success": True, "rule": public_rule_view(saved, include_parse=True)}

    registry.register(
        "save_rule",
        "保存新规则或更新已有规则（带 id 即更新）。保存前会做格式校验。",
        {
            "type": "object",
            "properties": {"rule": {"type": "object", "description": "完整规则对象"}},
            "required": ["rule"],
        },
        save_rule,
    )

    def list_rules(room_id: Optional[str] = None, role: str = "root") -> dict:
        rules = []
        for rule in store.list(include_disabled=True):
            if role != "root" and not rule_visible_to(rule, room_id=room_id, role=role):
                continue
            rules.append(public_rule_view(rule, include_parse=(role == "root")))
        return {"success": True, "rules": rules, "count": len(rules)}

    registry.register(
        "list_rules",
        "列出已保存的站点规则；管理员可看到完整搜索与解析配置。",
        {
            "type": "object",
            "properties": {
                "room_id": {"type": "string"},
                "role": {"type": "string", "description": "root 或 guest"},
            },
        },
        list_rules,
    )

    def get_rule(rule_id: str) -> dict:
        return {"success": True, "rule": public_rule_view(store.get(rule_id), include_parse=True)}

    registry.register(
        "get_rule",
        "按 id 读取一条站点规则的完整配置。",
        {
            "type": "object",
            "properties": {"rule_id": {"type": "string"}},
            "required": ["rule_id"],
        },
        get_rule,
    )

    def update_rule(rule_id: str, patch: dict) -> dict:
        return {"success": True, "rule": public_rule_view(store.update(rule_id, patch), include_parse=True)}

    registry.register(
        "update_rule",
        "局部修改一条规则（patch 会与现有规则合并，search/parse 是浅合并）。",
        {
            "type": "object",
            "properties": {
                "rule_id": {"type": "string"},
                "patch": {"type": "object"},
            },
            "required": ["rule_id", "patch"],
        },
        update_rule,
    )

    def delete_rule(rule_id: str) -> dict:
        deleted = store.delete(rule_id)
        return {"success": deleted, "ruleId": rule_id, "deleted": deleted}

    registry.register(
        "delete_rule",
        "删除一条站点规则。",
        {
            "type": "object",
            "properties": {"rule_id": {"type": "string"}},
            "required": ["rule_id"],
        },
        delete_rule,
    )

    def search_site(site: str, keyword: str, room_id: Optional[str] = None, role: str = "root") -> dict:
        try:
            return search.search(site, keyword, room_id=room_id, role=role)
        except EngineError as exc:
            return exc.to_dict()

    registry.register(
        "search_site",
        "用已保存的站点规则执行一次搜索（调试用）。",
        {
            "type": "object",
            "properties": {
                "site": {"type": "string", "description": "规则 id、域名或 URL"},
                "keyword": {"type": "string"},
                "room_id": {"type": "string"},
                "role": {"type": "string"},
            },
            "required": ["site", "keyword"],
        },
        search_site,
    )

    if search_log is not None:
        def search_logs(limit: int = 20, site: str = "", failures_only: bool = True, source: str = "") -> dict:
            logs = search_log.list(limit=limit, site=site, failures_only=failures_only, source=source)
            return {"success": True, "logs": logs, "count": len(logs), "total": search_log.count()}

        registry.register(
            "search_logs",
            "读取最近的搜索日志（默认只看失败），用于诊断空结果、选择器漂移、验证码或登录墙；含请求 URL、状态码、响应摘要与错误文本。",
            {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "最多返回条数，默认 20"},
                    "site": {"type": "string", "description": "按规则 id / 域名 / 站点名过滤"},
                    "failures_only": {"type": "boolean", "description": "只看失败记录，默认 true"},
                    "source": {"type": "string", "description": "search、test 或 mcp"},
                },
            },
            search_logs,
        )

    def list_sites(room_id: Optional[str] = None, role: str = "guest") -> dict:
        sites = search.list_sites(room_id=room_id, role=role)
        return {"success": True, "sites": sites, "count": len(sites)}

    registry.register(
        "list_sites",
        "列出当前房间/角色可用的站点（供前端一起看展示）。",
        {
            "type": "object",
            "properties": {
                "room_id": {"type": "string"},
                "role": {"type": "string"},
            },
        },
        list_sites,
    )

    if accounts is not None:
        def list_accounts() -> dict:
            items = accounts.list(mask=True)
            return {"success": True, "accounts": items, "count": len(items)}

        registry.register(
            "list_accounts",
            "列出已保存的站点账号（密码/Cookie 已掩码），用于给规则绑定登录态。",
            {"type": "object", "properties": {}},
            list_accounts,
        )

        def save_account(account: dict) -> dict:
            saved = accounts.save(account)
            return {"success": True, "account": accounts.public_view(saved, mask=True)}

        registry.register(
            "save_account",
            "保存或更新一个站点账号（username/password/cookies/headers）。同名会覆盖。",
            {
                "type": "object",
                "properties": {
                    "account": {
                        "type": "object",
                        "description": "账号对象：id/name/site/username/password/cookies/headers/notes",
                    }
                },
                "required": ["account"],
            },
            save_account,
        )

        def delete_account(account_id: str) -> dict:
            deleted = accounts.delete(account_id)
            return {"success": deleted, "accountId": account_id, "deleted": deleted}

        registry.register(
            "delete_account",
            "删除一个站点账号。",
            {
                "type": "object",
                "properties": {"account_id": {"type": "string"}},
                "required": ["account_id"],
            },
            delete_account,
        )

        def bind_account(rule_id: str, account_id: str) -> dict:
            current = store.get(rule_id)
            patch = {"search": {"account_id": account_id}}
            play = dict(current.get("play") or {})
            if play:
                # 已有 play 段时同步写入，播放解析/test_play 也能带上登录态。
                play["account_id"] = account_id
                patch["play"] = play
            rule = store.update(rule_id, patch)
            return {"success": True, "rule": public_rule_view(rule, include_parse=True)}

        registry.register(
            "bind_account",
            "把账号绑定到一条站点规则（写入 rule.search.account_id；规则已有 play 段时同步写入 play.account_id）。绑定即表示用户同意引擎在该规则的搜索、播放解析与 test_play 中使用该账号 Cookie；未获用户同意不要调用。",
            {
                "type": "object",
                "properties": {
                    "rule_id": {"type": "string"},
                    "account_id": {"type": "string", "description": "传空字符串表示解绑"},
                },
                "required": ["rule_id", "account_id"],
            },
            bind_account,
        )

    if browser is not None:
        def browser_status() -> dict:
            return {"success": True, "browser": browser.status()}

        registry.register(
            "browser_status",
            "查看离屏浏览器状态（是否安装、是否运行、当前页面）。",
            {"type": "object", "properties": {}},
            browser_status,
        )

        def browser_open(url: str, wait_sec: float = 0) -> dict:
            info = browser.open(url, wait_sec=wait_sec)
            return {"success": True, "page": info}

        registry.register(
            "browser_open",
            "用离屏浏览器打开一个页面（会执行 JS，适合 SPA 或需要登录的站点），返回标题和正文片段。",
            {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "wait_sec": {"type": "number", "description": "额外等待秒数，最多 10"},
                },
                "required": ["url"],
            },
            browser_open,
        )

        def browser_text(selector: str = "", max_chars: int = 8000) -> dict:
            data = browser.text(selector, max_chars=max_chars)
            return {"success": True, "url": data["url"], "text": data["text"]}

        registry.register(
            "browser_text",
            "读取离屏浏览器当前页面的正文文本，可用 CSS 选择器限定区域。",
            {
                "type": "object",
                "properties": {
                    "selector": {"type": "string"},
                    "max_chars": {"type": "integer"},
                },
            },
            browser_text,
        )

        def browser_html(max_chars: int = 60000) -> dict:
            data = browser.html(max_chars=max_chars)
            return {"success": True, "url": data["url"], "html": data["html"], "length": data["length"]}

        registry.register(
            "browser_html",
            "读取离屏浏览器当前页面的渲染后 HTML（用于查找动态生成的搜索表单/结果）。",
            {
                "type": "object",
                "properties": {"max_chars": {"type": "integer"}},
            },
            browser_html,
        )

        def browser_eval(script: str) -> dict:
            data = browser.evaluate(script)
            return {"success": True, "url": data["url"], "value": data["value"]}

        registry.register(
            "browser_eval",
            "在离屏浏览器页面里执行一段 JS 表达式并返回结果（可探测接口、读取 DOM、点击按钮）。",
            {
                "type": "object",
                "properties": {"script": {"type": "string", "description": "JS 表达式，支持 await"}},
                "required": ["script"],
            },
            browser_eval,
        )

        def browser_click(selector: str) -> dict:
            result = browser.click(selector)
            return {"success": True, "result": result}

        registry.register(
            "browser_click",
            "点击离屏浏览器页面里的第一个匹配元素。",
            {
                "type": "object",
                "properties": {"selector": {"type": "string"}},
                "required": ["selector"],
            },
            browser_click,
        )

        def browser_cookies(site: str = "") -> dict:
            data = browser.cookie_summary(site)
            return {"success": True, **data}

        registry.register(
            "browser_cookies",
            "查看当前浏览器在某个域名下的 Cookie 名称与数量（不返回值，防止泄露）。",
            {
                "type": "object",
                "properties": {"site": {"type": "string", "description": "域名，如 example.com"}},
            },
            browser_cookies,
        )

        def browser_open_login(url: str) -> dict:
            result = browser.open_login(url)
            return {"success": True, **result}

        registry.register(
            "browser_open_login",
            "（兼容旧名，等价于 browser_show）把浏览器窗口显示出来，让用户人工登录站点。",
            {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
            browser_open_login,
        )

        def browser_show(url: str = "", wait_sec: float = 0) -> dict:
            result = browser.show(url, wait_sec=wait_sec)
            return {"success": True, **result}

        registry.register(
            "browser_show",
            "把浏览器窗口显示给用户，用于人工登录/处理验证码；无头模式下会切换为可见窗口，"
            "登录后调用 browser_save_login 保存登录态。只在确实需要用户操作时才显示。",
            {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要显示的页面 URL，留空则显示当前页面"},
                    "wait_sec": {"type": "number", "description": "额外等待秒数，最多 10"},
                },
            },
            browser_show,
        )

        def browser_hide() -> dict:
            result = browser.hide()
            return {"success": True, **result}

        registry.register(
            "browser_hide",
            "把可见浏览器窗口收回后台无头运行，保留登录态，适合用户登录完成后继续自动操作。",
            {"type": "object", "properties": {}},
            browser_hide,
        )

        def browser_save_login(site: str, name: str = "") -> dict:
            result = browser.save_login(site, name=name, accounts=accounts)
            return {"success": True, **result}

        registry.register(
            "browser_save_login",
            "把可见窗口里人工登录后的 Cookie 保存成账号，并关闭窗口、恢复无头浏览器。",
            {
                "type": "object",
                "properties": {
                    "site": {"type": "string", "description": "站点域名"},
                    "name": {"type": "string", "description": "账号显示名"},
                },
                "required": ["site"],
            },
            browser_save_login,
        )

    if include_generate and agent is not None:
        def generate_rule(url: str, keyword: str = "", notes: str = "") -> dict:
            return agent.generate(url, keyword=keyword, notes=notes)

        registry.register(
            "generate_rule",
            "让大模型访问站点、自动生成搜索与解析规则；生成后会试搜并在成功时保存。",
            {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "站点首页或搜索页 URL"},
                    "keyword": {"type": "string", "description": "试搜关键词"},
                    "notes": {"type": "string", "description": "额外要求"},
                },
                "required": ["url"],
            },
            generate_rule,
        )
    return registry