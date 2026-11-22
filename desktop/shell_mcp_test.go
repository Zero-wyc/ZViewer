package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// specFor 造一个指向临时目录的客户端描述，避免测试碰真实用户配置。
func specFor(t *testing.T, key string, stdioType bool, name string) mcpClientSpec {
	t.Helper()
	dir := t.TempDir()
	return mcpClientSpec{
		ID: "test", Name: "Test Client", Format: "json", Key: key, StdioTyp: stdioType,
		Path: filepath.Join(dir, name),
	}
}

// 合并写入必须保留用户已有的服务与其它顶层键：这是「一键写入」最容易出事的地方，
// 早先手写 JSON 时整份覆盖过一次，把用户别的 MCP 服务全删了。
func TestInstallMCPJSONMergesExisting(t *testing.T) {
	spec := specFor(t, "mcpServers", false, "claude_desktop_config.json")
	original := `{
  "mcpServers": {
    "other": {"command": "other.exe", "args": ["--x"]}
  },
  "globalShortcut": "Ctrl+Space"
}`
	if err := os.WriteFile(spec.Path, []byte(original), 0o600); err != nil {
		t.Fatalf("写初始配置失败: %v", err)
	}

	backup, err := installMCPJSON(spec.inspect(), `C:\\app\\zviewer-backend.exe`, []string{"--mcp"})
	if err != nil {
		t.Fatalf("installMCPJSON 失败: %v", err)
	}
	if backup == "" {
		t.Fatal("覆盖已有文件时必须留备份")
	}
	if _, err := os.Stat(backup); err != nil {
		t.Fatalf("备份文件不存在: %v", err)
	}

	raw, err := os.ReadFile(spec.Path)
	if err != nil {
		t.Fatalf("读回配置失败: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("写出的 JSON 不合法: %v\n%s", err, raw)
	}
	if doc["globalShortcut"] != "Ctrl+Space" {
		t.Fatalf("顶层其它键被改坏: %v", doc["globalShortcut"])
	}
	servers := doc["mcpServers"].(map[string]any)
	if _, ok := servers["other"]; !ok {
		t.Fatal("已有的 other 服务被删掉了")
	}
	entry, ok := servers[mcpServerEntryName].(map[string]any)
	if !ok {
		t.Fatalf("没有写入 %s", mcpServerEntryName)
	}
	if entry["command"] != `C:\\app\\zviewer-backend.exe` {
		t.Fatalf("command 不对: %v", entry["command"])
	}
	args, _ := entry["args"].([]any)
	if len(args) != 1 || args[0] != "--mcp" {
		t.Fatalf("args 不对: %v", entry["args"])
	}
	if _, hasType := entry["type"]; hasType {
		t.Fatal("mcpServers 客户端不该带 type 字段")
	}
}

// VS Code 用 servers 容器，且条目必须带 "type": "stdio"，否则 Copilot 不认。
func TestInstallMCPJSONVSCodeShape(t *testing.T) {
	spec := specFor(t, "servers", true, "mcp.json")
	if _, err := installMCPJSON(spec.inspect(), "zviewer-backend.exe", []string{"--mcp"}); err != nil {
		t.Fatalf("installMCPJSON 失败: %v", err)
	}
	raw, err := os.ReadFile(spec.Path)
	if err != nil {
		t.Fatalf("读回配置失败: %v", err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("写出的 JSON 不合法: %v", err)
	}
	if _, ok := doc["mcpServers"]; ok {
		t.Fatal("VS Code 不该写 mcpServers 键")
	}
	entry := doc["servers"].(map[string]any)[mcpServerEntryName].(map[string]any)
	if entry["type"] != "stdio" {
		t.Fatalf("VS Code 条目缺 type=stdio: %v", entry)
	}
}

// 配置文件本身不是合法 JSON 时不能猜着改：必须报错、原文不动、并留备份。
func TestInstallMCPJSONKeepsBrokenConfig(t *testing.T) {
	spec := specFor(t, "mcpServers", false, "claude_desktop_config.json")
	broken := `{"mcpServers": {`
	if err := os.WriteFile(spec.Path, []byte(broken), 0o600); err != nil {
		t.Fatalf("写初始配置失败: %v", err)
	}
	backup, err := installMCPJSON(spec.inspect(), "zviewer-backend.exe", []string{"--mcp"})
	if err == nil {
		t.Fatal("坏 JSON 时必须返回错误")
	}
	if backup == "" {
		t.Fatal("坏 JSON 时必须备份原文")
	}
	raw, _ := os.ReadFile(spec.Path)
	if string(raw) != broken {
		t.Fatalf("原文被改动了: %s", raw)
	}
}

// Codex 是 TOML：只替换自己那一段，别的段与注释必须原样保留。
func TestInstallMCPTOMLReplacesOnlyOwnSection(t *testing.T) {
	spec := specFor(t, "", false, "config.toml")
	spec.Format = "toml"
	original := strings.Join([]string{
		"# 用户的注释",
		"model = \"gpt-5\"",
		"",
		"[mcp_servers.other]",
		"command = \"other.exe\"",
		"",
		"[mcp_servers." + mcpServerEntryName + "]",
		"command = \"旧路径.exe\"",
		"args = [\"--old\"]",
		"env = { A = \"1\" }",
		"",
		"[other_section]",
		"keep = true",
		"",
	}, "\n")
	if err := os.WriteFile(spec.Path, []byte(original), 0o600); err != nil {
		t.Fatalf("写初始配置失败: %v", err)
	}

	if _, err := installMCPTOML(spec.Path, `C:\app\zviewer-backend.exe`, []string{"--mcp"}); err != nil {
		t.Fatalf("installMCPTOML 失败: %v", err)
	}
	raw, _ := os.ReadFile(spec.Path)
	text := string(raw)
	if strings.Contains(text, "旧路径.exe") || strings.Contains(text, "--old") {
		t.Fatalf("旧段落没有被替换:\n%s", text)
	}
	for _, keep := range []string{"# 用户的注释", "model = \"gpt-5\"", "[mcp_servers.other]", "[other_section]", "keep = true"} {
		if !strings.Contains(text, keep) {
			t.Fatalf("已有内容被破坏，缺少 %q:\n%s", keep, text)
		}
	}
	if strings.Count(text, "[mcp_servers."+mcpServerEntryName+"]") != 1 {
		t.Fatalf("新的段应当只出现一次:\n%s", text)
	}
	if !strings.Contains(text, `command = "C:\\app\\zviewer-backend.exe"`) {
		t.Fatalf("command 没有写进去:\n%s", text)
	}
	if !mcpConfigured(spec.inspect().mcpClientSpec) {
		t.Fatal("回读校验认为没写进去")
	}
}

// 没有该段时追加到文件末尾，并保证前面留出空行（TOML 段之间要空行）。
func TestInstallMCPTOMLAppendsSection(t *testing.T) {
	spec := specFor(t, "", false, "config.toml")
	spec.Format = "toml"
	if err := os.WriteFile(spec.Path, []byte("model = \"gpt-5\"\n"), 0o600); err != nil {
		t.Fatalf("写初始配置失败: %v", err)
	}
	if _, err := installMCPTOML(spec.Path, "zviewer-backend.exe", []string{"--mcp", "--root", "C:\\crawler"}); err != nil {
		t.Fatalf("installMCPTOML 失败: %v", err)
	}
	text := string(mustRead(t, spec.Path))
	if !strings.Contains(text, "model = \"gpt-5\"\n\n[mcp_servers."+mcpServerEntryName+"]") {
		t.Fatalf("追加位置不对:\n%s", text)
	}
	if !strings.Contains(text, `args = ["--mcp", "--root", "C:\\crawler"]`) {
		t.Fatalf("args 没写全:\n%s", text)
	}
}

// 全部写入时跳过没装客户端的机器：不能凭空造出 %APPDATA%\Claude 这种空目录。
func TestMcpInstallWritesOnlyDetectedClients(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	appData := filepath.Join(home, "AppData", "Roaming")
	t.Setenv("APPDATA", appData)
	// 只「装」Claude Desktop：目录存在即视为已安装。
	if err := os.MkdirAll(filepath.Join(appData, "Claude"), 0o755); err != nil {
		t.Fatalf("建 Claude 目录失败: %v", err)
	}
	// 假的可执行文件：mcpInstall 会检查它存在。
	exe := filepath.Join(home, "zviewer-backend.exe")
	if err := os.WriteFile(exe, []byte("x"), 0o600); err != nil {
		t.Fatalf("建假 exe 失败: %v", err)
	}

	app := &App{root: home, crawler: &crawlerBridge{root: filepath.Join(home, "crawler")}}
	raw, err := app.mcpInstall(map[string]any{})
	if err != nil {
		t.Fatalf("mcpInstall 失败: %v", err)
	}
	report := raw.(map[string]any)
	if report["written"] != 1 {
		t.Fatalf("只应写入 1 个客户端，实际 %v", report["written"])
	}
	claudeConfig := filepath.Join(appData, "Claude", "claude_desktop_config.json")
	if !strings.Contains(string(mustRead(t, claudeConfig)), mcpServerEntryName) {
		t.Fatal("Claude Desktop 配置里没有写入服务条目")
	}
	// 其它客户端一个目录都不该被创建。
	for _, unexpected := range []string{
		filepath.Join(appData, "Code"),
		filepath.Join(home, ".cursor"),
		filepath.Join(home, ".codeium"),
		filepath.Join(home, ".codex"),
	} {
		if dirExists(unexpected) {
			t.Fatalf("不该凭空空造目录：%s", unexpected)
		}
	}
}

// 没有桥接时直接报错，这是脚本化调用最容易踩的路径。
func TestMcpInstallNeedsBridge(t *testing.T) {
	app := &App{root: t.TempDir()}
	if _, err := app.mcpInstall(map[string]any{}); err == nil {
		t.Fatal("桥接未初始化时必须返回错误")
	}
}

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

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取 %s 失败: %v", path, err)
	}
	return raw
}
