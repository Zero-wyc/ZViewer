package crawler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

const toolSampleHTML = `
<html><head><title>测试影视站</title></head>
<body>
  <div class="result-item"><span class="t">流浪地球 4K 高清</span><a href="/play/1">播放</a></div>
  <div class="result-item"><span class="t">独行月球</span><a href="/play/2">播放</a></div>
</body></html>`

// newTestService 搭一个真实 httptest 站点 + 规则存储，返回可直接使用的依赖集。
func newTestService(t *testing.T) (*SearchService, *RuleStore, *Fetcher, string) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(toolSampleHTML))
	}))
	t.Cleanup(server.Close)
	root := t.TempDir()
	store, err := NewRuleStore(filepath.Join(root, "rules"))
	if err != nil {
		t.Fatalf("NewRuleStore: %v", err)
	}
	fetcher := NewFetcher(FetcherOptions{Timeout: 5 * time.Second})
	service := NewSearchService(SearchOptions{Store: store, Fetcher: fetcher})
	return service, store, fetcher, server.URL
}

func toolRulePayload(siteURL string) map[string]any {
	return map[string]any{
		"name": "测试站",
		"site": "127.0.0.1",
		"search": map[string]any{
			"request": map[string]any{"url": siteURL + "?q={keyword}"},
		},
		"parse": map[string]any{
			"container": ".result-item",
			"fields": map[string]any{
				"title": map[string]any{"selector": ".t", "attr": "text"},
				"url":   map[string]any{"selector": "a", "attr": "href"},
			},
		},
	}
}

func TestRegistryCallErrors(t *testing.T) {
	registry := NewToolRegistry()
	called := false
	registry.Register(&Tool{
		Name: "echo", Description: "测试",
		Schema: SchemaObject(nil),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			called = true
			if ArgString(args, "text") != "你好" {
				t.Errorf("text = %q", ArgString(args, "text"))
			}
			return map[string]any{"success": true, "text": ArgString(args, "text")}, nil
		},
	})
	result := registry.Call(nil, "missing", nil)
	if result["code"] != "unknown_tool" {
		t.Errorf("unknown tool code = %v", result["code"])
	}
	result = registry.Call(nil, "echo", map[string]any{"text": "你好"})
	if !called || result["text"] != "你好" {
		t.Errorf("echo result = %+v called=%v", result, called)
	}
	registry.Register(&Tool{
		Name: "boom", Description: "测试",
		Schema: SchemaObject(nil),
		Handler: func(ctx context.Context, args map[string]any) (map[string]any, error) {
			return nil, FetchError("超时", 408, "http://a.com", nil)
		},
	})
	result = registry.Call(nil, "boom", nil)
	if result["code"] != "fetch_error" || result["success"] != false {
		t.Errorf("boom result = %+v", result)
	}
	if len(registry.OpenAITools()) != 2 {
		t.Errorf("openai tools = %d", len(registry.OpenAITools()))
	}
	if len(registry.MCPTools()) != 2 {
		t.Errorf("mcp tools = %d", len(registry.MCPTools()))
	}
}

func TestFetchPageTool(t *testing.T) {
	service, store, fetcher, base := newTestService(t)
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	result := registry.Call(nil, "fetch_page", map[string]any{"url": base})
	if result["success"] != true || result["title"] != "测试影视站" {
		t.Fatalf("fetch_page = %+v", result)
	}
	forms, _ := result["kind"].(string)
	if forms != "html" {
		t.Errorf("kind = %v", result["kind"])
	}
	inspect := registry.Call(nil, "inspect_html", map[string]any{"url": base, "selector": ".t"})
	if inspect["count"] != 2 {
		t.Errorf("inspect count = %v", inspect["count"])
	}
	challenge := registry.Call(nil, "inspect_challenge", map[string]any{"url": base + "/verify?kw={keyword}", "keyword": "星际"})
	if challenge["success"] != true {
		t.Errorf("inspect_challenge = %+v", challenge)
	}
	detect := registry.Call(nil, "detect_challenge_html", map[string]any{"html": "<h1>请完成人机验证</h1>", "url": base})
	if detect["success"] != true {
		t.Errorf("detect = %+v", detect)
	}
}

func TestRuleToolLifecycle(t *testing.T) {
	service, store, fetcher, base := newTestService(t)
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})

	// 校验失败要回 rule_error。
	bad := registry.Call(nil, "save_rule", map[string]any{"rule": map[string]any{"name": "缺 site"}})
	if bad["code"] != "rule_error" {
		t.Fatalf("bad save = %+v", bad)
	}

	saved := registry.Call(nil, "save_rule", map[string]any{"rule": toolRulePayload(base)})
	if saved["success"] != true {
		t.Fatalf("save = %+v", saved)
	}
	ruleView := saved["rule"].(map[string]any)
	ruleID := ruleView["id"].(string)

	listed := registry.Call(nil, "list_rules", map[string]any{})
	if listed["count"] != 1 {
		t.Errorf("list = %+v", listed)
	}

	test := registry.Call(nil, "test_rule", map[string]any{"rule": toolRulePayload(base), "keyword": "流浪地球"})
	if test["ok"] != true || test["count"] != 2 {
		t.Errorf("test_rule = ok:%v count:%v err:%v", test["ok"], test["count"], test["error"])
	}

	patched := registry.Call(nil, "update_rule", map[string]any{
		"rule_id": ruleID,
		"patch":   map[string]any{"description": "更新后的说明"},
	})
	if patched["success"] != true {
		t.Errorf("update = %+v", patched)
	}
	fetched := registry.Call(nil, "get_rule", map[string]any{"rule_id": ruleID})
	if fetched["rule"].(map[string]any)["description"] != "更新后的说明" {
		t.Errorf("get after patch = %+v", fetched["rule"])
	}

	sites := registry.Call(nil, "list_sites", map[string]any{"role": "root"})
	if sites["count"] != 1 {
		t.Errorf("list_sites = %+v", sites)
	}
	searched := registry.Call(nil, "search_site", map[string]any{"site": ruleID, "keyword": "月球"})
	if searched["count"] != 2 {
		t.Errorf("search_site = %+v", searched)
	}

	deleted := registry.Call(nil, "delete_rule", map[string]any{"rule_id": ruleID})
	if deleted["deleted"] != true {
		t.Errorf("delete = %+v", deleted)
	}
}

// ---------------------------------------------------------------- agent

// fakeLLMServer 模拟 OpenAI /chat/completions：按脚本逐轮回复。
type fakeLLMServer struct {
	mu       sync.Mutex
	replies  []map[string]any // 每轮的 choices[0].message
	requests []map[string]any
	server   *httptest.Server
}

func newFakeLLM(t *testing.T, replies []map[string]any) *fakeLLMServer {
	t.Helper()
	fake := &fakeLLMServer{replies: replies}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		fake.mu.Lock()
		fake.requests = append(fake.requests, body)
		index := len(fake.requests) - 1
		if index >= len(fake.replies) {
			index = len(fake.replies) - 1
		}
		reply := fake.replies[index]
		fake.mu.Unlock()
		// 流式请求要回 SSE（与真实服务一致，否则引擎会走非流式回退打乱脚本顺序）。
		if streaming, _ := body["stream"].(bool); streaming {
			w.Header().Set("Content-Type", "text/event-stream")
			flusher := w.(http.Flusher)
			writeChunk := func(message map[string]any) {
				chunk, _ := json.Marshal(map[string]any{
					"id": "chatcmpl-test", "object": "chat.completion.chunk", "model": "fake",
					"choices": []map[string]any{{"index": 0, "delta": message, "finish_reason": nil}},
				})
				_, _ = w.Write([]byte("data: " + string(chunk) + "\n\n"))
				flusher.Flush()
			}
			if calls, ok := reply["tool_calls"].([]map[string]any); ok {
				// 按 index 分片吐 tool_calls，验证流式拼接逻辑。
				// toolReply 里 arguments 已是 JSON 字符串，直接透传（不要二次编码）。
				for i, call := range calls {
					function := call["function"].(map[string]any)
					delta := map[string]any{"tool_calls": []map[string]any{{
						"index": i, "id": call["id"], "type": "function",
						"function": map[string]any{
							"name":      function["name"],
							"arguments": function["arguments"],
						},
					}}}
					writeChunk(delta)
				}
			} else {
				writeChunk(map[string]any{"role": "assistant", "content": reply["content"]})
			}
			_, _ = w.Write([]byte("data: [DONE]\n\n"))
			flusher.Flush()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "chatcmpl-test", "object": "chat.completion", "model": "fake",
			"choices": []map[string]any{{"index": 0, "message": reply, "finish_reason": "stop"}},
		})
	})
	fake.server = httptest.NewServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeLLMServer) client() *LLMClient {
	return NewLLMClient(LLMConfig{BaseURL: f.server.URL + "/v1", APIKey: "test", Model: "fake-model", TimeoutSec: 10})
}

func toolReply(name string, arguments map[string]any) map[string]any {
	encoded, _ := json.Marshal(arguments)
	return map[string]any{
		"role": "assistant", "content": "",
		"tool_calls": []map[string]any{{
			"id": "call_1", "type": "function",
			"function": map[string]any{"name": name, "arguments": string(encoded)},
		}},
	}
}

func TestAgentGenerateSavesRule(t *testing.T) {
	service, store, fetcher, base := newTestService(t)
	fake := newFakeLLM(t, []map[string]any{
		toolReply("save_rule", map[string]any{"rule": toolRulePayload(base)}),
		{"role": "assistant", "content": "已保存。"},
	})
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	agent, err := NewRuleAgent(fake.client(), registry, store, service, AgentConfig{MaxSteps: 6}, filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("NewRuleAgent: %v", err)
	}
	result, err := agent.Generate(context.Background(), base, "流浪地球", "", "")
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if result["success"] != true || result["saved"] != true {
		t.Fatalf("generate = %+v", result)
	}
	if _, ok := result["ruleId"].(string); !ok {
		t.Errorf("ruleId missing: %+v", result)
	}
	if len(store.List(false)) != 1 {
		t.Errorf("store has %d rules", len(store.List(false)))
	}
}

func TestAgentChatFlow(t *testing.T) {
	service, store, fetcher, _ := newTestService(t)
	fake := newFakeLLM(t, []map[string]any{
		toolReply("rename_session", map[string]any{"title": "给测试站建规则"}),
		toolReply("ask_user", map[string]any{"question": "需要你确认线路", "options": []string{"线路 A", "线路 B"}}),
		toolReply("task_complete", map[string]any{"summary": "全部搞定"}),
	})
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	agent, err := NewRuleAgent(fake.client(), registry, store, service, AgentConfig{}, filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("NewRuleAgent: %v", err)
	}
	ctx := context.Background()

	var events []map[string]any
	result, err := agent.Chat(ctx, ChatRequest{
		Message:    "帮我处理测试站",
		Autonomous: true,
		Emit:       func(event map[string]any) { events = append(events, event) },
	})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	sessionID, _ := result["sessionId"].(string)
	if sessionID == "" || result["awaitingUser"] != true {
		t.Fatalf("chat result = %+v", result)
	}
	if !strings.Contains(result["reply"].(string), "1. 线路 A") {
		t.Errorf("ask_user options missing: %q", result["reply"])
	}

	// 会话已落盘，标题被 rename_session 改过。
	sessions := agent.ListSessions()
	if len(sessions) != 1 || sessions[0]["title"] != "给测试站建规则" {
		t.Fatalf("sessions = %+v", sessions)
	}

	// 继续对话：ask_user 之后 task_complete。
	result, err = agent.Chat(ctx, ChatRequest{Message: "线路 A", SessionID: sessionID, Autonomous: true})
	if err != nil {
		t.Fatalf("chat 2: %v", err)
	}
	if result["completed"] != true || result["reply"] != "全部搞定" {
		t.Fatalf("chat 2 result = %+v", result)
	}
	detail, err := agent.GetSession(sessionID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	messages := detail["messages"].([]map[string]any)
	if len(messages) != 4 { // user, assistant, user, assistant
		t.Fatalf("messages = %d", len(messages))
	}
	if _, ok := messages[1]["events"]; !ok {
		t.Errorf("assistant message missing events: %+v", messages[1])
	}

	// 删除。
	if !agent.DeleteSession(sessionID) {
		t.Error("delete session failed")
	}
	if len(agent.ListSessions()) != 0 {
		t.Error("session not removed")
	}
}

func TestAgentRepairUpdatesRule(t *testing.T) {
	service, store, fetcher, base := newTestService(t)
	saved, err := store.Save(mustRule(t, toolRulePayload(base)), "")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	fake := newFakeLLM(t, []map[string]any{
		toolReply("update_rule", map[string]any{
			"rule_id": saved.ID,
			"patch":   map[string]any{"description": "已修复"},
		}),
		{"role": "assistant", "content": "修复完成。"},
	})
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	agent, err := NewRuleAgent(fake.client(), registry, store, service, AgentConfig{MaxSteps: 5}, filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatalf("NewRuleAgent: %v", err)
	}
	result, err := agent.Repair(context.Background(), saved, "月球", "没有解析到结果", "")
	if err != nil {
		t.Fatalf("Repair: %v", err)
	}
	if result["success"] != true || result["updated"] != true {
		t.Fatalf("repair = %+v", result)
	}
	latest, _ := store.Get(saved.ID)
	if latest.Description != "已修复" {
		t.Errorf("description = %q", latest.Description)
	}
}

func TestExtractRuleJSON(t *testing.T) {
	content := "前置说明\n```json\n" + `{"name":"x","search":{"request":{"url":"https://a.com/?q={keyword}"}}}` + "\n```\n后缀"
	rule := extractRuleJSON(content)
	if rule == nil || rule["name"] != "x" {
		t.Fatalf("extract = %+v", rule)
	}
	if extractRuleJSON("完全没有 JSON") != nil {
		t.Error("should be nil")
	}
	if extractRuleJSON(`{"a":1}`) != nil {
		t.Error("rule must contain search/parse")
	}
}

func TestNormalizeImages(t *testing.T) {
	valid := "data:image/png;base64,iVBORw0KGgo="
	out, err := NormalizeImages([]string{valid, valid, valid, valid, valid, "http://evil.com/x.png"})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(out) != maxImages {
		t.Errorf("images = %d", len(out))
	}
	if _, err := NormalizeImages([]string{"not-a-data-url"}); err == nil {
		t.Error("bad url should fail")
	}
}

func mustRule(t *testing.T, payload map[string]any) *Rule {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	var rule Rule
	if err := json.Unmarshal(encoded, &rule); err != nil {
		t.Fatal(err)
	}
	return &rule
}

func TestSessionPathValidation(t *testing.T) {
	agent := &RuleAgent{sessionsDir: t.TempDir()}
	if _, err := agent.sessionPath("../escape"); err == nil {
		t.Error("path traversal must be rejected")
	}
	if _, err := agent.sessionPath("chat-20261122-000000-000"); err != nil {
		t.Errorf("valid id rejected: %v", err)
	}
}

func TestUpdateSession(t *testing.T) {
	service, store, fetcher, _ := newTestService(t)
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	agent, err := NewRuleAgent(NewLLMClient(LLMConfig{APIKey: "k"}), registry, store, service, AgentConfig{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	created, err := agent.NewSession("", "", "")
	if err != nil {
		t.Fatal(err)
	}
	id := created["id"].(string)
	if _, err := agent.UpdateSession(id, "high", "新标题", "other-model"); err != nil {
		t.Fatalf("update: %v", err)
	}
	detail, _ := agent.GetSession(id)
	if detail["title"] != "新标题" || detail["model"] != "other-model" || detail["reasoningEffort"] != "high" {
		t.Errorf("session = %+v", detail)
	}
}
