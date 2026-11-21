package crawler

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestLLM(serverURL string) *LLMClient {
	return NewLLMClient(LLMConfig{
		BaseURL:    serverURL + "/v1",
		APIKey:     "test-key",
		Model:      "test-model",
		TimeoutSec: 10,
	})
}

func TestLLMChatNonStream(t *testing.T) {
	var gotPath, gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"stop","message":{"role":"assistant","content":"你好","reasoning_content":"思考中"}}],"usage":{"total_tokens":12}}`))
	}))
	defer server.Close()

	result, err := newTestLLM(server.URL).Chat(context.Background(),
		[]map[string]any{{"role": "user", "content": "hi"}}, ChatOptions{})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if gotPath != "/v1/chat/completions" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Bearer test-key" {
		t.Errorf("auth = %q", gotAuth)
	}
	if result.Content != "你好" || result.Reasoning != "思考中" {
		t.Errorf("content=%q reasoning=%q", result.Content, result.Reasoning)
	}
	if result.FinishReason != "stop" {
		t.Errorf("finish = %q", result.FinishReason)
	}
}

func TestLLMChatToolCalls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","content":null,
			"tool_calls":[{"id":"call_1","type":"function","function":{"name":"search_site","arguments":"{\"site\":\"a.com\"}"}}]}}]}`))
	}))
	defer server.Close()

	result, err := newTestLLM(server.URL).Chat(context.Background(), nil, ChatOptions{})
	if err != nil {
		t.Fatalf("chat: %v", err)
	}
	if len(result.ToolCalls) != 1 {
		t.Fatalf("tool calls = %d", len(result.ToolCalls))
	}
	call := result.ToolCalls[0]
	if call.ID != "call_1" || call.Name != "search_site" || call.Arguments["site"] != "a.com" {
		t.Errorf("call = %+v", call)
	}
	// 回填成 assistant 消息时 arguments 必须是字符串。
	message := result.AssistantMessage()
	calls, ok := message["tool_calls"].([]any)
	if !ok || len(calls) != 1 {
		t.Fatalf("assistant message = %+v", message)
	}
	function := calls[0].(map[string]any)["function"].(map[string]any)
	if _, isString := function["arguments"].(string); !isString {
		t.Errorf("arguments should be a JSON string, got %T", function["arguments"])
	}
}

func TestLLMChatStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		chunks := []string{
			`data: {"choices":[{"delta":{"reasoning_content":"想"}}]}`,
			`data: {"choices":[{"delta":{"content":"你"}}]}`,
			`data: {"choices":[{"delta":{"content":"好"}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"do_","arguments":"{\"a\":"}}]}}]}`,
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"x","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}`,
			`data: [DONE]`,
		}
		for _, chunk := range chunks {
			_, _ = fmt.Fprintln(w, chunk)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	defer server.Close()

	var deltas []string
	result, err := newTestLLM(server.URL).ChatStream(context.Background(), nil, ChatOptions{
		OnDelta: func(kind, text string) { deltas = append(deltas, kind+":"+text) },
	})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if result.Content != "你好" || result.Reasoning != "想" {
		t.Errorf("content=%q reasoning=%q", result.Content, result.Reasoning)
	}
	if len(deltas) != 3 {
		t.Errorf("deltas = %v", deltas)
	}
	// tool_calls 分片要按 index 拼成一个完整调用。
	if len(result.ToolCalls) != 1 || result.ToolCalls[0].Name != "do_x" {
		t.Fatalf("tool calls = %+v", result.ToolCalls)
	}
	if _, ok := result.ToolCalls[0].Arguments["a"]; !ok {
		t.Errorf("arguments = %+v", result.ToolCalls[0].Arguments)
	}
}

func TestLLMStreamFallsBackToChat(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		// 第一轮（stream=true）什么都不吐，模拟不支持流式的服务端。
		if strings.Contains(readBody(t, r), `"stream":true`) {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"回退成功"}}]}`))
	}))
	defer server.Close()

	result, err := newTestLLM(server.URL).ChatStream(context.Background(), nil, ChatOptions{})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	if result.Content != "回退成功" {
		t.Errorf("content = %q", result.Content)
	}
	if calls != 2 {
		t.Errorf("expected fallback (2 calls), got %d", calls)
	}
}

func TestLLMMissingAPIKey(t *testing.T) {
	client := NewLLMClient(LLMConfig{BaseURL: "http://127.0.0.1:1/v1"})
	_, err := client.Chat(context.Background(), nil, ChatOptions{})
	if err == nil || ErrorCode(err) != "llm_error" {
		t.Fatalf("want llm_error, got %v", err)
	}
	if !strings.Contains(err.Error(), "API Key") {
		t.Errorf("message = %s", err.Error())
	}
}

func TestLLMListModels(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"data":[{"id":"b-model"},{"id":"a-model"}]}`))
	}))
	defer server.Close()
	models, err := newTestLLM(server.URL).ListModels(context.Background())
	if err != nil {
		t.Fatalf("models: %v", err)
	}
	if len(models) != 2 || models[0] != "a-model" || models[1] != "b-model" {
		t.Errorf("models = %v", models)
	}
}

func TestLLMEndpointNormalisation(t *testing.T) {
	cases := map[string]string{
		"":                                      "https://api.deepseek.com/v1/chat/completions",
		"https://api.x.com/v1":                  "https://api.x.com/v1/chat/completions",
		"https://api.x.com/v1/":                 "https://api.x.com/v1/chat/completions",
		"https://api.x.com/v1/chat/completions": "https://api.x.com/v1/chat/completions",
	}
	for base, want := range cases {
		client := NewLLMClient(LLMConfig{BaseURL: base})
		if got := client.endpoint(); got != want {
			t.Errorf("endpoint(%q) = %q, want %q", base, got, want)
		}
	}
}

func TestParseArgumentsBadJSON(t *testing.T) {
	if got := parseArguments("{not json"); got["__raw"] != "{not json" {
		t.Errorf("raw fallback = %+v", got)
	}
	if got := parseArguments("[1,2]"); got["value"] == nil {
		t.Errorf("array fallback = %+v", got)
	}
	if got := parseArguments(""); len(got) != 0 {
		t.Errorf("empty = %+v", got)
	}
}

func readBody(t *testing.T, r *http.Request) string {
	t.Helper()
	buffer := make([]byte, r.ContentLength)
	_, _ = r.Body.Read(buffer)
	return string(buffer)
}

var _ = time.Second
