package crawler

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/PuerkitoBio/goquery"
)

// 工具注册表：LLM agent 与 MCP server 共用。
//
// 每个工具都返回可直接序列化的 map；出错也以 {success:false, code, error}
// 的形式返回而不是向上抛，这样 function calling 的 tool 消息与 MCP 的
// tools/call 都可以原样转发给模型。

// RuleGuide 是给模型的规则格式说明（系统提示词的 %s）。
//
// 与 Python 版的差别只有一处：脚本沙箱从 Node 换成了进程内的 goja，
// 支持的全局对象是同一套（fetch/URL/URLSearchParams/TextEncoder/TextDecoder/atob/btoa）。
const RuleGuide = `规则是一个 JSON 对象，结构如下：
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
    "script": {"runtime": "script", "source": "..."}  // 可选：脚本直接调 /api/* 拿地址（反爬站点）
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

脚本规则（适合需要签名/加密/JS 渲染/自定义请求的站点，运行在内置 JavaScript 沙箱）：
- 搜索：search.mode="script"，search.script={"runtime":"script","source":"...","timeout_sec":20}。
  入参 input={keyword,site,rule,account}；可返回 {request:{url,method,headers,body}} 交给引擎抓取，
  也可直接返回 {items:[{title,url,cover,description,duration,author}]}。
- 解析：parse.type="script"，parse.script={"runtime":"script","source":"..."}；
  入参 {html,url,keyword,rule,account}，返回 {items:[...]}。
- 脚本内可直接用 fetch/URL/URLSearchParams/TextEncoder/TextDecoder/atob/btoa，用 return 返回结果，console.log 会回传。
- 账号：rule.search.account_id 绑定账号库；HTTP 模式自动合并 account.headers 与 Cookie 头，脚本内用 input.account 读取。
  绑定账号需经用户同意（绑定即授权引擎在该规则的搜索、播放解析与 test_play 中使用该账号 Cookie）；不要自行绑定，也不要把账号用于其他站点。

页面需要登录或由 JS 动态渲染时，用离屏浏览器工具：
- browser_open(url) 用无头浏览器打开页面，browser_text/browser_html/browser_eval 读取渲染后的内容。
- 登录必须由人工完成：调用 browser_show 把窗口显示给用户，登录完成后调用 browser_save_login 把 Cookie 存成账号，
  再用 bind_account 绑定到规则。不要把密码写进规则或对话。
- 站点规则解析仍在后端执行；浏览器只用于生成/调试规则。

播放解析（play 段，让「全网搜片」的结果能直接加入一起看）：
- 搜索结果 url 通常是详情页，play 段负责把它变成 m3u8/mp4/flv 地址。解析顺序：play.script → play.api → 页面里的直链 → 播放页直链 → 受控浏览器嗅探。
- play.script（最优先，运行在脚本沙箱）：入参 {pageUrl,site,rule,headers,account}（account 仅在规则绑定账号时非空），自己 fetch 站点接口选线路，返回 {url,format,title,headers,episodes:[{name,url}],note}。站点有多档清晰度（标清/高清/1080P/蓝光等）时再返回 qualities:[{name,url,format?,headers?}]——name 用站点自己的叫法，url 仍是默认档，播放器会让用户自己切；能拿到几档就给几档，不要编造。
- 找清晰度（qualities）的常见位置：站点播放接口里表示画质的参数（qn / definition / defn / quality / clarity / p）、播放器初始化 JSON 或页面上的清晰度按钮列表、多路播放地址（不同线路/不同码率）。一条 m3u8 主列表内部的自适应码率不需要 qualities，只有站点给出多个独立地址时才返回多档。
- 档位名照抄站点文案（如「蓝光1080P」「高清」「标清」）；测试时用 test_play 返回的 qualities 核对档位名和地址都能拉起来，不确定的档位宁可不给。
- play.api：用 play_url_regex 的命名捕获组填 api.url 模板，逐条线路请求；返回 {mode:"native",url} 或 {mode:"iframe",url}。带 auth/token/expires 等签名的地址容易过期，可用 skipFrom 跳过会员线路。play.api 本身不支持多档清晰度，站点有多档地址时改用 play.script。
- 用 test_play(detail_url, rule?) 验证：success=true 且 url 可拉才算通过；iframe 只说明站点不允许直接播放；返回里的 qualities 是解析器整理过的档位列表（含默认档）。规则绑定了账号时，test_play 会带上该账号的 Cookie 与请求头（用户绑定即同意），可用来验证会员/登录后才可用的线路。
- 只给确实能播放的站点加 play 段；纯元数据站（豆瓣等）不要编造，直接说明不可播放。`

// Tool 是一个可被模型调用的工具。
type Tool struct {
	Name        string
	Description string
	Schema      map[string]any
	Handler     func(ctx context.Context, args map[string]any) (map[string]any, error)
}

// OpenAISchema 返回 function calling 的声明。
func (t *Tool) OpenAISchema() map[string]any {
	return map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"parameters":  t.Schema,
		},
	}
}

// MCPSchema 返回 MCP tools/list 的声明。
func (t *Tool) MCPSchema() map[string]any {
	return map[string]any{
		"name":        t.Name,
		"description": t.Description,
		"inputSchema": t.Schema,
	}
}

// ToolRegistry 保存可用工具。
type ToolRegistry struct {
	order []string
	tools map[string]*Tool
}

// NewToolRegistry 建一个空注册表。
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{tools: map[string]*Tool{}}
}

// Register 注册（或覆盖）一个工具。
func (r *ToolRegistry) Register(tool *Tool) {
	if tool == nil || tool.Name == "" {
		return
	}
	if _, exists := r.tools[tool.Name]; !exists {
		r.order = append(r.order, tool.Name)
	}
	r.tools[tool.Name] = tool
}

// Has 判断工具是否存在。
func (r *ToolRegistry) Has(name string) bool {
	_, ok := r.tools[name]
	return ok
}

// Names 返回已注册的工具名（按注册顺序）。
func (r *ToolRegistry) Names() []string {
	out := make([]string, len(r.order))
	copy(out, r.order)
	sort.Strings(out)
	return out
}

// Call 执行一个工具。参数错误与内部异常都归一化成结果对象，交给模型自行修正。
func (r *ToolRegistry) Call(ctx context.Context, name string, args map[string]any) map[string]any {
	tool, ok := r.tools[name]
	if !ok {
		return map[string]any{"success": false, "code": "unknown_tool", "error": "未知工具: " + name}
	}
	if args == nil {
		args = map[string]any{}
	}
	if ctx == nil {
		ctx = context.Background()
	}
	result, err := tool.Handler(ctx, args)
	if err != nil {
		return ErrorMap(err)
	}
	if result == nil {
		return map[string]any{"success": true}
	}
	return result
}

// OpenAITools 返回全部工具的 function calling 声明。
func (r *ToolRegistry) OpenAITools() []map[string]any {
	out := make([]map[string]any, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.tools[name].OpenAISchema())
	}
	return out
}

// MCPTools 返回全部工具的 MCP 声明。
func (r *ToolRegistry) MCPTools() []map[string]any {
	out := make([]map[string]any, 0, len(r.order))
	for _, name := range r.order {
		out = append(out, r.tools[name].MCPSchema())
	}
	return out
}

// ErrorMap 把错误转成工具结果。EngineError 保留 code 与 details。
func ErrorMap(err error) map[string]any {
	if engineErr, ok := err.(*EngineError); ok {
		return engineErr.ToMap()
	}
	return map[string]any{"success": false, "code": "internal_error", "error": err.Error()}
}

// ToolOptions 是构建注册表需要的依赖。
type ToolOptions struct {
	Store        *RuleStore
	Search       *SearchService
	Fetcher      *Fetcher
	Play         *PlayResolver
	SearchLog    *SearchLogStore
	Browser      *Browser
	Agent        *RuleAgent
	MaxPageChars int
	// IncludeGenerate 打开后注册 generate_rule（会自动建规则并保存，只给管理员会话）。
	IncludeGenerate bool
}

// BuildRegistry 装配工具集。
func BuildRegistry(opts ToolOptions) *ToolRegistry {
	maxChars := opts.MaxPageChars
	if maxChars <= 0 {
		maxChars = 6000
	}
	registry := NewToolRegistry()
	browser := opts.Browser

	registry.Register(&Tool{
		Name:        "fetch_page",
		Description: "抓取一个网页并返回标题、正文摘要、表单和链接，用于寻找站点的搜索入口。",
		Schema: SchemaObject(map[string]any{
			"url":       StrProp("http(s) 页面地址"),
			"max_chars": IntProp("正文摘要最大字符数"),
		}, "url"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			chars := ArgInt(args, "max_chars", maxChars)
			if chars < 500 {
				chars = 500
			}
			if chars > 20000 {
				chars = 20000
			}
			return pageSummary(ctx, opts.Fetcher, ArgString(args, "url"), chars)
		},
	})

	registry.Register(&Tool{
		Name:        "inspect_html",
		Description: "在网页上执行 CSS 选择器，返回匹配数量与样本 HTML，用于验证规则选择器。",
		Schema: SchemaObject(map[string]any{
			"url":      StrProp(""),
			"selector": StrProp("CSS 选择器"),
			"limit":    IntProp(""),
		}, "url", "selector"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			return inspectHTML(ctx, opts.Fetcher, ArgString(args, "url"), ArgString(args, "selector"), ArgInt(args, "limit", 5))
		},
	})

	registry.Register(&Tool{
		Name:        "inspect_challenge",
		Description: "检查一个页面是否是人机验证/反爬挑战页，返回标题、命中关键词、可疑选择器和建议的 challenge 规则片段。",
		Schema: SchemaObject(map[string]any{
			"url":     StrProp("页面地址，可含 {keyword}"),
			"keyword": StrProp("可选，用来替换 URL 里的 {keyword}"),
		}, "url"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			return inspectChallenge(ctx, opts.Fetcher, ArgString(args, "url"), ArgString(args, "keyword"))
		},
	})

	registry.Register(&Tool{
		Name:        "detect_challenge_html",
		Description: "分析一段已经取到的 HTML（例如 browser_html 渲染结果），判断是否包含人机验证特征并给出 challenge 规则建议。",
		Schema: SchemaObject(map[string]any{
			"html":   StrProp(""),
			"url":    StrProp(""),
			"status": IntProp(""),
		}, "html"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			status := ArgInt(args, "status", 200)
			if status <= 0 {
				status = 200
			}
			return GenericSignals(ArgString(args, "html"), ArgString(args, "url"), status), nil
		},
	})

	registry.Register(&Tool{
		Name:        "test_rule",
		Description: "不保存规则，直接用一条搜索关键词测试规则是否能抓到结果。",
		Schema: SchemaObject(map[string]any{
			"rule":    ObjectProp("完整规则对象"),
			"keyword": StrProp("测试关键词"),
			"limit":   IntProp(""),
		}, "rule"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			rule, err := ruleArg(args, "rule")
			if err != nil {
				return nil, err
			}
			keyword := strings.TrimSpace(ArgString(args, "keyword"))
			if keyword == "" {
				keyword = "电影"
			}
			return opts.Search.TestRule(rule, keyword, ArgInt(args, "limit", 10)), nil
		},
	})

	registry.Register(&Tool{
		Name: "test_play",
		Description: "不保存规则，用一个详情页地址试播：返回解析出的播放地址、格式、请求头和选集；" +
			"站点有多档清晰度时还会返回 qualities 列表（播放器据此让用户切换清晰度）。传 rule 可测试尚未保存的 play 配置。" +
			"规则绑定了账号（search.account_id 或 play.account_id）时会带上该账号 Cookie，可验证登录后才可用的线路。",
		Schema: SchemaObject(map[string]any{
			"detail_url": StrProp("站点详情页地址（搜索结果里的 url）"),
			"rule":       ObjectProp("可选：带 play 段的规则对象，用来测试还没保存的配置"),
		}, "detail_url"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			if opts.Play == nil {
				return map[string]any{"success": false, "code": "unavailable", "error": "播放解析未启用"}, nil
			}
			var rule *Rule
			if _, present := args["rule"]; present {
				parsed, err := ruleArg(args, "rule")
				if err != nil {
					return nil, err
				}
				rule = parsed
			}
			result, err := opts.Play.Resolve(ArgString(args, "detail_url"), "", "root", rule)
			if err != nil {
				return ErrorMap(err), nil
			}
			return result, nil
		},
	})

	registry.Register(&Tool{
		Name:        "save_rule",
		Description: "保存新规则或更新已有规则（带 id 即更新）。保存前会做格式校验。",
		Schema: SchemaObject(map[string]any{
			"rule": ObjectProp("完整规则对象"),
		}, "rule"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			rule, err := ruleArg(args, "rule")
			if err != nil {
				return nil, err
			}
			saved, err := opts.Store.Save(rule, rule.ID)
			if err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "rule": PublicView(saved, true)}, nil
		},
	})

	registry.Register(&Tool{
		Name:        "list_rules",
		Description: "列出已保存的站点规则；管理员可看到完整搜索与解析配置。",
		Schema: SchemaObject(map[string]any{
			"room_id": StrProp(""),
			"role":    StrProp("root 或 guest"),
		}),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			roomID := ArgString(args, "room_id")
			role := ArgString(args, "role")
			if role == "" {
				role = "root"
			}
			rules := make([]map[string]any, 0, 8)
			for _, rule := range opts.Store.List(true) {
				if role != "root" && !RuleVisibleTo(rule, roomID, role) {
					continue
				}
				rules = append(rules, PublicView(rule, role == "root"))
			}
			return map[string]any{"success": true, "rules": rules, "count": len(rules)}, nil
		},
	})

	registry.Register(&Tool{
		Name:        "get_rule",
		Description: "按 id 读取一条站点规则的完整配置。",
		Schema: SchemaObject(map[string]any{
			"rule_id": StrProp(""),
		}, "rule_id"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			rule, err := opts.Store.Get(ArgString(args, "rule_id"))
			if err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "rule": PublicView(rule, true)}, nil
		},
	})

	registry.Register(&Tool{
		Name:        "update_rule",
		Description: "局部修改一条规则（patch 会与现有规则合并，search/parse 是浅合并）。",
		Schema: SchemaObject(map[string]any{
			"rule_id": StrProp(""),
			"patch":   ObjectProp(""),
		}, "rule_id", "patch"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			patch, err := rawObjectArg(args, "patch")
			if err != nil {
				return nil, err
			}
			rule, err := opts.Store.Update(ArgString(args, "rule_id"), patch)
			if err != nil {
				return nil, err
			}
			return map[string]any{"success": true, "rule": PublicView(rule, true)}, nil
		},
	})

	registry.Register(&Tool{
		Name:        "delete_rule",
		Description: "删除一条站点规则。",
		Schema: SchemaObject(map[string]any{
			"rule_id": StrProp(""),
		}, "rule_id"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			ruleID := ArgString(args, "rule_id")
			deleted, err := opts.Store.Delete(ruleID)
			if err != nil {
				return nil, err
			}
			return map[string]any{"success": deleted, "ruleId": ruleID, "deleted": deleted}, nil
		},
	})

	registry.Register(&Tool{
		Name:        "search_site",
		Description: "用已保存的站点规则执行一次搜索（调试用）。",
		Schema: SchemaObject(map[string]any{
			"site":    StrProp("规则 id、域名或 URL"),
			"keyword": StrProp(""),
			"room_id": StrProp(""),
			"role":    StrProp(""),
		}, "site", "keyword"),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			role := ArgString(args, "role")
			if role == "" {
				role = "root"
			}
			result, err := opts.Search.Search(ArgString(args, "site"), ArgString(args, "keyword"),
				ArgString(args, "room_id"), role, 0, nil, true)
			if err != nil {
				return ErrorMap(err), nil
			}
			return result, nil
		},
	})

	if opts.SearchLog != nil {
		log := opts.SearchLog
		registry.Register(&Tool{
			Name: "search_logs",
			Description: "读取最近的搜索日志（默认只看失败），用于诊断空结果、选择器漂移、验证码或登录墙；" +
				"含请求 URL、状态码、响应摘要与错误文本。",
			Schema: SchemaObject(map[string]any{
				"limit":         IntProp("最多返回条数，默认 20"),
				"site":          StrProp("按规则 id / 域名 / 站点名过滤"),
				"failures_only": BoolProp("只看失败记录，默认 true"),
				"source":        StrProp("search、test 或 mcp"),
			}),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				failuresOnly := true
				if _, present := args["failures_only"]; present {
					failuresOnly = ArgBool(args, "failures_only", true)
				}
				logs := log.List(ArgInt(args, "limit", 20), ArgString(args, "site"), failuresOnly, ArgString(args, "source"))
				return map[string]any{"success": true, "logs": logs, "count": len(logs), "total": log.Count()}, nil
			},
		})
	}

	registry.Register(&Tool{
		Name:        "list_sites",
		Description: "列出当前房间/角色可用的站点（供前端一起看展示）。",
		Schema: SchemaObject(map[string]any{
			"room_id": StrProp(""),
			"role":    StrProp(""),
		}),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			role := ArgString(args, "role")
			if role == "" {
				role = "guest"
			}
			sites := opts.Search.ListSites(ArgString(args, "room_id"), role)
			return map[string]any{"success": true, "sites": sites, "count": len(sites)}, nil
		},
	})

	if browser != nil {
		registry.Register(&Tool{
			Name:        "browser_status",
			Description: "查看离屏浏览器状态（是否安装、是否运行、当前页面）。",
			Schema:      SchemaObject(nil),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				return map[string]any{"success": true, "browser": browser.Status()}, nil
			},
		})

		registry.Register(&Tool{
			Name:        "browser_open",
			Description: "用离屏浏览器打开一个页面（会执行 JS，适合 SPA 或需要登录的站点），返回标题和正文片段。",
			Schema: SchemaObject(map[string]any{
				"url":      StrProp(""),
				"wait_sec": NumProp("额外等待秒数，最多 10"),
			}, "url"),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				info, err := browser.OpenPage(ctx, ArgString(args, "url"), ArgFloat(args, "wait_sec", 0))
				if err != nil {
					return nil, err
				}
				return map[string]any{"success": true, "page": info}, nil
			},
		})

		registry.Register(&Tool{
			Name:        "browser_text",
			Description: "读取离屏浏览器当前页面的正文文本，可用 CSS 选择器限定区域。",
			Schema: SchemaObject(map[string]any{
				"selector":  StrProp(""),
				"max_chars": IntProp(""),
			}),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				text, pageURL, err := browser.PageText(ctx, ArgString(args, "selector"), ArgInt(args, "max_chars", 8000))
				if err != nil {
					return nil, err
				}
				return map[string]any{"success": true, "url": pageURL, "text": text}, nil
			},
		})

		registry.Register(&Tool{
			Name:        "browser_html",
			Description: "读取离屏浏览器当前页面的渲染后 HTML（用于查找动态生成的搜索表单/结果）。",
			Schema: SchemaObject(map[string]any{
				"max_chars": IntProp(""),
			}),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				htmlText, pageURL, err := browser.PageHTML(ctx, ArgInt(args, "max_chars", 60000))
				if err != nil {
					return nil, err
				}
				return map[string]any{"success": true, "url": pageURL, "html": htmlText, "length": len(htmlText)}, nil
			},
		})

		registry.Register(&Tool{
			Name:        "browser_eval",
			Description: "在离屏浏览器页面里执行一段 JS 表达式并返回结果（可探测接口、读取 DOM、点击按钮）。",
			Schema: SchemaObject(map[string]any{
				"script": StrProp("JS 表达式，支持 await"),
			}, "script"),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				value, pageURL, err := browser.EvalValue(ctx, ArgString(args, "script"))
				if err != nil {
					return nil, err
				}
				return map[string]any{"success": true, "url": pageURL, "value": value}, nil
			},
		})

		registry.Register(&Tool{
			Name:        "browser_click",
			Description: "点击离屏浏览器页面里的第一个匹配元素。",
			Schema: SchemaObject(map[string]any{
				"selector": StrProp(""),
			}, "selector"),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				result, err := browser.Click(ctx, ArgString(args, "selector"))
				if err != nil {
					return nil, err
				}
				return map[string]any{"success": true, "result": result}, nil
			},
		})

		registry.Register(&Tool{
			Name:        "browser_cookies",
			Description: "查看当前浏览器在某个域名下的 Cookie 名称与数量（不返回值，防止泄露）。",
			Schema: SchemaObject(map[string]any{
				"site": StrProp("域名，如 example.com"),
			}),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				summary, err := browser.CookieSummary(ctx)
				if err != nil {
					return nil, err
				}
				out := map[string]any{"success": true}
				for key, value := range summary {
					out[key] = value
				}
				return out, nil
			},
		})
	}

	if opts.IncludeGenerate && opts.Agent != nil {
		agent := opts.Agent
		registry.Register(&Tool{
			Name:        "generate_rule",
			Description: "让大模型访问站点、自动生成搜索与解析规则；生成后会试搜并在成功时保存。",
			Schema: SchemaObject(map[string]any{
				"url":     StrProp("站点首页或搜索页 URL"),
				"keyword": StrProp("试搜关键词"),
				"notes":   StrProp("额外要求"),
			}, "url"),
			Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
				return agent.Generate(ctx, ArgString(args, "url"), ArgString(args, "keyword"), ArgString(args, "notes"), "")
			},
		})
	}
	return registry
}

// ---------------------------------------------------------------- 工具实现

// pageSummary 抓页面并抽出标题、正文、表单与链接，供模型找搜索入口。
func pageSummary(ctx context.Context, fetcher *Fetcher, target string, maxChars int) (map[string]any, error) {
	response, err := fetcher.Fetch(ctx, Request{URL: target})
	if err != nil {
		return nil, err
	}
	dom, err := ParseHTML(response.Text)
	if err != nil {
		return nil, err
	}
	titleNode, _ := dom.SelectOne("title")
	title := NodeText(titleNode)
	descNode, _ := dom.SelectOne(`meta[name="description"]`)
	description := attrOf(descNode, "content")
	bodyNode, _ := dom.SelectOne("body")
	bodyText := response.Text
	if bodyNode != nil {
		bodyText = NodeText(bodyNode)
	}

	forms := make([]map[string]any, 0, 4)
	formNodes, _ := dom.SelectAll("form")
	if len(formNodes) > 5 {
		formNodes = formNodes[:5]
	}
	for _, form := range formNodes {
		inputs := make([]map[string]any, 0, 8)
		fields, _ := SelectAll(form, "input,select,textarea")
		if len(fields) > 20 {
			fields = fields[:20]
		}
		for _, field := range fields {
			kind := attrOf(field, "type")
			if kind == "" {
				kind = goqueryTagName(field)
			}
			inputs = append(inputs, map[string]any{
				"name":        attrOf(field, "name"),
				"type":        kind,
				"value":       attrOf(field, "value"),
				"placeholder": attrOf(field, "placeholder"),
			})
		}
		method := strings.ToUpper(attrOf(form, "method"))
		if method == "" {
			method = "GET"
		}
		forms = append(forms, map[string]any{
			"action": joinURL(response.URL, attrOf(form, "action")),
			"method": method,
			"inputs": inputs,
		})
	}

	links := make([]map[string]any, 0, 16)
	anchors, _ := dom.SelectAll("a[href]")
	if len(anchors) > 60 {
		anchors = anchors[:60]
	}
	for _, anchor := range anchors {
		text := NodeText(anchor)
		links = append(links, map[string]any{
			"text": truncateRunes(text, 60),
			"href": joinURL(response.URL, attrOf(anchor, "href")),
		})
	}

	kind := "html"
	if strings.Contains(strings.ToLower(response.Headers["content-type"]), "json") {
		kind = "json"
	}
	return map[string]any{
		"success":     true,
		"url":         target,
		"finalUrl":    response.URL,
		"status":      response.Status,
		"kind":        kind,
		"title":       truncateRunes(title, 200),
		"description": truncateRunes(description, 300),
		"text":        truncateRunes(bodyText, maxChars),
		"textLength":  len([]rune(bodyText)),
		"forms":       forms,
		"links":       links,
		"encoding":    response.Encoding,
	}, nil
}

// inspectHTML 执行选择器并给出样本，用于校准 container / fields。
func inspectHTML(ctx context.Context, fetcher *Fetcher, target, selector string, limit int) (map[string]any, error) {
	response, err := fetcher.Fetch(ctx, Request{URL: target})
	if err != nil {
		return nil, err
	}
	dom, err := ParseHTML(response.Text)
	if err != nil {
		return nil, err
	}
	nodes, selectErr := dom.SelectAll(selector)
	if selectErr != nil {
		return nil, RuleErrorf("选择器不合法: %v", selectErr)
	}
	if limit <= 0 {
		limit = 5
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 20 {
		limit = 20
	}
	samples := make([]map[string]any, 0, limit)
	for index, node := range nodes {
		if index >= limit {
			break
		}
		attrs := map[string]string{}
		for _, key := range []string{"class", "id", "href", "src", "title"} {
			if value := attrOf(node, key); value != "" {
				attrs[key] = value
			}
		}
		samples = append(samples, map[string]any{
			"tag":   goqueryTagName(node),
			"text":  truncateRunes(NodeText(node), 200),
			"attrs": attrs,
			"html":  truncateRunes(NodeHTML(node), 500),
		})
	}
	return map[string]any{
		"success":  true,
		"url":      response.URL,
		"selector": selector,
		"count":    len(nodes),
		"samples":  samples,
	}, nil
}

// inspectChallenge 抓页面并给出验证特征，方便直接写 challenge 段。
func inspectChallenge(ctx context.Context, fetcher *Fetcher, target, keyword string) (map[string]any, error) {
	quoted := ""
	if keyword != "" {
		encoded, err := QuoteKeyword(keyword, "utf-8")
		if err == nil {
			quoted = encoded
		}
	}
	if quoted != "" {
		target = strings.ReplaceAll(target, "{keyword}", quoted)
		target = strings.ReplaceAll(target, "{query}", quoted)
	}
	response, err := fetcher.Fetch(ctx, Request{URL: target})
	if err != nil {
		return nil, err
	}
	result := GenericSignals(response.Text, response.URL, response.Status)
	result["request"] = map[string]any{"url": target, "status": response.Status}
	if keyword != "" {
		result["keyword"] = keyword
	}
	return result, nil
}

// ---------------------------------------------------------------- 参数helper

func SchemaObject(properties map[string]any, required ...string) map[string]any {
	if properties == nil {
		properties = map[string]any{}
	}
	schema := map[string]any{"type": "object", "properties": properties}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func StrProp(description string) map[string]any {
	prop := map[string]any{"type": "string"}
	if description != "" {
		prop["description"] = description
	}
	return prop
}

func IntProp(description string) map[string]any {
	prop := map[string]any{"type": "integer"}
	if description != "" {
		prop["description"] = description
	}
	return prop
}

func NumProp(description string) map[string]any {
	prop := map[string]any{"type": "number"}
	if description != "" {
		prop["description"] = description
	}
	return prop
}

func BoolProp(description string) map[string]any {
	prop := map[string]any{"type": "boolean"}
	if description != "" {
		prop["description"] = description
	}
	return prop
}

func ObjectProp(description string) map[string]any {
	prop := map[string]any{"type": "object"}
	if description != "" {
		prop["description"] = description
	}
	return prop
}

func ArgString(args map[string]any, key string) string {
	value, ok := args[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
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

func ArgInt(args map[string]any, key string, fallback int) int {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			return int(parsed)
		}
	case string:
		parsed := strings.TrimSpace(typed)
		total := 0
		for _, char := range parsed {
			if char < '0' || char > '9' {
				return fallback
			}
			total = total*10 + int(char-'0')
		}
		if parsed != "" {
			return total
		}
	}
	return fallback
}

func ArgFloat(args map[string]any, key string, fallback float64) float64 {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			return parsed
		}
	}
	return fallback
}

func ArgBool(args map[string]any, key string, fallback bool) bool {
	value, ok := args[key]
	if !ok || value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		trimmed := strings.ToLower(strings.TrimSpace(typed))
		return trimmed == "true" || trimmed == "1" || trimmed == "yes"
	case float64:
		return typed != 0
	}
	return fallback
}

// ruleArg 把工具参数里的 rule 对象转成 *Rule。
func ruleArg(args map[string]any, key string) (*Rule, error) {
	value, ok := args[key]
	if !ok || value == nil {
		return nil, RuleErrorf("缺少参数 %s", key)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, RuleErrorf("规则不是合法 JSON: %v", err)
	}
	var rule Rule
	if err := json.Unmarshal(encoded, &rule); err != nil {
		return nil, RuleErrorf("规则不是合法 JSON: %v", err)
	}
	return &rule, nil
}

// rawObjectArg 把工具参数里的对象转成 patch 用的原始 JSON 映射。
func rawObjectArg(args map[string]any, key string) (map[string]json.RawMessage, error) {
	value, ok := args[key]
	if !ok || value == nil {
		return nil, RuleErrorf("缺少参数 %s", key)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, RuleErrorf("参数 %s 不是合法 JSON: %v", key, err)
	}
	patch := map[string]json.RawMessage{}
	if err := json.Unmarshal(encoded, &patch); err != nil {
		return nil, RuleErrorf("参数 %s 必须是对象", key)
	}
	return patch, nil
}

// attrOf 取属性，不存在时返回空串（避免到处判空）。
func attrOf(node *goquery.Selection, name string) string {
	if node == nil {
		return ""
	}
	value, ok := node.Attr(name)
	if !ok {
		return ""
	}
	return value
}

// goqueryTagName 返回节点标签名（小写）。
func goqueryTagName(node *goquery.Selection) string {
	if node == nil || len(node.Nodes) == 0 {
		return ""
	}
	return node.Nodes[0].Data
}

// trimFloat 把浮点参数转成干净的字符串（避免 3.0 变成 "3" 之外的怪输出）。
func trimFloat(value float64) string {
	if value == float64(int64(value)) {
		return fmt.Sprintf("%d", int64(value))
	}
	return fmt.Sprintf("%g", value)
}
