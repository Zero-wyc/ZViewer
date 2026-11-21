"""LLM agent that turns a site URL into a saved JSON search rule."""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from .errors import LLMError, RuleError
from .llm import LLMClient
from .rules import public_rule_view, validate_rule
from .search import SearchService
from .store import RuleStore
from .tools import RULE_GUIDE, ToolRegistry


SYSTEM_PROMPT = """你是 ZViewer 的站点规则生成器。用户会给你一个影视/资源站点的 URL，
你要找出该站点的搜索入口，生成一条可执行的 JSON 规则，并用工具验证后保存。

规则格式：
%s

工作流程（必须按顺序使用工具，不要凭空猜测选择器）：
1. 先用 list_rules（或 list_sites）查一下该站点是否已有规则（site 与域名相同）：已有就 get_rule 读现状，在本流程结束时用 update_rule 修改同一条规则，不要 save_rule 新建；只有确实不存在时才新建。
2. 调用 fetch_page 打开站点，查看 forms 和 links，找到搜索表单或搜索页地址。
3. 如果没有表单，尝试站点常见的搜索路径，或从 links 中找到“搜索”入口。
4. 先写出规则草稿，然后调用 test_rule（关键词由用户提供），检查 count 与 items。
5. 如果 count=0 或字段为空，用 inspect_html 检查并修正 container / fields 选择器，再 test_rule。
6. 如果 test_rule 返回 code=challenge_required 或页面出现「验证码/人机验证/Cloudflare」等特征，用 inspect_challenge 分析页面，把建议写进规则的 challenge 块（enabled/selectors/keywords/url_contains/statuses），再 test_rule 验证；不要在验证未通过时反复空跑。若必须真人操作才能继续，调用 browser_show 打开窗口，然后直接结束并回复用户「需要你登录/完成验证」，不要空跑。
7. test_rule 的 ok=true 后，继续做**播放解析**：从 items 里取一个 url（详情页）调用 test_play 看能否拿到可播地址。
   - 只有播放页/详情页里有选集链接（vodplay/、/play/ 等）且站点有播放接口时，写 play.play_url_regex + play.api.url（命名捕获组）再 test_play。
   - 站点接口在 /api/* 后面、被 Cloudflare/JS 拦时，写 play.script（Node 脚本里 fetch 站点接口，见规则格式说明）再 test_play。
   - 反复调整到 test_play 返回 success=true 且 format 为 hls/mp4/flv；返回 iframe 说明站点禁止直接播放，不要硬凑。
8. 把 play 段一起写进规则：已有规则用 update_rule 更新同一条，新站点才用 save_rule（test_rule 仍要 ok=true）；保存成功后结束。
9. 最终回复用一句中文总结站点、搜索地址、抓到的条数，以及播放解析结果（可播/不可播、线路格式）；站点必须人工验证才能搜索时说明规则已带 challenge 识别。

约束：
- 只抓公开搜索页，不处理付费墙、DRM；需要登录时不要索取或保存密码，调用 browser_show 把窗口显示给用户人工登录。
- 如果 fetch_page 只拿到空壳（SPA/JS 渲染），改用 browser_open + browser_text/browser_html/browser_eval 查看渲染结果。
- 登录态：用户登录后调用 browser_save_login 保存为账号，再 bind_account 绑定到规则（绑定前先确认用户同意；绑定后该规则的搜索、播放解析和 test_play 都会带这份登录态）；之后可用 browser_hide 收回窗口。
- 搜索请求优先 GET，关键词用 {keyword} 占位；POST 时 body 里用 {keyword}。
- 规则里 site 填域名（不带协议）；name 必须由你起一个可读的站点名（优先使用网页标题/品牌名，例如「某某影视」「XX 资源站」，不要直接填域名、IP 或 example.com）；visibility 默认 public，allowed_rooms 默认 []。
- 不要编造 selector；字段至少要能取到 title 和 url（绝对地址）。
- 如果站点本身不可用（无法访问、403/Cloudflare 拦死、搜索无结果、只有会员/DRM 或无合法播放地址），不要硬凑或编造规则：直接说明具体原因后结束。
- 最多执行 %d 步工具调用，请高效。"""


CHAT_SYSTEM_PROMPT = """你是 ZViewer 的爬虫规则助手，在一个持续对话里帮管理员维护站点搜索规则。
你可以调用工具抓页面、试跑规则、增删改规则、给规则绑定登录账号、以及生成新站点规则。
你还有一个离屏浏览器（browser_* 工具），可以打开 JS 渲染的页面、读渲染后的 HTML、执行脚本探查接口。
登录必须由人工完成，但显示窗口由你决定：遇到登录墙时调用 browser_show 把窗口显示给用户，
请用户在该窗口登录；用户确认登录后调用 browser_save_login 保存登录态，再经用户同意用 bind_account 绑定到规则，
之后可用 browser_hide 收回窗口。绑定后该规则的搜索、播放解析和 test_play 都会带这份登录态。不要向用户索取密码，也不要把 Cookie 写进规则。

规则格式：
%s

对话原则：
- 先理解用户目的。默认自主连续工作：拿到任务后自己规划并连续调用工具，直到完成，不要为了“是否继续”这类没必要的确认停下来。但遇到以下情况应当暂停，用 ask_user 问清楚再继续：
  1. 需求有歧义，或有多条可行路线需要用户取舍（例如只做搜索还是同时做播放解析、用哪个接口/线路）；
  2. 缺少只有用户才能提供的信息（账号、验证码、站点选择、目标清晰度等）；
  3. 同一个问题连续尝试 2~3 次仍失败，且原因不在规则写法上（站点反爬、接口变更等）；
  4. 站点不可用、只有会员/DRM、没有合法播放地址，需要用户决定换站点还是放弃；
  5. 需要人工登录或完成人机验证；
  提问要具体：说清卡在哪里、需要用户做什么；有明确选项时用 options 列出 2~4 个，方便用户直接选。
- 缺少页面结构等信息时先用 fetch_page/inspect_html/browser_* 实际检查，不要凭空猜；确实做不了时按下面的暂停规则处理，不要凭空凑规则。
- 需要站点结构时用 fetch_page/inspect_html 实际查看，不要凭空猜选择器。
- 处理某个站点前先 list_rules（或 list_sites）检查：如果该站点已经有规则（site 与域名相同），必须 get_rule 读现状后用 update_rule 修改同一条规则，不要 save_rule 新建；只有确实不存在时才新建。
- 需要你登录或人工完成人机验证时：调用 browser_show 把窗口显示给用户，再用 ask_user 说明「需要你登录/完成验证，窗口已打开」，本轮暂停等用户回复；用户回复后再继续后续步骤。不要向用户要密码、不要绕过验证、也不要反复空跑。
- 如果站点自身原因导致无法生成可用规则（无法访问、域名失效、403/Cloudflare 拦死、搜索无结果、只有会员/DRM 或没有合法播放地址），不要硬凑或编造规则：先说明具体原因；需要用户决定（换站点/放弃/提供登录）时用 ask_user 询问，确实不需要用户决定时用 task_complete 说明原因后结束。
- 结束本轮要选对方式：任务完成用 task_complete（summary 写最终答复）；需要用户回答或做决定用 ask_user（写清问题和选项），不要用普通文字提问后自行停下；只有确实无法继续且不需要用户回答时，才用 task_complete 说明原因。
- 修改规则前先 get_rule 看现状；改完用 test_rule 验证，ok=true 再保存。
- 用户要“绑定账号”时：先 list_accounts 看是否已有账号；没有就请用户提供账号密码/Cookie，再用 save_account 保存，最后 bind_account 绑定到规则。绑定后搜索、播放解析（含 test_play）都会带上该账号 Cookie，可用来验证会员/登录后才有的线路；未获用户同意不要自行绑定，也不要把账号用于其他站点。
- 用户要“微调脚本”时：先 get_rule 读取现有 search.script/parse.script，改完用 test_rule 验证。
- 遇到验证码/人机验证/Cloudflare 挑战页（test_rule 返回 challenge_required），用 inspect_challenge 或 detect_challenge_html 分析，再把 challenge 检测条件写进规则；需要真人操作时说明会在搜索时弹给房主验证。
- 用户要在新站点加搜索时：按“生成规则”流程走，并且补上 play 段（用 test_play 验证到 success=true 且 format 可播）；成功后告诉用户站点已可用。
- 生成 play 段时顺便解析清晰度档位：站点有多档（标清/高清/1080P/蓝光等）就在 play.script 里返回 qualities（name 用站点文案，url 给默认档），用 test_play 的返回核对；只有一档或拿不到就不要编造档位。
- 用户问“为什么搜到了不能播/播放失败”时：get_rule 看 play 段与绑定的账号（search.account_id/play.account_id），取一条结果 url 用 test_play 复现，再按 play.script/play.api 修正；不要只改搜索规则。
- 站点要登录才给播放地址或多档清晰度时（例如 B 站）：先和用户确认可用账号并确认已绑定到规则，再用 test_play 验证；绑定这一步必须先经用户同意，不要自己去 bind_account。
- 新建规则时 name 由你起一个可读站点名（优先网页标题/品牌名，不要用域名）；用户之后可以在 GUI 里改名。
- 会话标题由你维护：开始处理任务时，调用 rename_session 用一句不超过 16 个中文字符的短语概括主题（例如「给某影视站生成搜索规则」）。
- 用简洁中文回复；执行过的关键操作要说明结果（成功/失败原因）。
- 任务全部完成时，调用 task_complete（summary 写最终答复）；需要用户补充信息或做决定时，用 ask_user 暂停本轮；不要只输出一段文字就停下来。
- 工具调用次数不设上限：按需调用，直到完成或需要用户决定；但不要重复无效尝试，同一问题连续 2~3 次失败就停下来用 ask_user 询问用户。"""


REPAIR_SYSTEM_PROMPT = """你是 ZViewer 的站点规则修复助手。一条已保存的规则在执行搜索时失败了，
需要你实际检查站点并把规则修好。失败可能来自站点改版、选择器失效、请求参数变化，或需要登录/JS 渲染。

规则 ID：%s
当前规则 JSON：
%s

失败关键词：%s
失败原因：%s

修复流程（必须使用工具，不要凭空改）：
1. 先 get_rule 读取最新规则（可能刚被别人改过）。
2. 用 fetch_page 打开搜索页；如果页面是 JS 渲染或请求需要登录态，改用 browser_open + browser_text/browser_html/browser_eval。
3. 用 inspect_html 确认搜索结果的结构，修正 search（URL/方法/头/脚本）与 parse（container/fields/脚本）。
4. 若失败原因是 challenge_required 或页面是人机验证页，用 inspect_challenge 分析，补上或修正 challenge 块的检测条件，再 test_rule；不要试图绕过验证。
5. 用 test_rule 验证，直到 ok=true；不要只看 count，items 里的 title/url 必须有效。
6. 用 update_rule 或 save_rule 更新同一个规则 ID（rule_id=%s），不要新建重复规则。
7. 修好后用一句中文说明改了什么；如果站点不可访问或必须登录而无法完成，直接说明原因并停止，不要编造。

约束：
- 最多 %d 步工具调用。
- 只抓公开页面，不处理付费墙/DRM；需要登录时调用 browser_show 让用户人工登录，登录后 browser_save_login 保存，再继续修复。
- 不要编造 selector；不要删除规则。"""


# 只在自主执行的对话里注入：模型用它宣告任务完成并给出最终答复。
TASK_COMPLETE_TOOL = {
    "type": "function",
    "function": {
        "name": "task_complete",
        "description": "当用户交办的任务已经全部完成时调用，summary 写要展示给用户的最终答复。"
                       "任务没完成前不要调用；也不要用普通文字替代这个调用。",
        "parameters": {
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "最终答复：完成了什么、规则 id/站点、验证结果或无法完成的原因。",
                },
            },
            "required": ["summary"],
        },
    },
}


# 允许模型给当前会话起一个更准确的标题（长度与 UI 一致，最多 32 字）。
RENAME_SESSION_TOOL = {
    "type": "function",
    "function": {
        "name": "rename_session",
        "description": "给当前会话重命名。开始处理任务后，用一句不超过 16 个中文字符的短语概括这次对话的主题。",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "新的会话标题，最多 32 个字符，不要带引号。",
                },
            },
            "required": ["title"],
        },
    },
}


# 只在自主执行的对话里注入：模型用它暂停本轮，向用户提问并等待回复。
ASK_USER_TOOL = {
    "type": "function",
    "function": {
        "name": "ask_user",
        "description": "当任务无法继续、需要用户提供信息或做决定时调用：说明卡在哪里、需要用户做什么；"
                       "有明确选项时用 options 给出 2~4 个。调用后本轮结束，等用户回复后再继续。",
        "parameters": {
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "给用户看的问题：说明卡在哪里、需要用户提供什么或决定什么。",
                },
                "options": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "可选：2~4 个建议选项，方便用户直接选择。",
                },
            },
            "required": ["question"],
        },
    },
}


_IMAGE_DATA_RE = re.compile(r"^data:image/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$")
_MAX_IMAGES = 4
_MAX_IMAGE_CHARS = 3_000_000


def normalize_images(images) -> list:
    """校验前端传来的图片 data URL，最多 4 张，避免把任意 URL 带进模型请求。"""
    if not isinstance(images, list):
        return []
    out = []
    for item in images[:_MAX_IMAGES]:
        if not isinstance(item, str):
            continue
        item = item.strip()
        if not item:
            continue
        if len(item) > _MAX_IMAGE_CHARS:
            raise RuleError("单张图片过大，请压缩后再发送")
        if not _IMAGE_DATA_RE.match(item):
            raise RuleError("图片格式不支持，请使用 PNG/JPEG/WebP/GIF")
        out.append(item)
    return out


class RuleAgent:
    def __init__(
        self,
        llm: LLMClient,
        registry: ToolRegistry,
        store: RuleStore,
        search: SearchService,
        config: dict,
        data_dir=None,
    ):
        self.llm = llm
        self.registry = registry
        self.store = store
        self.search = search
        self.config = config
        generation = config.get("generation") or {}
        self.max_steps = int(generation.get("max_steps") or 12)
        agent_cfg = config.get("agent") or {}
        self.chat_max_steps = int(agent_cfg.get("max_steps") or 0)
        self.auto_continue = max(0, int(agent_cfg.get("auto_continue") or 2))
        self.sample_keyword = generation.get("sample_keyword") or "电影"
        llm_cfg = config.get("llm") or {}
        self.reasoning_effort = str(llm_cfg.get("reasoning_effort") or "").strip()
        self.generation_effort = str(generation.get("reasoning_effort") or "").strip()
        self.submission_effort = str(
            (config.get("submissions") or {}).get("reasoning_effort") or "").strip()
        self.sessions_dir = Path(data_dir or "data").resolve() / "sessions"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)

    def _custom_prompt(self) -> str:
        """GUI 设置页里填写的自定义提示词，追加到所有 Agent 系统提示词末尾。"""
        section = self.config.get("agent") or {}
        return str(section.get("custom_prompt") or "").strip()[:4000]

    def _system_prompt(self, base: str) -> str:
        custom = self._custom_prompt()
        if not custom:
            return base
        return (base + "\n\n【管理员自定义指令】\n" + custom +
                "\n（以上自定义指令在不违反前面的安全与流程约束时生效。）")

    def _default_model(self) -> str:
        """当前 LLM 客户端配置的默认模型名（测试替身可能没有该属性）。"""
        return str(getattr(self.llm, "model", "") or "").strip()

    def generate(self, url: str, keyword: str = "", notes: str = "",
                 reasoning_effort: Optional[str] = None) -> dict:
        started = time.time()
        effort = self.generation_effort if reasoning_effort is None else reasoning_effort
        url = (url or "").strip()
        if not re.match(r"^https?://", url, re.I):
            if url and "." in url:
                url = "https://" + url
            else:
                return {"success": False, "error": "请提供有效的站点 URL"}
        keyword = (keyword or "").strip() or self.sample_keyword
        host = urlsplit(url).hostname or ""
        messages = [
            {"role": "system", "content": self._system_prompt(SYSTEM_PROMPT % (RULE_GUIDE, self.max_steps))},
            {
                "role": "user",
                "content": "站点 URL: %s\n试搜关键词: %s\n额外要求: %s\n请生成并保存规则。" % (
                    url, keyword, notes or "无"),
            },
        ]
        tools = self.registry.openai_tools()
        saved_rule: Optional[dict] = None
        last_test: Optional[dict] = None
        transcript = []
        final_content = ""
        error = ""
        steps = 0
        while steps < self.max_steps:
            steps += 1
            try:
                reply = self.llm.chat(messages, tools=tools, tool_choice="auto",
                                      reasoning_effort=effort)
            except LLMError as exc:
                return {
                    "success": False,
                    "error": exc.message,
                    "steps": steps,
                    "transcript": transcript,
                    "tookMs": int((time.time() - started) * 1000),
                }
            tool_calls = reply.get("toolCalls") or []
            if reply.get("content"):
                final_content = reply["content"]
            if not tool_calls:
                candidate = self._extract_rule(reply.get("content") or "")
                if candidate:
                    candidate.setdefault("site", host)
                    candidate.setdefault("name", host)
                    try:
                        rule = validate_rule(candidate)
                        test = self.search.test_rule(rule, keyword, limit=10)
                        last_test = test
                        transcript.append({"step": steps, "action": "final_rule_json", "test": {
                            "ok": test.get("ok"), "count": test.get("count")}})
                        if test.get("ok"):
                            saved_rule = self.store.save(rule)
                            break
                        error = "规则试搜失败: %s" % test.get("error", "没有解析到结果")
                        messages.append({"role": "assistant", "content": reply.get("content") or ""})
                        messages.append({
                            "role": "user",
                            "content": "上面的规则试搜没有结果（%s）。请用 fetch_page/inspect_html 检查页面，修正后重新 test_rule 并 save_rule。" % error,
                        })
                        continue
                    except RuleError as exc:
                        error = exc.message
                        messages.append({"role": "assistant", "content": reply.get("content") or ""})
                        messages.append({"role": "user", "content": "规则校验失败：%s。请修正后调用 save_rule。" % error})
                        continue
                break
            assistant_message = {
                "role": "assistant",
                "content": reply.get("content") or "",
                "tool_calls": [
                    {
                        "id": call["id"] or ("call_%d_%d" % (steps, index)),
                        "type": "function",
                        "function": {
                            "name": call["name"],
                            "arguments": json.dumps(call["arguments"], ensure_ascii=False),
                        },
                    }
                    for index, call in enumerate(tool_calls)
                ],
            }
            messages.append(assistant_message)
            for index, call in enumerate(tool_calls):
                name = call.get("name") or ""
                arguments = call.get("arguments") or {}
                result = self.registry.call(name, arguments)
                transcript.append({
                    "step": steps,
                    "tool": name,
                    "arguments": arguments,
                    "result": self._summarize_result(result),
                })
                if name == "test_rule":
                    last_test = result
                if name == "save_rule" and result.get("success"):
                    saved_rule = result.get("rule")
                messages.append({
                    "role": "tool",
                    "tool_call_id": assistant_message["tool_calls"][index]["id"],
                    "content": self._tool_content(result),
                })
                if saved_rule:
                    break
            if saved_rule:
                break
        if saved_rule:
            return {
                "success": True,
                "saved": True,
                "ruleId": saved_rule.get("id"),
                "rule": public_rule_view(saved_rule, include_parse=True),
                "test": self._test_view(last_test),
                "steps": steps,
                "message": final_content[:500],
                "transcript": transcript,
                "tookMs": int((time.time() - started) * 1000),
            }
        return {
            "success": False,
            "saved": False,
            "error": error or "模型未能在限定步数内生成并保存规则",
            "test": self._test_view(last_test),
            "steps": steps,
            "message": final_content[:1000],
            "transcript": transcript,
            "tookMs": int((time.time() - started) * 1000),
        }

    def repair(self, rule: dict, keyword: str = "", error: str = "",
               reasoning_effort: Optional[str] = None) -> dict:
        """修复一条执行失败的规则；由 SearchService 在搜索失败时回调。"""
        started = time.time()
        effort = self.reasoning_effort if reasoning_effort is None else reasoning_effort
        rule = rule or {}
        rule_id = rule.get("id") or ""
        if not rule_id:
            return {
                "success": False,
                "repaired": False,
                "error": "缺少规则 ID，无法自动修复",
                "steps": 0,
                "transcript": [],
                "tookMs": 0,
            }
        keyword = (keyword or "").strip() or self.sample_keyword
        try:
            current = self.store.get(rule_id)
        except RuleError as exc:
            return {
                "success": False,
                "repaired": False,
                "ruleId": rule_id,
                "error": exc.message,
                "steps": 0,
                "transcript": [],
                "tookMs": int((time.time() - started) * 1000),
            }
        messages = [
            {
                "role": "system",
                "content": self._system_prompt(REPAIR_SYSTEM_PROMPT % (
                    rule_id,
                    json.dumps(current, ensure_ascii=False, indent=2),
                    keyword,
                    error or "规则没有返回结果",
                    rule_id,
                    self.max_steps,
                )),
            },
            {
                "role": "user",
                "content": "请修复规则 %s，并用关键词「%s」验证。" % (rule_id, keyword),
            },
        ]
        tools = self.registry.openai_tools()
        transcript = []
        final_content = ""
        steps = 0
        updated = False
        while steps < self.max_steps:
            steps += 1
            try:
                reply = self.llm.chat(messages, tools=tools, tool_choice="auto",
                                      reasoning_effort=effort)
            except LLMError as exc:
                return {
                    "success": False,
                    "repaired": False,
                    "ruleId": rule_id,
                    "error": exc.message,
                    "steps": steps,
                    "transcript": transcript,
                    "tookMs": int((time.time() - started) * 1000),
                }
            tool_calls = reply.get("toolCalls") or []
            if reply.get("content"):
                final_content = reply["content"]
            if not tool_calls:
                break
            assistant_calls = []
            for index, call in enumerate(tool_calls):
                arguments = call.get("arguments")
                if not isinstance(arguments, dict):
                    arguments = {}
                assistant_calls.append({
                    "id": call.get("id") or ("repair_%d_%d" % (steps, index)),
                    "type": "function",
                    "function": {
                        "name": call.get("name") or "",
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                })
            messages.append({
                "role": "assistant",
                "content": reply.get("content") or "",
                "tool_calls": assistant_calls,
            })
            for index, call in enumerate(tool_calls):
                name = call.get("name") or ""
                arguments = call.get("arguments")
                if not isinstance(arguments, dict):
                    arguments = {}
                result = self.registry.call(name, arguments)
                transcript.append({
                    "step": steps,
                    "tool": name,
                    "arguments": arguments,
                    "result": self._summarize_result(result),
                })
                if name in ("update_rule", "save_rule") and result.get("success"):
                    updated = True
                messages.append({
                    "role": "tool",
                    "tool_call_id": assistant_calls[index]["id"],
                    "content": self._tool_content(result),
                })
        try:
            latest = self.store.get(rule_id)
        except RuleError:
            latest = None
        if latest is None:
            return {
                "success": False,
                "repaired": False,
                "ruleId": rule_id,
                "error": "规则已被删除，无法修复",
                "steps": steps,
                "transcript": transcript,
                "tookMs": int((time.time() - started) * 1000),
            }
        test = self.search.test_rule(latest, keyword, limit=10)
        success = bool(test.get("ok"))
        return {
            "success": success,
            "repaired": success,
            "updated": updated,
            "ruleId": rule_id,
            "rule": public_rule_view(latest, include_parse=True),
            "test": self._test_view(test),
            "steps": steps,
            "message": final_content[:500],
            "error": "" if success else (test.get("error") or "自动修复未成功，规则仍无结果"),
            "transcript": transcript,
            "tookMs": int((time.time() - started) * 1000),
        }

    # ------------------------------------------------- submission -> chat rule
    def generate_for_submission(self, submission: dict, session_id: str = "",
                                reasoning_effort: Optional[str] = None) -> dict:
        """在真实会话里让 agent 为一条成员提交生成规则。

        与早先的 generate 不同：这里复用会话机制，生成过程会完整落盘，
        用户可以在 GUI 的 Agent 对话里接着追问或手动微调。
        """
        started = time.time()
        effort = self.submission_effort if reasoning_effort is None else str(reasoning_effort or "").strip()
        submission = submission or {}
        url = str(submission.get("url") or "").strip()
        name = str(submission.get("name") or "").strip() or url
        keyword = str(submission.get("keyword") or "").strip() or "电影"
        note = str(submission.get("note") or "").strip()
        if not url:
            return {
                "success": False,
                "sessionId": session_id,
                "error": "提交记录缺少站点 URL",
                "steps": 0,
                "transcript": [],
                "tookMs": 0,
            }
        if not session_id:
            session = self.new_session(title=("生成规则：" + name)[:32], reasoning_effort=effort)
            session_id = session["id"]
        else:
            try:
                session = self._load_session(session_id)
            except RuleError:
                session = self.new_session(title=("生成规则：" + name)[:32], reasoning_effort=effort)
                session_id = session["id"]
            session["reasoning_effort"] = effort
            self._save_session(session)
            if session.get("title") in (None, "", "新对话"):
                session["title"] = ("生成规则：" + name)[:32]
                self._save_session(session)

        lines = [
            "请为下面这个成员提交的站点生成一起看搜索规则，并用 test_rule 验证到有结果后保存：",
            "站点地址：%s" % url,
            "站点名称：%s" % name,
            "规则 name 请由你起一个可读的站点名（优先页面标题/品牌名，不要直接填域名）；如果上面的站点名称是域名或空，也请替换成可读名称。",
            "测试关键词：%s" % keyword,
        ]
        if note:
            lines.append("补充说明：%s" % note)
        lines.append("保存后请用一句话说明规则 id 与测试结果；不要新建与现有规则重复的站点规则。")
        message = "\n".join(lines)

        result = self.chat(
            message,
            session_id=session_id,
            context={"submission_id": submission.get("id") or ""},
            reasoning_effort=effort,
        )
        reply = str(result.get("reply") or "")
        if not result.get("success"):
            return {
                "success": False,
                "sessionId": session_id,
                "reply": reply,
                "steps": result.get("steps") or 0,
                "transcript": result.get("transcript") or [],
                "error": result.get("error") or "模型调用失败",
                "tookMs": int((time.time() - started) * 1000),
            }

        host = (urlsplit(url).hostname or "").lower()
        if host.startswith("www."):
            host = host[4:]
        latest = self._find_rule_for_site(host)
        if latest is None:
            return {
                "success": False,
                "sessionId": session_id,
                "reply": reply,
                "steps": result.get("steps") or 0,
                "transcript": result.get("transcript") or [],
                "error": "模型已回复但没有保存该站点的规则，可在 Agent 对话里继续要求它保存",
                "tookMs": int((time.time() - started) * 1000),
            }

        test = self.search.test_rule(latest, keyword, limit=10)
        success = bool(test.get("ok"))
        return {
            "success": success,
            "sessionId": session_id,
            "reply": reply,
            "steps": result.get("steps") or 0,
            "ruleId": latest.get("id") or "",
            "rule": public_rule_view(latest, include_parse=True),
            "test": self._test_view(test),
            "error": "" if success else (test.get("error") or "规则已保存但测试没有结果"),
            "transcript": result.get("transcript") or [],
            "tookMs": int((time.time() - started) * 1000),
        }

    def _find_rule_for_site(self, host: str) -> Optional[dict]:
        if not host:
            return None
        matches = []
        for rule in self.store.list(include_disabled=True):
            site = str(rule.get("site") or "").lower()
            if site.startswith("www."):
                site = site[4:]
            if site == host:
                matches.append(rule)
        if not matches:
            return None
        matches.sort(key=lambda rule: str(rule.get("updated_at") or rule.get("updatedAt") or ""), reverse=True)
        return matches[0]

    # ------------------------------------------------------------ chat sessions
    def _session_path(self, session_id: str) -> Path:
        if not re.match(r"^[A-Za-z0-9_-]{1,64}$", session_id or ""):
            raise RuleError("会话 ID 不合法")
        return self.sessions_dir / (session_id + ".json")

    def _load_session(self, session_id: str) -> dict:
        path = self._session_path(session_id)
        if not path.exists():
            raise RuleError("会话不存在: %s" % session_id)
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RuleError("会话文件损坏: %s" % exc) from exc

    def _save_session(self, session: dict) -> None:
        session["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        path = self._session_path(session["id"])
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(session, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, path)

    def list_sessions(self) -> list:
        items = []
        for path in sorted(self.sessions_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            try:
                session = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            items.append({
                "id": session.get("id"),
                "title": session.get("title") or "新对话",
                "createdAt": session.get("created_at"),
                "updatedAt": session.get("updated_at"),
                "reasoningEffort": session.get("reasoning_effort") or "",
                "model": session.get("model") or self._default_model(),
                "turns": len([m for m in session.get("messages") or [] if m.get("role") == "user"]),
            })
        return items

    def get_session(self, session_id: str) -> dict:
        session = self._load_session(session_id)
        return {
            "id": session.get("id"),
            "title": session.get("title") or "新对话",
            "createdAt": session.get("created_at"),
            "updatedAt": session.get("updated_at"),
            "reasoningEffort": session.get("reasoning_effort") or "",
            "model": session.get("model") or self._default_model(),
            "messages": [
                {
                    "role": m.get("role"),
                    "content": m.get("content") or "",
                    "at": m.get("at"),
                    **({"events": m.get("events")} if m.get("events") else {}),
                    **({"steps": m.get("steps")} if m.get("steps") is not None else {}),
                }
                for m in session.get("messages") or []
            ],
        }

    def delete_session(self, session_id: str) -> bool:
        path = self._session_path(session_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def new_session(self, title: str = "", reasoning_effort: Optional[str] = None,
                    model: Optional[str] = None) -> dict:
        session_id = "chat-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(int(time.time() * 1000) % 1000)
        effort = self.reasoning_effort if reasoning_effort is None else str(reasoning_effort or "").strip()
        model_name = str(model or self._default_model() or "").strip()
        session = {
            "id": session_id,
            "title": (title or "").strip()[:32] or "新对话",
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "reasoning_effort": effort,
            "model": model_name,
            "messages": [],
        }
        self._save_session(session)
        return {"id": session_id, "title": session["title"],
                "reasoningEffort": effort, "model": model_name, "messages": []}

    def update_session(self, session_id: str, reasoning_effort: Optional[str] = None,
                       title: Optional[str] = None, model: Optional[str] = None) -> dict:
        session = self._load_session(session_id)
        if reasoning_effort is not None:
            session["reasoning_effort"] = str(reasoning_effort or "").strip()
        if model is not None and str(model).strip():
            session["model"] = str(model).strip()
        if title is not None and title.strip():
            session["title"] = title.strip()[:32]
        self._save_session(session)
        return self.get_session(session_id)

    def chat(self, message: str, session_id: str = "", context: Optional[dict] = None,
             reasoning_effort: Optional[str] = None, model: Optional[str] = None,
             images=None, emit=None, cancel=None, autonomous: bool = True) -> dict:
        """在会话里执行一轮自主任务。

        emit(event) 用于把思考/工具过程实时推给 run 管理器；不传时只返回最终结果。
        cancel() 返回 True 时在下一个检查点停止。
        """
        started = time.time()
        message = (message or "").strip()
        if not message and images:
            message = "请查看图片。"
        if not message:
            raise RuleError("消息不能为空")
        if len(message) > 4000:
            raise RuleError("消息过长（最多 4000 字）")
        image_urls = normalize_images(images)
        if not session_id:
            session = self.new_session()
            session_id = session["id"]
        else:
            session = self._load_session(session_id)
        session_effort = str(session.get("reasoning_effort") or "").strip()
        if reasoning_effort is None:
            effort = session_effort or self.reasoning_effort
        else:
            effort = str(reasoning_effort or "").strip()
            session["reasoning_effort"] = effort
        session_model = str(session.get("model") or "").strip()
        if model is None:
            model_name = session_model or self._default_model()
        else:
            model_name = str(model or "").strip() or self._default_model()
            if model_name != session_model:
                session["model"] = model_name
        context = context or {}
        context_lines = []
        if context.get("room_id"):
            context_lines.append("当前房间 ID: %s" % context.get("room_id"))
        if context.get("rule_id"):
            context_lines.append("当前规则 ID: %s" % context.get("rule_id"))
        if context.get("role"):
            context_lines.append("操作者角色: %s" % context.get("role"))
        referenced = context.get("rules")
        if isinstance(referenced, list):
            for item in referenced[:10]:
                if not isinstance(item, dict):
                    continue
                rule_id = str(item.get("id") or "").strip()
                rule_name = str(item.get("name") or "").strip()
                rule_site = str(item.get("site") or "").strip()
                if not rule_id and not rule_name:
                    continue
                context_lines.append("引用规则 ID: %s（%s，站点 %s）" % (
                    rule_id or "-", rule_name or "-", rule_site or "-"))
        user_text = message
        if context_lines:
            user_text += "\n\n[上下文] " + "；".join(context_lines)
        history = [
            {"role": m.get("role"), "content": m.get("content") or ""}
            for m in (session.get("messages") or [])[-30:]
            if m.get("role") in ("user", "assistant")
        ]
        max_steps = self.chat_max_steps if autonomous else self.max_steps
        user_message = {"role": "user", "content": user_text}
        if image_urls:
            user_message["content"] = [
                {"type": "text", "text": user_text},
            ] + [
                {"type": "image_url", "image_url": {"url": url}} for url in image_urls
            ]
        # 先把用户消息落盘：生成/对话可能要跑几十秒，期间 GUI 打开这个会话时
        # 至少能看到用户要求；否则会话在完成前是空的，看起来像"内容显示不出来"。
        started_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        session.setdefault("messages", []).append({"role": "user", "content": user_text, "at": started_at})
        if session.get("title") in ("", None, "新对话"):
            session["title"] = message[:24]
        self._save_session(session)
        messages = [
            {"role": "system", "content": self._system_prompt(CHAT_SYSTEM_PROMPT % (RULE_GUIDE,))},
        ] + history + [user_message]
        tools = self.registry.openai_tools()
        if autonomous:
            tools = tools + [TASK_COMPLETE_TOOL, RENAME_SESSION_TOOL, ASK_USER_TOOL]

        cancelled = False
        completed = False
        awaiting_user = False
        truncated = False
        final_content = ""
        error = ""
        steps = 0
        continuations = 0
        transcript = []
        work_items = []
        last_turn_content = ""

        def emit_event(kind: str, **payload) -> None:
            if emit is None:
                return
            event = {"kind": kind}
            event.update(payload)
            try:
                emit(event)
            except Exception:  # noqa: BLE001 - 推送失败不能打断任务
                pass

        def is_cancelled() -> bool:
            if cancel is None:
                return False
            try:
                return bool(cancel())
            except Exception:  # noqa: BLE001
                return False

        emit_event("run", status="running", sessionId=session_id)
        while max_steps <= 0 or steps < max_steps:
            if is_cancelled():
                cancelled = True
                break
            steps += 1
            emit_event("step", step=steps)
            reasoning_parts: list = []
            content_parts: list = []
            think_started = [0.0]
            last_think_emit = [0.0]
            think_id = "think-%d" % steps

            def on_delta(kind: str, text: str) -> None:
                if kind == "reasoning":
                    if not reasoning_parts:
                        think_started[0] = time.time()
                        emit_event("thinking", id=think_id, text="", done=False, step=steps)
                    reasoning_parts.append(text)
                    now = time.time()
                    if now - last_think_emit[0] >= 0.35:
                        last_think_emit[0] = now
                        emit_event("thinking", id=think_id, text="".join(reasoning_parts)[:20000],
                                   done=False, step=steps)
                elif kind == "content":
                    content_parts.append(text)

            try:
                reply = self.llm.chat_stream(
                    messages,
                    tools=tools,
                    tool_choice="auto",
                    reasoning_effort=effort,
                    model=model_name,
                    on_delta=on_delta,
                    cancel=is_cancelled,
                )
            except LLMError as exc:
                if cancelled or (exc.details or {}).get("cancelled"):
                    cancelled = True
                    break
                error = exc.message
                break
            reasoning = reply.get("reasoning") or "".join(reasoning_parts)
            reasoning = (reasoning or "").strip()
            if reasoning:
                duration_ms = int((time.time() - (think_started[0] or time.time())) * 1000)
                emit_event("thinking", id=think_id, text=reasoning[:20000], done=True,
                           durationMs=duration_ms, step=steps)
                work_items.append({
                    "kind": "thinking",
                    "id": think_id,
                    "text": reasoning[:20000],
                    "durationMs": duration_ms,
                })
            turn_content = reply.get("content") or "".join(content_parts) or ""
            if turn_content.strip():
                last_turn_content = turn_content.strip()
            tool_calls = reply.get("toolCalls") or []
            if is_cancelled():
                cancelled = True
                break
            if not tool_calls:
                final_content = turn_content.strip()
                if autonomous and not completed and continuations < self.auto_continue \
                        and (max_steps <= 0 or steps < max_steps):
                    continuations += 1
                    messages.append({"role": "assistant", "content": turn_content})
                    nudge = ("继续执行：如果还有未完成的步骤就继续调用工具；如果需要用户提供信息或做决定，"
                             "调用 ask_user 暂停本轮；任务完成则调用 task_complete 给出最终答复。")
                    messages.append({"role": "user", "content": nudge})
                    emit_event("continue", text=nudge, step=steps)
                    continue
                break
            assistant_calls = []
            for index, call in enumerate(tool_calls):
                arguments = call.get("arguments")
                if not isinstance(arguments, dict):
                    arguments = {}
                assistant_calls.append({
                    "id": call.get("id") or ("call_%d_%d" % (steps, index)),
                    "type": "function",
                    "function": {
                        "name": call.get("name") or "",
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                })
            messages.append({
                "role": "assistant",
                "content": turn_content,
                "tool_calls": assistant_calls,
            })
            if turn_content.strip():
                note = turn_content.strip()[:4000]
                emit_event("note", text=note, step=steps)
                work_items.append({"kind": "note", "text": note})
            for index, call in enumerate(tool_calls):
                name = call.get("name") or ""
                arguments = call.get("arguments")
                if not isinstance(arguments, dict):
                    arguments = {}
                call_id = assistant_calls[index]["id"]
                emit_event("tool", id=call_id, name=name, arguments=arguments,
                           status="running", step=steps)
                if name == "task_complete":
                    summary = arguments.get("summary")
                    if not isinstance(summary, str) or not summary.strip():
                        summary = turn_content
                    final_content = (summary or "").strip() or last_turn_content
                    completed = True
                    finished = {
                        "kind": "tool",
                        "id": call_id,
                        "name": name,
                        "arguments": arguments,
                        "status": "ok",
                        "summary": {"completed": True},
                        "durationMs": 0,
                        "step": steps,
                    }
                    work_items.append(finished)
                    emit_event("tool", id=call_id, name=name, arguments=arguments,
                               status="ok", summary={"completed": True}, durationMs=0,
                               step=steps)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": json.dumps({"success": True, "completed": True},
                                              ensure_ascii=False),
                    })
                    break
                if name == "rename_session":
                    title = arguments.get("title")
                    title = str(title or "").strip()[:32]
                    if not title:
                        result = {"success": False, "error": "标题不能为空"}
                        status = "error"
                    else:
                        session["title"] = title
                        self._save_session(session)
                        result = {"success": True, "title": title}
                        status = "ok"
                    finished = {
                        "kind": "tool",
                        "id": call_id,
                        "name": name,
                        "arguments": arguments,
                        "status": status,
                        "summary": {"title": title},
                        "detail": self._tool_content(result)[:2000],
                        "durationMs": 0,
                        "step": steps,
                    }
                    work_items.append(finished)
                    transcript.append({
                        "step": steps,
                        "tool": name,
                        "arguments": arguments,
                        "result": {"title": title},
                    })
                    emit_event("tool", id=call_id, name=name, arguments=arguments,
                               status=status, summary={"title": title}, durationMs=0,
                               step=steps)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": json.dumps(result, ensure_ascii=False),
                    })
                    continue
                if name == "ask_user":
                    question = arguments.get("question")
                    question = str(question or "").strip() or turn_content.strip()
                    options = arguments.get("options")
                    if isinstance(options, list):
                        choices = [str(item).strip() for item in options
                                   if str(item or "").strip()][:4]
                        if choices:
                            question = question + "\n" + "\n".join(
                                "%d. %s" % (index + 1, choice)
                                for index, choice in enumerate(choices))
                    final_content = question or last_turn_content or "需要你确认后我再继续。"
                    awaiting_user = True
                    summary = {"awaitingUser": True}
                    finished = {
                        "kind": "tool",
                        "id": call_id,
                        "name": name,
                        "arguments": arguments,
                        "status": "ok",
                        "summary": summary,
                        "durationMs": 0,
                        "step": steps,
                    }
                    work_items.append(finished)
                    transcript.append({
                        "step": steps,
                        "tool": name,
                        "arguments": arguments,
                        "result": {"awaitingUser": True},
                    })
                    emit_event("tool", id=call_id, name=name, arguments=arguments,
                               status="ok", summary=summary, durationMs=0, step=steps)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": json.dumps({"success": True, "awaitingUser": True},
                                              ensure_ascii=False),
                    })
                    break
                tool_started = time.time()
                try:
                    result = self.registry.call(name, arguments)
                except Exception as exc:  # noqa: BLE001 - 工具异常交给模型修正
                    result = {"success": False, "error": str(exc)[:500]}
                duration_ms = int((time.time() - tool_started) * 1000)
                summary = self._summarize_result(result)
                status = "ok" if not (isinstance(result, dict) and result.get("success") is False) else "error"
                finished = {
                    "kind": "tool",
                    "id": call_id,
                    "name": name,
                    "arguments": arguments,
                    "status": status,
                    "summary": summary,
                    "detail": self._tool_content(result)[:2000],
                    "durationMs": duration_ms,
                    "step": steps,
                }
                work_items.append(finished)
                emit_event("tool", id=call_id, name=name, arguments=arguments,
                           status=status, summary=summary,
                           detail=self._tool_content(result)[:2000],
                           durationMs=duration_ms, step=steps)
                transcript.append({
                    "step": steps,
                    "tool": name,
                    "arguments": arguments,
                    "result": summary,
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": self._tool_content(result),
                })
            if completed or cancelled or awaiting_user:
                break
        if max_steps > 0 and steps >= max_steps and not completed and not cancelled \
                and not awaiting_user:
            truncated = True
        if is_cancelled():
            cancelled = True
        if not final_content:
            final_content = last_turn_content
        if cancelled:
            final_content = final_content or "已停止生成。"
        elif not final_content:
            final_content = "（模型没有返回文字，请重试或补充信息）"

        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        assistant_message = {"role": "assistant", "content": final_content, "at": now,
                             "steps": steps}
        if work_items:
            assistant_message["events"] = work_items
        session["messages"].append(assistant_message)
        if session.get("title") in ("", None, "新对话"):
            session["title"] = message[:24]
        self._save_session(session)
        took_ms = int((time.time() - started) * 1000)
        if error:
            result = {
                "success": False,
                "sessionId": session_id,
                "error": error,
                "reply": final_content,
                "steps": steps,
                "transcript": transcript,
                "events": work_items,
                "messages": self.get_session(session_id)["messages"],
                "tookMs": took_ms,
            }
            emit_event("error", error=error, reply=final_content, steps=steps, tookMs=took_ms)
            return result
        if cancelled:
            result = {
                "success": False,
                "cancelled": True,
                "sessionId": session_id,
                "error": "已停止生成",
                "reply": final_content,
                "steps": steps,
                "transcript": transcript,
                "events": work_items,
                "messages": self.get_session(session_id)["messages"],
                "tookMs": took_ms,
            }
            emit_event("cancelled", reply=final_content, steps=steps, tookMs=took_ms)
            return result
        result = {
            "success": True,
            "sessionId": session_id,
            "reasoningEffort": effort,
            "model": model_name,
            "reply": final_content,
            "steps": steps,
            "truncated": truncated,
            "completed": completed,
            "awaitingUser": awaiting_user,
            "transcript": transcript,
            "events": work_items,
            "messages": self.get_session(session_id)["messages"],
            "tookMs": took_ms,
        }
        emit_event("done", reply=final_content, steps=steps, truncated=truncated,
                   completed=completed, awaitingUser=awaiting_user, tookMs=took_ms)
        return result

    @staticmethod
    def _test_view(test: Optional[dict]) -> Optional[dict]:
        if not test:
            return None
        return {
            "ok": test.get("ok"),
            "count": test.get("count"),
            "error": test.get("error"),
            "items": (test.get("items") or [])[:3],
            "pageUrl": test.get("pageUrl"),
        }

    @staticmethod
    def _tool_content(result: dict) -> str:
        text = json.dumps(result, ensure_ascii=False)
        return text[:8000]

    @staticmethod
    def _summarize_result(result: dict) -> dict:
        if not isinstance(result, dict):
            return {"result": str(result)[:200]}
        summary = {}
        for key in ("success", "ok", "count", "error", "code", "ruleId", "saved", "deleted"):
            if key in result:
                summary[key] = result[key]
        return summary

    @staticmethod
    def _extract_rule(content: str) -> Optional[dict]:
        content = content or ""
        fenced = re.findall(r"(?s)\x60{3}(?:json)?\s*(\{.*?\})\s*\x60{3}", content)
        candidates = fenced + [content]
        for candidate in candidates:
            for match in re.finditer(r"\{", candidate):
                try:
                    value, _ = json.JSONDecoder().raw_decode(candidate[match.start():])
                except ValueError:
                    continue
                if isinstance(value, dict) and ("search" in value or "parse" in value):
                    return value
        return None
