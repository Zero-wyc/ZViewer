package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// fakeRegistry 是最小工具集：一个回显、一个固定失败，用来验证协议层
// 不会把工具语义搞错（尤其是 isError 的判定）。
type fakeRegistry struct {
	lastName string
	lastArgs map[string]any
}

func (f *fakeRegistry) MCPTools() []map[string]any {
	return []map[string]any{
		{
			"name":        "echo",
			"description": "回显参数",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}},
		},
		{
			"name":        "boom",
			"description": "总是失败",
			"inputSchema": map[string]any{"type": "object"},
		},
	}
}

func (f *fakeRegistry) Call(ctx context.Context, name string, args map[string]any) map[string]any {
	f.lastName = name
	f.lastArgs = args
	if name == "boom" {
		return map[string]any{"success": false, "code": "rule_error", "error": "规则不合法"}
	}
	return map[string]any{"success": true, "text": args["text"]}
}

func newFake() (*fakeRegistry, *Handler) {
	registry := &fakeRegistry{}
	return registry, NewHandler(registry, "9.9.9", nil)
}

// call 是「一行请求 → 一行响应」的便捷入口，和真实 stdio 走同一条路径。
func call(t *testing.T, handler *Handler, line string) map[string]any {
	t.Helper()
	raw := handler.handleLine(context.Background(), []byte(line))
	if raw == nil {
		return nil
	}
	var response map[string]any
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, raw)
	}
	return response
}

func TestInitializeNegotiatesVersion(t *testing.T) {
	cases := []struct {
		requested string
		want      string
	}{
		{"2024-11-05", "2024-11-05"},
		{"2025-03-26", "2025-03-26"},
		{"2025-06-18", "2025-06-18"},
		// 客户端报了个我们不认识的版本：回最新的，由客户端决定要不要继续。
		{"2020-01-01", LatestVersion},
		{"", LatestVersion},
	}
	for _, item := range cases {
		_, handler := newFake()
		response := call(t, handler, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"`+item.requested+`"}}`)
		result, _ := response["result"].(map[string]any)
		if got := result["protocolVersion"]; got != item.want {
			t.Fatalf("requested %q: protocolVersion=%v, want %v", item.requested, got, item.want)
		}
		info, _ := result["serverInfo"].(map[string]any)
		if info["name"] != ServerName {
			t.Fatalf("serverInfo.name=%v, want %s", info["name"], ServerName)
		}
	}
}

func TestToolsListAndCall(t *testing.T) {
	registry, handler := newFake()

	list := call(t, handler, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	result, _ := list["result"].(map[string]any)
	tools, _ := result["tools"].([]any)
	if len(tools) != 2 {
		t.Fatalf("tools 数量=%d, want 2", len(tools))
	}

	reply := call(t, handler, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"<b>&</b>"}}}`)
	body, _ := reply["result"].(map[string]any)
	if body["isError"] != false {
		t.Fatalf("isError=%v, want false", body["isError"])
	}
	content, _ := body["content"].([]any)
	first, _ := content[0].(map[string]any)
	text, _ := first["text"].(string)
	// SetEscapeHTML(false)：规则里的正则/选择器常带尖括号，不能转义成 \u003c。
	if !strings.Contains(text, "<b>&</b>") {
		t.Fatalf("工具结果被转义了: %s", text)
	}
	if registry.lastName != "echo" {
		t.Fatalf("工具名没有透传: %s", registry.lastName)
	}
}

func TestToolFailureMarksIsError(t *testing.T) {
	_, handler := newFake()
	reply := call(t, handler, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"boom"}}`)
	body, _ := reply["result"].(map[string]any)
	if body["isError"] != true {
		t.Fatalf("success=false 必须映射成 isError=true，当前 %v", body["isError"])
	}
}

func TestNotificationsGetNoResponse(t *testing.T) {
	_, handler := newFake()
	for _, line := range []string{
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		`{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}}`,
		`{"jsonrpc":"2.0","method":"some/unknown"}`,
	} {
		if response := call(t, handler, line); response != nil {
			t.Fatalf("通知不该有响应: %s → %v", line, response)
		}
	}
}

func TestProtocolErrors(t *testing.T) {
	_, handler := newFake()
	cases := []struct {
		line string
		code float64
	}{
		{`{oops`, -32700},
		{`[{"jsonrpc":"2.0","id":1,"method":"ping"}]`, -32600},
		{`{"jsonrpc":"2.0","id":5,"method":"no/such"}`, -32601},
		{`{"jsonrpc":"2.0","id":6}`, -32600},
	}
	for _, item := range cases {
		response := call(t, handler, item.line)
		errBody, _ := response["error"].(map[string]any)
		if errBody == nil {
			t.Fatalf("%s 应该报错，实际 %v", item.line, response)
		}
		if errBody["code"] != item.code {
			t.Fatalf("%s: code=%v, want %v", item.line, errBody["code"], item.code)
		}
	}
}

// id 必须原样回显：数字、字符串都要，客户端靠它配对。
func TestIDIsEchoedVerbatim(t *testing.T) {
	_, handler := newFake()
	for _, item := range []struct{ line, want string }{
		{`{"jsonrpc":"2.0","id":42,"method":"ping"}`, `42`},
		{`{"jsonrpc":"2.0","id":"abc","method":"ping"}`, `"abc"`},
	} {
		raw := handler.handleLine(context.Background(), []byte(item.line))
		if !bytes.Contains(raw, []byte(`"id":`+item.want)) {
			t.Fatalf("%s → %s, want id %s", item.line, raw, item.want)
		}
	}
}

// Serve 是真正的 stdio 循环：一行一条，通知不产生输出，EOF 正常退出。
func TestServeStream(t *testing.T) {
	_, handler := newFake()
	input := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
		"",
		`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}`,
	}, "\r\n")

	var out bytes.Buffer
	if err := Serve(context.Background(), strings.NewReader(input), &out, handler); err != nil {
		t.Fatalf("Serve 失败: %v", err)
	}
	lines := strings.Split(strings.TrimRight(out.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("期望 3 行响应（通知不回包），实际 %d: %q", len(lines), out.String())
	}
	for _, line := range lines {
		var response map[string]any
		if err := json.Unmarshal([]byte(line), &response); err != nil {
			t.Fatalf("输出被污染（不是纯 JSON 行）: %q", line)
		}
		if response["jsonrpc"] != "2.0" {
			t.Fatalf("缺少 jsonrpc 字段: %s", line)
		}
	}
}

// 只含空白的输入不该产生任何输出，也不该报错。
func TestServeIgnoresBlankLines(t *testing.T) {
	_, handler := newFake()
	var out bytes.Buffer
	if err := Serve(context.Background(), strings.NewReader("\n\n \n"), &out, handler); err != nil {
		t.Fatalf("Serve 失败: %v", err)
	}
	if out.Len() != 0 {
		t.Fatalf("空输入产生了输出: %q", out.String())
	}
}
