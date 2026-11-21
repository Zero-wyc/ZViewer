package crawler

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// LLM agent：把一个站点 URL 变成一条保存好的 JSON 搜索规则，
// 以及在持续会话里帮管理员维护规则（生成 / 修复 / 对话）。
//
// 对应 Python 版 agent.py。三条系统提示词、task_complete / ask_user /
// rename_session 的语义、auto_continue 的续跑提醒、会话落盘格式都与
// Python 版一致——GUI 的 Agent 对话页只认这些形状。

const generateSystemPromptTemplate = `你是 ZViewer 的站点规则生成器。用户会给你一个影视/资源站点的 URL，
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
   - 站点接口在 /api/* 后面、被 Cloudflare/JS 拦时，写 play.script（脚本里 fetch 站点接口，见规则格式说明）再 test_play。
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
- 最多执行 %d 步工具调用，请高效。`

const chatSystemPromptTemplate = `你是 ZViewer 的爬虫规则助手，在一个持续对话里帮管理员维护站点搜索规则。
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
- 工具调用次数不设上限：按需调用，直到完成或需要用户决定；但不要重复无效尝试，同一问题连续 2~3 次失败就停下来用 ask_user 询问用户。`

const repairSystemPromptTemplate = `你是 ZViewer 的站点规则修复助手。一条已保存的规则在执行搜索时失败了，
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
- 不要编造 selector；不要删除规则。`

// taskCompleteTool / askUserTool / renameSessionTool 只在自主执行的对话里注入。
func controlTool(name, description string, properties map[string]any, required ...string) map[string]any {
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        name,
			"description": description,
			"parameters":  schema,
		},
	}
}

var taskCompleteTool = controlTool(
	"task_complete",
	"当用户交办的任务已经全部完成时调用，summary 写要展示给用户的最终答复。任务没完成前不要调用；也不要用普通文字替代这个调用。",
	map[string]any{
		"summary": StrProp("最终答复：完成了什么、规则 id/站点、验证结果或无法完成的原因。"),
	},
	"summary",
)

var renameSessionTool = controlTool(
	"rename_session",
	"给当前会话重命名。开始处理任务后，用一句不超过 16 个中文字符的短语概括这次对话的主题。",
	map[string]any{
		"title": StrProp("新的会话标题，最多 32 个字符，不要带引号。"),
	},
	"title",
)

var askUserTool = controlTool(
	"ask_user",
	"当任务无法继续、需要用户提供信息或做决定时调用：说明卡在哪里、需要用户做什么；有明确选项时用 options 给出 2~4 个。调用后本轮结束，等用户回复后再继续。",
	map[string]any{
		"question": StrProp("给用户看的问题：说明卡在哪里、需要用户提供什么或决定什么。"),
		"options":  map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "可选：2~4 个建议选项，方便用户直接选择。"},
	},
	"question",
)

var imageDataRe = regexp.MustCompile(`^data:image/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$`)

const (
	maxImages     = 4
	maxImageChars = 3000000
)

// NormalizeImages 校验前端传来的图片 data URL，最多 4 张。
func NormalizeImages(images []string) ([]string, error) {
	out := make([]string, 0, len(images))
	for index, item := range images {
		if index >= maxImages {
			break
		}
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if len(item) > maxImageChars {
			return nil, RuleError("单张图片过大，请压缩后再发送", nil)
		}
		if !imageDataRe.MatchString(item) {
			return nil, RuleError("图片格式不支持，请使用 PNG/JPEG/WebP/GIF", nil)
		}
		out = append(out, item)
	}
	return out, nil
}

// AgentConfig 是 config.json 里与 agent 相关的段。
type AgentConfig struct {
	// MaxSteps 对应 generation.max_steps（生成/修复循环的上限，默认 12）。
	MaxSteps int
	// ChatMaxSteps 对应 agent.max_steps（0 = 对话不设上限）。
	ChatMaxSteps int
	// AutoContinue 是模型只回文字没调工具时的续跑次数（默认 2）。
	AutoContinue     int
	SampleKeyword    string
	ReasoningEffort  string
	GenerationEffort string
	CustomPrompt     string
}

// AgentEmit 把执行过程实时推给调用方（run 管理器 / SSE）。
type AgentEmit func(event map[string]any)

// AgentCancel 返回 true 时在下一个检查点停止。
type AgentCancel func() bool

// RuleAgent 是规则生成/修复/对话的执行器。
type RuleAgent struct {
	llm         *LLMClient
	registry    *ToolRegistry
	store       *RuleStore
	search      *SearchService
	config      AgentConfig
	sessionsDir string
}

// NewRuleAgent 构造 agent；dataDir 下的 sessions/ 存对话。
func NewRuleAgent(llm *LLMClient, registry *ToolRegistry, store *RuleStore,
	search *SearchService, config AgentConfig, dataDir string) (*RuleAgent, error) {
	if config.MaxSteps <= 0 {
		config.MaxSteps = 12
	}
	if config.AutoContinue < 0 {
		config.AutoContinue = 0
	}
	if config.SampleKeyword == "" {
		config.SampleKeyword = "电影"
	}
	dir := dataDir
	if dir == "" {
		dir = "data"
	}
	sessions := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessions, 0o755); err != nil {
		return nil, ConfigError("无法创建会话目录: " + err.Error())
	}
	return &RuleAgent{
		llm:         llm,
		registry:    registry,
		store:       store,
		search:      search,
		config:      config,
		sessionsDir: sessions,
	}, nil
}

// DefaultModel 当前 LLM 客户端配置的模型名。
func (a *RuleAgent) DefaultModel() string { return strings.TrimSpace(a.llm.config.Model) }

// HasTool 判断某个工具是否已注册（测试与诊断用）。
func (a *RuleAgent) HasTool(name string) bool { return a.registry.Has(name) }

func (a *RuleAgent) systemPrompt(base string) string {
	custom := strings.TrimSpace(a.config.CustomPrompt)
	if custom == "" {
		return base
	}
	return base + "\n\n【管理员自定义指令】\n" + truncateRunes(custom, 4000) +
		"\n（以上自定义指令在不违反前面的安全与流程约束时生效。）"
}

// ---------------------------------------------------------------- 生成与修复

// Generate 由站点 URL 生成规则（generate_rule 工具与 /api/crawler/generate）。
func (a *RuleAgent) Generate(ctx context.Context, rawURL, keyword, notes, effortOverride string) (map[string]any, error) {
	started := time.Now()
	effort := a.config.GenerationEffort
	if strings.TrimSpace(effortOverride) != "" {
		effort = strings.TrimSpace(effortOverride)
	}
	target := strings.TrimSpace(rawURL)
	if !httpURLRe.MatchString(target) {
		if target != "" && strings.Contains(target, ".") {
			target = "https://" + target
		} else {
			return map[string]any{"success": false, "error": "请提供有效的站点 URL"}, nil
		}
	}
	keyword = strings.TrimSpace(keyword)
	if keyword == "" {
		keyword = a.config.SampleKeyword
	}
	host := HostOf(target)
	base := fmt.Sprintf(generateSystemPromptTemplate, RuleGuide, a.config.MaxSteps)
	messages := []map[string]any{
		{"role": "system", "content": a.systemPrompt(base)},
		{
			"role": "user",
			"content": fmt.Sprintf("站点 URL: %s\n试搜关键词: %s\n额外要求: %s\n请生成并保存规则。",
				target, keyword, firstNonEmpty(notes, "无")),
		},
	}
	tools := a.registry.OpenAITools()
	var savedRule *Rule
	var lastTest map[string]any
	transcript := make([]map[string]any, 0, 8)
	finalContent := ""
	errorText := ""
	steps := 0
	for steps < a.config.MaxSteps {
		steps++
		reply, err := a.llm.Chat(ctx, messages, ChatOptions{
			Tools:           tools,
			ToolChoice:      "auto",
			ReasoningEffort: effort,
		})
		if err != nil {
			return map[string]any{
				"success": false, "error": err.Error(), "steps": steps,
				"transcript": transcript, "tookMs": millisSince(started),
			}, nil
		}
		if reply.Content != "" {
			finalContent = reply.Content
		}
		if len(reply.ToolCalls) == 0 {
			if candidate := extractRuleJSON(reply.Content); candidate != nil {
				if _, ok := candidate["site"]; !ok {
					candidate["site"] = host
				}
				if _, ok := candidate["name"]; !ok {
					candidate["name"] = host
				}
				encoded, _ := json.Marshal(candidate)
				var rule Rule
				if json.Unmarshal(encoded, &rule) == nil {
					if _, err := Validate(&rule); err == nil {
						test := a.search.TestRule(&rule, keyword, 10)
						lastTest = test
						transcript = append(transcript, map[string]any{
							"step": steps, "action": "final_rule_json",
							"test": map[string]any{"ok": test["ok"], "count": test["count"]},
						})
						if boolValue(test["ok"]) {
							saved, saveErr := a.store.Save(&rule, rule.ID)
							if saveErr == nil {
								savedRule = saved
								break
							}
							errorText = saveErr.Error()
						} else {
							errorText = fmt.Sprintf("规则试搜失败: %s", firstNonEmpty(stringOf(test["error"]), "没有解析到结果"))
						}
						messages = append(messages,
							map[string]any{"role": "assistant", "content": reply.Content},
							map[string]any{"role": "user", "content": fmt.Sprintf(
								"上面的规则试搜没有结果（%s）。请用 fetch_page/inspect_html 检查页面，修正后重新 test_rule 并 save_rule。", errorText)})
						continue
					} else {
						errorText = err.Error()
						messages = append(messages,
							map[string]any{"role": "assistant", "content": reply.Content},
							map[string]any{"role": "user", "content": fmt.Sprintf("规则校验失败：%s。请修正后调用 save_rule。", errorText)})
						continue
					}
				}
			}
			break
		}
		assistant := buildAssistantMessage(reply, steps, "call")
		messages = append(messages, assistant)
		for index, call := range reply.ToolCalls {
			result := a.registry.Call(ctx, call.Name, call.Arguments)
			transcript = append(transcript, map[string]any{
				"step": steps, "tool": call.Name,
				"arguments": call.Arguments, "result": summarizeResult(result),
			})
			if call.Name == "test_rule" {
				lastTest = result
			}
			if call.Name == "save_rule" && boolValue(result["success"]) {
				if view, ok := result["rule"].(*Rule); ok {
					savedRule = view
				} else if view, ok := result["rule"].(map[string]any); ok {
					if id := stringOf(view["id"]); id != "" {
						savedRule, _ = a.store.Get(id)
					}
				}
			}
			messages = append(messages, map[string]any{
				"role":         "tool",
				"tool_call_id": assistant["tool_call_ids"].([]string)[index],
				"content":      toolContent(result),
			})
			if savedRule != nil {
				break
			}
		}
		if savedRule != nil {
			break
		}
	}
	if savedRule != nil {
		return map[string]any{
			"success": true, "saved": true, "ruleId": savedRule.ID,
			"rule": PublicView(savedRule, true), "test": testView(lastTest),
			"steps": steps, "message": truncateRunes(finalContent, 500),
			"transcript": transcript, "tookMs": millisSince(started),
		}, nil
	}
	return map[string]any{
		"success": false, "saved": false,
		"error": firstNonEmpty(errorText, "模型未能在限定步数内生成并保存规则"),
		"test":  testView(lastTest), "steps": steps,
		"message":    truncateRunes(finalContent, 1000),
		"transcript": transcript, "tookMs": millisSince(started),
	}, nil
}

// Repair 修复一条执行失败的规则（SearchService 在搜索失败时回调）。
func (a *RuleAgent) Repair(ctx context.Context, rule *Rule, keyword, errMsg, effortOverride string) (map[string]any, error) {
	started := time.Now()
	effort := a.config.ReasoningEffort
	if strings.TrimSpace(effortOverride) != "" {
		effort = strings.TrimSpace(effortOverride)
	}
	ruleID := ""
	if rule != nil {
		ruleID = rule.ID
	}
	if ruleID == "" {
		return map[string]any{
			"success": false, "repaired": false,
			"error": "缺少规则 ID，无法自动修复", "steps": 0,
			"transcript": []map[string]any{}, "tookMs": 0,
		}, nil
	}
	keyword = strings.TrimSpace(keyword)
	if keyword == "" {
		keyword = a.config.SampleKeyword
	}
	current, err := a.store.Get(ruleID)
	if err != nil {
		return map[string]any{
			"success": false, "repaired": false, "ruleId": ruleID,
			"error": err.Error(), "steps": 0,
			"transcript": []map[string]any{}, "tookMs": millisSince(started),
		}, nil
	}
	currentJSON, _ := json.MarshalIndent(current, "", "  ")
	base := fmt.Sprintf(repairSystemPromptTemplate, ruleID, string(currentJSON), keyword,
		firstNonEmpty(errMsg, "规则没有返回结果"), ruleID, a.config.MaxSteps)
	messages := []map[string]any{
		{"role": "system", "content": a.systemPrompt(base)},
		{"role": "user", "content": fmt.Sprintf("请修复规则 %s，并用关键词「%s」验证。", ruleID, keyword)},
	}
	tools := a.registry.OpenAITools()
	transcript := make([]map[string]any, 0, 8)
	finalContent := ""
	steps := 0
	updated := false
	for steps < a.config.MaxSteps {
		steps++
		reply, chatErr := a.llm.Chat(ctx, messages, ChatOptions{
			Tools:           tools,
			ToolChoice:      "auto",
			ReasoningEffort: effort,
		})
		if chatErr != nil {
			return map[string]any{
				"success": false, "repaired": false, "ruleId": ruleID,
				"error": chatErr.Error(), "steps": steps,
				"transcript": transcript, "tookMs": millisSince(started),
			}, nil
		}
		if reply.Content != "" {
			finalContent = reply.Content
		}
		if len(reply.ToolCalls) == 0 {
			break
		}
		assistant := buildAssistantMessage(reply, steps, "repair")
		messages = append(messages, assistant)
		ids := assistant["tool_call_ids"].([]string)
		for index, call := range reply.ToolCalls {
			result := a.registry.Call(ctx, call.Name, call.Arguments)
			transcript = append(transcript, map[string]any{
				"step": steps, "tool": call.Name,
				"arguments": call.Arguments, "result": summarizeResult(result),
			})
			if (call.Name == "update_rule" || call.Name == "save_rule") && boolValue(result["success"]) {
				updated = true
			}
			messages = append(messages, map[string]any{
				"role": "tool", "tool_call_id": ids[index], "content": toolContent(result),
			})
		}
	}
	latest, latestErr := a.store.Get(ruleID)
	if latestErr != nil {
		return map[string]any{
			"success": false, "repaired": false, "ruleId": ruleID,
			"error": "规则已被删除，无法修复", "steps": steps,
			"transcript": transcript, "tookMs": millisSince(started),
		}, nil
	}
	test := a.search.TestRule(latest, keyword, 10)
	success := boolValue(test["ok"])
	return map[string]any{
		"success": success, "repaired": success, "updated": updated,
		"ruleId": ruleID, "rule": PublicView(latest, true), "test": testView(test),
		"steps": steps, "message": truncateRunes(finalContent, 500),
		"error":      firstNonEmptyIf(!success, stringOf(test["error"]), "自动修复未成功，规则仍无结果"),
		"transcript": transcript, "tookMs": millisSince(started),
	}, nil
}

// ---------------------------------------------------------------- 会话存取

type chatSession struct {
	ID              string           `json:"id"`
	Title           string           `json:"title"`
	CreatedAt       string           `json:"created_at"`
	UpdatedAt       string           `json:"updated_at"`
	ReasoningEffort string           `json:"reasoning_effort"`
	Model           string           `json:"model"`
	Messages        []map[string]any `json:"messages"`
}

var sessionIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (a *RuleAgent) sessionPath(sessionID string) (string, error) {
	if !sessionIDRe.MatchString(sessionID) {
		return "", RuleError("会话 ID 不合法", nil)
	}
	return filepath.Join(a.sessionsDir, sessionID+".json"), nil
}

func (a *RuleAgent) loadSession(sessionID string) (*chatSession, error) {
	path, err := a.sessionPath(sessionID)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, RuleError("会话不存在: "+sessionID, nil)
		}
		return nil, RuleError("会话文件损坏: "+err.Error(), nil)
	}
	var session chatSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return nil, RuleError("会话文件损坏: "+err.Error(), nil)
	}
	return &session, nil
}

func (a *RuleAgent) saveSession(session *chatSession) error {
	session.UpdatedAt = NowISO()
	path, err := a.sessionPath(session.ID)
	if err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return RuleErrorf("会话序列化失败: %v", err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(encoded, '\n'), 0o644); err != nil {
		return RuleErrorf("会话写入失败: %v", err)
	}
	return os.Rename(tmp, path)
}

// ListSessions 按修改时间倒序列出会话摘要。
func (a *RuleAgent) ListSessions() []map[string]any {
	entries, err := os.ReadDir(a.sessionsDir)
	if err != nil {
		return []map[string]any{}
	}
	type entry struct {
		modTime time.Time
		session chatSession
	}
	items := make([]entry, 0, len(entries))
	for _, item := range entries {
		if item.IsDir() || !strings.HasSuffix(item.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(a.sessionsDir, item.Name()))
		if err != nil {
			continue
		}
		var session chatSession
		if json.Unmarshal(raw, &session) != nil {
			continue
		}
		info, statErr := item.Info()
		if statErr != nil {
			continue
		}
		items = append(items, entry{modTime: info.ModTime(), session: session})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].modTime.After(items[j].modTime) })
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		turns := 0
		for _, message := range item.session.Messages {
			if stringOf(message["role"]) == "user" {
				turns++
			}
		}
		model := item.session.Model
		if model == "" {
			model = a.DefaultModel()
		}
		out = append(out, map[string]any{
			"id":              item.session.ID,
			"title":           firstNonEmpty(item.session.Title, "新对话"),
			"createdAt":       item.session.CreatedAt,
			"updatedAt":       item.session.UpdatedAt,
			"reasoningEffort": item.session.ReasoningEffort,
			"model":           model,
			"turns":           turns,
		})
	}
	return out
}

// GetSession 读取一个会话的完整消息。
func (a *RuleAgent) GetSession(sessionID string) (map[string]any, error) {
	session, err := a.loadSession(sessionID)
	if err != nil {
		return nil, err
	}
	messages := make([]map[string]any, 0, len(session.Messages))
	for _, message := range session.Messages {
		view := map[string]any{
			"role":    message["role"],
			"content": firstNonEmpty(stringOf(message["content"]), ""),
			"at":      message["at"],
		}
		if events, ok := message["events"]; ok {
			view["events"] = events
		}
		if steps, ok := message["steps"]; ok {
			view["steps"] = steps
		}
		messages = append(messages, view)
	}
	model := session.Model
	if model == "" {
		model = a.DefaultModel()
	}
	return map[string]any{
		"id":              session.ID,
		"title":           firstNonEmpty(session.Title, "新对话"),
		"createdAt":       session.CreatedAt,
		"updatedAt":       session.UpdatedAt,
		"reasoningEffort": session.ReasoningEffort,
		"model":           model,
		"messages":        messages,
	}, nil
}

// DeleteSession 删除一个会话。
func (a *RuleAgent) DeleteSession(sessionID string) bool {
	path, err := a.sessionPath(sessionID)
	if err != nil {
		return false
	}
	if _, statErr := os.Stat(path); statErr != nil {
		return false
	}
	_ = os.Remove(path)
	return true
}

// NewSession 建一个空会话。
func (a *RuleAgent) NewSession(title, effort, model string) (map[string]any, error) {
	now := time.Now()
	sessionID := fmt.Sprintf("chat-%s-%03d", now.Format("20060102-150405"), now.UnixMilli()%1000)
	trimmedEffort := strings.TrimSpace(effort)
	if trimmedEffort == "" {
		trimmedEffort = a.config.ReasoningEffort
	}
	modelName := strings.TrimSpace(model)
	if modelName == "" {
		modelName = a.DefaultModel()
	}
	session := &chatSession{
		ID:              sessionID,
		Title:           truncateRunes(strings.TrimSpace(title), 32),
		CreatedAt:       NowISO(),
		UpdatedAt:       NowISO(),
		ReasoningEffort: trimmedEffort,
		Model:           modelName,
		Messages:        []map[string]any{},
	}
	if session.Title == "" {
		session.Title = "新对话"
	}
	if err := a.saveSession(session); err != nil {
		return nil, err
	}
	return map[string]any{
		"id": sessionID, "title": session.Title,
		"reasoningEffort": trimmedEffort, "model": modelName, "messages": []map[string]any{},
	}, nil
}

// UpdateSession 改会话的标题 / 推理力度 / 模型。
func (a *RuleAgent) UpdateSession(sessionID, effort, title, model string) (map[string]any, error) {
	session, err := a.loadSession(sessionID)
	if err != nil {
		return nil, err
	}
	if effort != "" || strings.TrimSpace(effort) != "" {
		session.ReasoningEffort = strings.TrimSpace(effort)
	}
	if trimmed := strings.TrimSpace(model); trimmed != "" {
		session.Model = trimmed
	}
	if trimmed := strings.TrimSpace(title); trimmed != "" {
		session.Title = truncateRunes(trimmed, 32)
	}
	if err := a.saveSession(session); err != nil {
		return nil, err
	}
	return a.GetSession(sessionID)
}

// ChatRequest 是一轮对话的入参。
type ChatRequest struct {
	Message         string
	SessionID       string
	Context         map[string]any
	ReasoningEffort string
	Model           string
	Images          []string
	// Autonomous 打开后注入 task_complete / rename_session / ask_user 并允许续跑。
	Autonomous bool
	Emit       AgentEmit
	Cancel     AgentCancel
}

// Chat 在会话里执行一轮自主任务。事件通过 req.Emit 实时推送。
func (a *RuleAgent) Chat(ctx context.Context, req ChatRequest) (map[string]any, error) {
	started := time.Now()
	message := strings.TrimSpace(req.Message)
	if message == "" && len(req.Images) > 0 {
		message = "请查看图片。"
	}
	if message == "" {
		return nil, RuleError("消息不能为空", nil)
	}
	if len([]rune(message)) > 4000 {
		return nil, RuleError("消息过长（最多 4000 字）", nil)
	}
	imageURLs, err := NormalizeImages(req.Images)
	if err != nil {
		return nil, err
	}
	var session *chatSession
	if req.SessionID == "" {
		created, err := a.NewSession("", "", "")
		if err != nil {
			return nil, err
		}
		session, err = a.loadSession(stringOf(created["id"]))
		if err != nil {
			return nil, err
		}
	} else {
		session, err = a.loadSession(req.SessionID)
		if err != nil {
			return nil, err
		}
	}

	effort := session.ReasoningEffort
	if strings.TrimSpace(effort) == "" {
		effort = a.config.ReasoningEffort
	}
	if strings.TrimSpace(req.ReasoningEffort) != "" {
		effort = strings.TrimSpace(req.ReasoningEffort)
		session.ReasoningEffort = effort
	}
	modelName := session.Model
	if modelName == "" {
		modelName = a.DefaultModel()
	}
	if strings.TrimSpace(req.Model) != "" {
		modelName = strings.TrimSpace(req.Model)
		if modelName != session.Model {
			session.Model = modelName
		}
	}

	// 上下文行（房间 / 规则 / 角色 / 引用的规则列表）。
	contextLines := make([]string, 0, 4)
	if req.Context != nil {
		if value := stringOf(req.Context["room_id"]); value != "" {
			contextLines = append(contextLines, "当前房间 ID: "+value)
		}
		if value := stringOf(req.Context["rule_id"]); value != "" {
			contextLines = append(contextLines, "当前规则 ID: "+value)
		}
		if value := stringOf(req.Context["role"]); value != "" {
			contextLines = append(contextLines, "操作者角色: "+value)
		}
		if referenced, ok := req.Context["rules"].([]any); ok {
			for index, item := range referenced {
				if index >= 10 {
					break
				}
				ruleMap, ok := item.(map[string]any)
				if !ok {
					continue
				}
				ruleID := strings.TrimSpace(stringOf(ruleMap["id"]))
				ruleName := strings.TrimSpace(stringOf(ruleMap["name"]))
				ruleSite := strings.TrimSpace(stringOf(ruleMap["site"]))
				if ruleID == "" && ruleName == "" {
					continue
				}
				contextLines = append(contextLines, fmt.Sprintf("引用规则 ID: %s（%s，站点 %s）",
					firstNonEmpty(ruleID, "-"), firstNonEmpty(ruleName, "-"), firstNonEmpty(ruleSite, "-")))
			}
		}
	}
	userText := message
	if len(contextLines) > 0 {
		userText += "\n\n[上下文] " + strings.Join(contextLines, "；")
	}

	// 历史：最近 30 条 user/assistant。
	history := make([]map[string]any, 0, 16)
	count := len(session.Messages)
	start := count - 30
	if start < 0 {
		start = 0
	}
	for _, item := range session.Messages[start:] {
		role := stringOf(item["role"])
		if role == "user" || role == "assistant" {
			history = append(history, map[string]any{"role": role, "content": stringOf(item["content"])})
		}
	}

	userMessage := map[string]any{"role": "user", "content": userText}
	if len(imageURLs) > 0 {
		parts := []map[string]any{{"type": "text", "text": userText}}
		for _, url := range imageURLs {
			parts = append(parts, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": url},
			})
		}
		userMessage["content"] = parts
	}

	// 先把用户消息落盘：生成可能跑几十秒，期间 GUI 打开会话至少能看到用户要求。
	startedAt := NowISO()
	session.Messages = append(session.Messages, map[string]any{"role": "user", "content": userText, "at": startedAt})
	if session.Title == "" || session.Title == "新对话" {
		session.Title = truncateRunes(message, 24)
	}
	if err := a.saveSession(session); err != nil {
		return nil, err
	}

	base := fmt.Sprintf(chatSystemPromptTemplate, RuleGuide)
	messages := make([]map[string]any, 0, len(history)+2)
	messages = append(messages, map[string]any{"role": "system", "content": a.systemPrompt(base)})
	messages = append(messages, history...)
	messages = append(messages, userMessage)

	tools := a.registry.OpenAITools()
	if req.Autonomous {
		tools = append(tools, taskCompleteTool, renameSessionTool, askUserTool)
	}

	isCancelled := func() bool {
		if req.Cancel == nil {
			return false
		}
		return req.Cancel()
	}
	emitEvent := func(kind string, payload map[string]any) {
		if req.Emit == nil {
			return
		}
		event := map[string]any{"kind": kind}
		for key, value := range payload {
			event[key] = value
		}
		func() {
			defer func() { _ = recover() }() // 推送失败不能打断任务
			req.Emit(event)
		}()
	}

	cancelled := false
	completed := false
	awaitingUser := false
	truncated := false
	finalContent := ""
	errorText := ""
	steps := 0
	continuations := 0
	transcript := make([]map[string]any, 0, 8)
	workItems := make([]map[string]any, 0, 8)
	lastTurnContent := ""

	maxSteps := a.config.ChatMaxSteps
	if !req.Autonomous {
		maxSteps = a.config.MaxSteps
	}

	emitEvent("run", map[string]any{"status": "running", "sessionId": session.ID})
	for maxSteps <= 0 || steps < maxSteps {
		if isCancelled() {
			cancelled = true
			break
		}
		if ctx.Err() != nil {
			cancelled = true
			break
		}
		steps++
		emitEvent("step", map[string]any{"step": steps})
		thinkID := fmt.Sprintf("think-%d", steps)
		var reasoningParts, contentParts []string
		var thinkStarted time.Time
		lastThinkEmit := time.Time{}
		streamOpts := ChatOptions{
			Tools:           tools,
			ToolChoice:      "auto",
			Model:           modelName,
			ReasoningEffort: effort,
			OnDelta: func(kind, text string) {
				if kind == "reasoning" {
					if len(reasoningParts) == 0 {
						thinkStarted = time.Now()
						emitEvent("thinking", map[string]any{"id": thinkID, "text": "", "done": false, "step": steps})
					}
					reasoningParts = append(reasoningParts, text)
					if time.Since(lastThinkEmit) >= 350*time.Millisecond {
						lastThinkEmit = time.Now()
						emitEvent("thinking", map[string]any{
							"id": thinkID, "text": truncateRunes(strings.Join(reasoningParts, ""), 20000),
							"done": false, "step": steps,
						})
					}
				} else if kind == "content" {
					contentParts = append(contentParts, text)
				}
			},
			Cancel: isCancelled,
		}
		reply, chatErr := a.llm.ChatStream(ctx, messages, streamOpts)
		if chatErr != nil {
			if isCancelled() || ctx.Err() != nil || ErrorCode(chatErr) == "cancelled" {
				cancelled = true
			} else {
				errorText = chatErr.Error()
			}
			break
		}
		reasoning := strings.TrimSpace(firstNonEmpty(reply.Reasoning, strings.Join(reasoningParts, "")))
		if reasoning != "" {
			durationMs := int64(0)
			if !thinkStarted.IsZero() {
				durationMs = time.Since(thinkStarted).Milliseconds()
			}
			emitEvent("thinking", map[string]any{
				"id": thinkID, "text": truncateRunes(reasoning, 20000), "done": true,
				"durationMs": durationMs, "step": steps,
			})
			workItems = append(workItems, map[string]any{
				"kind": "thinking", "id": thinkID,
				"text": truncateRunes(reasoning, 20000), "durationMs": durationMs,
			})
		}
		turnContent := firstNonEmpty(reply.Content, strings.Join(contentParts, ""))
		if strings.TrimSpace(turnContent) != "" {
			lastTurnContent = strings.TrimSpace(turnContent)
		}
		toolCalls := reply.ToolCalls
		if isCancelled() {
			cancelled = true
			break
		}
		if len(toolCalls) == 0 {
			finalContent = strings.TrimSpace(turnContent)
			if req.Autonomous && !completed && continuations < a.config.AutoContinue &&
				(maxSteps <= 0 || steps < maxSteps) {
				continuations++
				messages = append(messages,
					map[string]any{"role": "assistant", "content": turnContent},
					map[string]any{"role": "user", "content": "继续执行：如果还有未完成的步骤就继续调用工具；如果需要用户提供信息或做决定，调用 ask_user 暂停本轮；任务完成则调用 task_complete 给出最终答复。"})
				emitEvent("continue", map[string]any{"step": steps})
				continue
			}
			break
		}
		assistant := buildAssistantMessage(reply, steps, "call")
		ids := assistant["tool_call_ids"].([]string)
		messages = append(messages, assistant)
		if strings.TrimSpace(turnContent) != "" {
			note := truncateRunes(strings.TrimSpace(turnContent), 4000)
			emitEvent("note", map[string]any{"text": note, "step": steps})
			workItems = append(workItems, map[string]any{"kind": "note", "text": note})
		}
		stop := false
		for index, call := range toolCalls {
			callID := ids[index]
			emitEvent("tool", map[string]any{
				"id": callID, "name": call.Name, "arguments": call.Arguments,
				"status": "running", "step": steps,
			})
			switch call.Name {
			case "task_complete":
				summary := stringOf(call.Arguments["summary"])
				if strings.TrimSpace(summary) == "" {
					summary = turnContent
				}
				finalContent = firstNonEmpty(strings.TrimSpace(summary), lastTurnContent)
				completed = true
				workItems = append(workItems, map[string]any{
					"kind": "tool", "id": callID, "name": call.Name,
					"arguments": call.Arguments, "status": "ok",
					"summary": map[string]any{"completed": true}, "durationMs": 0, "step": steps,
				})
				emitEvent("tool", map[string]any{
					"id": callID, "name": call.Name, "arguments": call.Arguments,
					"status": "ok", "summary": map[string]any{"completed": true},
					"durationMs": 0, "step": steps,
				})
				messages = append(messages, map[string]any{
					"role": "tool", "tool_call_id": callID,
					"content": `{"success": true, "completed": true}`,
				})
				stop = true
			case "rename_session":
				title := truncateRunes(strings.TrimSpace(stringOf(call.Arguments["title"])), 32)
				var result map[string]any
				status := "ok"
				if title == "" {
					result = map[string]any{"success": false, "error": "标题不能为空"}
					status = "error"
				} else {
					session.Title = title
					_ = a.saveSession(session)
					result = map[string]any{"success": true, "title": title}
				}
				workItems = append(workItems, map[string]any{
					"kind": "tool", "id": callID, "name": call.Name,
					"arguments": call.Arguments, "status": status,
					"summary": map[string]any{"title": title},
					"detail":  truncateRunes(toolContent(result), 2000), "durationMs": 0, "step": steps,
				})
				transcript = append(transcript, map[string]any{
					"step": steps, "tool": call.Name, "arguments": call.Arguments,
					"result": map[string]any{"title": title},
				})
				emitEvent("tool", map[string]any{
					"id": callID, "name": call.Name, "arguments": call.Arguments,
					"status": status, "summary": map[string]any{"title": title}, "durationMs": 0, "step": steps,
				})
				messages = append(messages, map[string]any{
					"role": "tool", "tool_call_id": callID, "content": toolContent(result),
				})
			case "ask_user":
				question := strings.TrimSpace(stringOf(call.Arguments["question"]))
				if question == "" {
					question = strings.TrimSpace(turnContent)
				}
				if options, ok := call.Arguments["options"].([]any); ok {
					choices := make([]string, 0, 4)
					for _, option := range options {
						trimmed := strings.TrimSpace(stringOf(option))
						if trimmed != "" {
							choices = append(choices, trimmed)
						}
						if len(choices) >= 4 {
							break
						}
					}
					if len(choices) > 0 {
						lines := make([]string, 0, len(choices))
						for i, choice := range choices {
							lines = append(lines, fmt.Sprintf("%d. %s", i+1, choice))
						}
						question = question + "\n" + strings.Join(lines, "\n")
					}
				}
				finalContent = firstNonEmpty(question, lastTurnContent, "需要你确认后我再继续。")
				awaitingUser = true
				workItems = append(workItems, map[string]any{
					"kind": "tool", "id": callID, "name": call.Name,
					"arguments": call.Arguments, "status": "ok",
					"summary": map[string]any{"awaitingUser": true}, "durationMs": 0, "step": steps,
				})
				transcript = append(transcript, map[string]any{
					"step": steps, "tool": call.Name, "arguments": call.Arguments,
					"result": map[string]any{"awaitingUser": true},
				})
				emitEvent("tool", map[string]any{
					"id": callID, "name": call.Name, "arguments": call.Arguments,
					"status": "ok", "summary": map[string]any{"awaitingUser": true},
					"durationMs": 0, "step": steps,
				})
				messages = append(messages, map[string]any{
					"role": "tool", "tool_call_id": callID,
					"content": `{"success": true, "awaitingUser": true}`,
				})
				stop = true
			default:
				toolStarted := time.Now()
				result := a.registry.Call(ctx, call.Name, call.Arguments)
				durationMs := time.Since(toolStarted).Milliseconds()
				summary := summarizeResult(result)
				status := "ok"
				if boolValue(result["success"]) == false && result["success"] == false {
					status = "error"
				}
				workItems = append(workItems, map[string]any{
					"kind": "tool", "id": callID, "name": call.Name,
					"arguments": call.Arguments, "status": status, "summary": summary,
					"detail":     truncateRunes(toolContent(result), 2000),
					"durationMs": durationMs, "step": steps,
				})
				emitEvent("tool", map[string]any{
					"id": callID, "name": call.Name, "arguments": call.Arguments,
					"status": status, "summary": summary,
					"detail":     truncateRunes(toolContent(result), 2000),
					"durationMs": durationMs, "step": steps,
				})
				transcript = append(transcript, map[string]any{
					"step": steps, "tool": call.Name,
					"arguments": call.Arguments, "result": summary,
				})
				messages = append(messages, map[string]any{
					"role": "tool", "tool_call_id": callID, "content": toolContent(result),
				})
			}
			if stop {
				break
			}
		}
		if completed || cancelled || awaitingUser {
			break
		}
	}
	if maxSteps > 0 && steps >= maxSteps && !completed && !cancelled && !awaitingUser {
		truncated = true
	}
	if isCancelled() {
		cancelled = true
	}
	if finalContent == "" {
		finalContent = lastTurnContent
	}
	if cancelled {
		finalContent = firstNonEmpty(finalContent, "已停止生成。")
	} else if finalContent == "" {
		finalContent = "（模型没有返回文字，请重试或补充信息）"
	}

	assistantMessage := map[string]any{
		"role": "assistant", "content": finalContent, "at": NowISO(), "steps": steps,
	}
	if len(workItems) > 0 {
		assistantMessage["events"] = workItems
	}
	session.Messages = append(session.Messages, assistantMessage)
	if session.Title == "" || session.Title == "新对话" {
		session.Title = truncateRunes(message, 24)
	}
	if err := a.saveSession(session); err != nil {
		return nil, err
	}
	tookMs := millisSince(started)
	updatedSession, _ := a.GetSession(session.ID)
	var sessionMessages any
	if updatedSession != nil {
		sessionMessages = updatedSession["messages"]
	}
	if errorText != "" {
		emitEvent("error", map[string]any{"error": errorText, "reply": finalContent, "steps": steps, "tookMs": tookMs})
		return map[string]any{
			"success": false, "sessionId": session.ID, "error": errorText,
			"reply": finalContent, "steps": steps, "transcript": transcript,
			"events": workItems, "messages": sessionMessages, "tookMs": tookMs,
		}, nil
	}
	if cancelled {
		emitEvent("cancelled", map[string]any{"reply": finalContent, "steps": steps, "tookMs": tookMs})
		return map[string]any{
			"success": false, "cancelled": true, "sessionId": session.ID,
			"error": "已停止生成", "reply": finalContent, "steps": steps,
			"transcript": transcript, "events": workItems,
			"messages": sessionMessages, "tookMs": tookMs,
		}, nil
	}
	emitEvent("done", map[string]any{
		"reply": finalContent, "steps": steps, "truncated": truncated,
		"completed": completed, "awaitingUser": awaitingUser, "tookMs": tookMs,
	})
	return map[string]any{
		"success": true, "sessionId": session.ID,
		"reasoningEffort": effort, "model": modelName, "reply": finalContent,
		"steps": steps, "truncated": truncated, "completed": completed,
		"awaitingUser": awaitingUser, "transcript": transcript,
		"events": workItems, "messages": sessionMessages, "tookMs": tookMs,
	}, nil
}

// ---------------------------------------------------------------- 内部helper

// buildAssistantMessage 把模型回复转成 messages 里的 assistant 条目。
// "tool_call_ids" 是 Go 侧私有的（为了把结果消息与调用对上），序列化时剔除。
func buildAssistantMessage(reply *ChatResult, steps int, prefix string) map[string]any {
	calls := make([]map[string]any, 0, len(reply.ToolCalls))
	ids := make([]string, 0, len(reply.ToolCalls))
	for index, call := range reply.ToolCalls {
		id := call.ID
		if id == "" {
			id = fmt.Sprintf("%s_%d_%d", prefix, steps, index)
		}
		ids = append(ids, id)
		arguments := call.Arguments
		if arguments == nil {
			arguments = map[string]any{}
		}
		encoded, _ := json.Marshal(arguments)
		calls = append(calls, map[string]any{
			"id":   id,
			"type": "function",
			"function": map[string]any{
				"name":      call.Name,
				"arguments": string(encoded),
			},
		})
	}
	return map[string]any{
		"role":          "assistant",
		"content":       reply.Content,
		"tool_calls":    calls,
		"tool_call_ids": ids,
	}
}

// toolContent 把工具结果序列化成 tool 消息内容（截 8000 字）。
func toolContent(result map[string]any) string {
	encoded, err := json.Marshal(result)
	if err != nil {
		return "{}"
	}
	return truncateRunes(string(encoded), 8000)
}

// summarizeResult 抽出关键字段，让 transcript / 事件不至于塞满整页 HTML。
func summarizeResult(result map[string]any) map[string]any {
	summary := map[string]any{}
	for _, key := range []string{"success", "ok", "count", "error", "code", "ruleId", "saved", "deleted"} {
		if value, ok := result[key]; ok {
			summary[key] = value
		}
	}
	return summary
}

// testView 归一化 test_rule 结果（只留 GUI 要展示的字段）。
func testView(test map[string]any) any {
	if test == nil {
		return nil
	}
	items, _ := test["items"].([]map[string]any)
	if len(items) > 3 {
		items = items[:3]
	}
	if items == nil {
		items = []map[string]any{}
	}
	return map[string]any{
		"ok":      test["ok"],
		"count":   test["count"],
		"error":   test["error"],
		"items":   items,
		"pageUrl": test["pageUrl"],
	}
}

// extractRuleJSON 从模型回复里挖出规则 JSON（优先代码块，然后裸扫描）。
func extractRuleJSON(content string) map[string]any {
	if content == "" {
		return nil
	}
	candidates := []string{}
	fenced := fencedJSONRe.FindAllStringSubmatch(content, -1)
	for _, match := range fenced {
		candidates = append(candidates, match[1])
	}
	candidates = append(candidates, content)
	for _, candidate := range candidates {
		for index, char := range candidate {
			if char != '{' {
				continue
			}
			decoder := json.NewDecoder(strings.NewReader(candidate[index:]))
			var value map[string]any
			if err := decoder.Decode(&value); err != nil {
				continue
			}
			if _, hasSearch := value["search"]; hasSearch {
				return value
			}
			if _, hasParse := value["parse"]; hasParse {
				return value
			}
		}
	}
	return nil
}

var fencedJSONRe = regexp.MustCompile("(?s)`{3}(?:json)?\\s*(\\{.*?\\})\\s*`{3}")

func millisSince(started time.Time) int64 { return time.Since(started).Milliseconds() }

// stringOf 把任意 JSON 值安全转成字符串。
func stringOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return trimFloat(typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprint(typed)
	}
}

// firstNonEmptyIf 条件取值：cond 为真时取 values 里第一个非空，否则空串。
func firstNonEmptyIf(cond bool, values ...string) string {
	if !cond {
		return ""
	}
	return firstNonEmpty(values...)
}
