package console

import (
	"strings"
	"testing"
)

// 提示词要自带命令、参数、目录，否则对面的大模型只能猜。
func TestMcpDeployPromptCarriesLocations(t *testing.T) {
	tools := []any{
		map[string]any{"name": "test_rule"},
		map[string]any{"name": "fetch_page"},
	}
	prompt := mcpDeployPrompt(`C:\app\zviewer-backend.exe`, []string{"--mcp"}, `C:\app\runtime\crawler`, tools)
	for _, want := range []string{
		`C:\app\zviewer-backend.exe`,
		`C:\app\runtime\crawler`,
		"fetch_page",
		"test_rule",
		"tools/list",
		"claude_desktop_config.json",
		"[mcp_servers." + mcpServerEntryName + "]",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("提示词缺少 %q", want)
		}
	}
	// 工具名排序后出现：fetch_page 在 test_rule 前面，便于对面模型按顺序读。
	if strings.Index(prompt, "fetch_page") > strings.Index(prompt, "test_rule") {
		t.Fatal("工具名没有排序")
	}
}

// 各家客户端的路径要能拿到：界面「手动配置」标签靠它说明该填在哪个文件。
func TestMcpClientsCarryPaths(t *testing.T) {
	clients := mcpClients()
	if len(clients) != len(mcpClientSpecs()) || len(clients) == 0 {
		t.Fatalf("clients = %d", len(clients))
	}
	for _, item := range clients {
		if item["id"] == "" || item["path"] == "" {
			t.Fatalf("client 缺字段: %#v", item)
		}
	}
}
