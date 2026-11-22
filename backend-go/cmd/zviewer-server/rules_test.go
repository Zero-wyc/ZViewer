package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"zviewer/backend/internal/config"
)

// cliBundleRule 造一条最小可校验通过的规则（http 搜索 + html 解析）。
// 刻意只写必需字段：CLI 测的是搬运链路，不是规则语义。
func cliBundleRule(name, site string) map[string]any {
	return map[string]any{
		"name":    name,
		"site":    site,
		"enabled": true,
		"search": map[string]any{
			"mode":    "http",
			"request": map[string]any{"method": "GET", "url": "https://" + site + "/s?q={keyword}"},
		},
		"parse": map[string]any{
			"type":      "html",
			"container": ".item",
			"fields": map[string]any{
				"title": map[string]any{"selector": ".t"},
				"url":   map[string]any{"selector": "a", "attr": "href"},
			},
		},
	}
}

func writeCLIBundle(t *testing.T, dir string, rules ...map[string]any) string {
	t.Helper()
	payload := map[string]any{
		"kind":   "zviewer-crawler-rules",
		"format": 1,
		"count":  len(rules),
		"rules":  rules,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal bundle: %v", err)
	}
	path := filepath.Join(dir, "bundle.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write bundle: %v", err)
	}
	return path
}

// runCLI 包一层：固定 CRAWLER_ROOT 为空，避免继承开发机上的真实目录。
func runCLI(t *testing.T, cfg *config.Config, args ...string) (int, string, string) {
	t.Helper()
	t.Setenv("CRAWLER_ROOT", "")
	var stdout, stderr bytes.Buffer
	code := runRulesCLI(args, cfg, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func countRuleFiles(t *testing.T, root string) int {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(root, "data", "rules"))
	if err != nil {
		return 0
	}
	return len(entries)
}

func TestRulesCLIDryRunThenImport(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{ConfigDir: dir}
	bundle := writeCLIBundle(t, dir, cliBundleRule("演示站", "demo.example.com"))
	root := filepath.Join(dir, "crawler")

	code, stdout, stderr := runCLI(t, cfg, "--import-rules", bundle, "--dry-run")
	if code != 0 {
		t.Fatalf("dry-run exit = %d, stderr = %s", code, stderr)
	}
	if !strings.Contains(stdout, "预检") {
		t.Errorf("dry-run 输出应标注未写入，实际：%s", stdout)
	}
	if got := countRuleFiles(t, root); got != 0 {
		t.Fatalf("dry-run 不应落盘，实际写了 %d 个文件", got)
	}

	code, _, stderr = runCLI(t, cfg, "--import-rules", bundle)
	if code != 0 {
		t.Fatalf("import exit = %d, stderr = %s", code, stderr)
	}
	if got := countRuleFiles(t, root); got != 1 {
		t.Fatalf("导入后规则文件数 = %d，期望 1", got)
	}
}

func TestRulesCLIReplaceBacksUp(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{ConfigDir: dir}
	root := filepath.Join(dir, "crawler")
	first := writeCLIBundle(t, dir, cliBundleRule("旧站", "old.example.com"))
	if code, _, stderr := runCLI(t, cfg, "--import-rules", first); code != 0 {
		t.Fatalf("首次导入失败：%s", stderr)
	}

	second := filepath.Join(dir, "second.json")
	raw, _ := json.Marshal(map[string]any{
		"kind":  "zviewer-crawler-rules",
		"rules": []any{cliBundleRule("新站", "new.example.com")},
	})
	if err := os.WriteFile(second, raw, 0o600); err != nil {
		t.Fatalf("write second: %v", err)
	}

	code, stdout, stderr := runCLI(t, cfg, "--import-rules", second, "--mode", "replace")
	if code != 0 {
		t.Fatalf("replace exit = %d, stderr = %s", code, stderr)
	}
	if !strings.Contains(stdout, "备份") {
		t.Errorf("replace 应提示备份路径，实际：%s", stdout)
	}
	backups, _ := filepath.Glob(filepath.Join(root, "backup-*.json"))
	if len(backups) != 1 {
		t.Fatalf("备份文件数 = %d，期望 1", len(backups))
	}
	// 备份里必须是替换前的旧规则，不是新规则。
	content, err := os.ReadFile(backups[0])
	if err != nil {
		t.Fatalf("read backup: %v", err)
	}
	if !strings.Contains(string(content), "old.example.com") {
		t.Errorf("备份内容应为旧规则，实际：%s", string(content))
	}
	if got := countRuleFiles(t, root); got != 1 {
		t.Errorf("replace 后规则文件数 = %d，期望 1", got)
	}
}

func TestRulesCLIExportRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{ConfigDir: dir}
	bundle := writeCLIBundle(t, dir,
		cliBundleRule("甲站", "a.example.com"),
		cliBundleRule("乙站", "b.example.com"),
	)
	if code, _, stderr := runCLI(t, cfg, "--import-rules", bundle); code != 0 {
		t.Fatalf("导入失败：%s", stderr)
	}

	out := filepath.Join(dir, "out.json")
	if code, _, stderr := runCLI(t, cfg, "--export-rules", out); code != 0 {
		t.Fatalf("导出失败：%s", stderr)
	}
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("read export: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("导出的不是合法 JSON：%v", err)
	}
	if payload["kind"] != "zviewer-crawler-rules" {
		t.Errorf("kind = %v", payload["kind"])
	}
	rules, _ := payload["rules"].([]any)
	if len(rules) != 2 {
		t.Fatalf("导出条数 = %d，期望 2", len(rules))
	}
}

func TestRulesCLIMissingArgs(t *testing.T) {
	dir := t.TempDir()
	cfg := &config.Config{ConfigDir: dir}
	code, _, stderr := runCLI(t, cfg)
	if code == 0 {
		t.Fatal("无参数应返回非 0 退出码")
	}
	if !strings.Contains(stderr, "--import-rules") {
		t.Errorf("应打印用法，实际：%s", stderr)
	}
}
