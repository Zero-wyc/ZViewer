package api

import (
	"os"
	"path/filepath"
	"testing"

	"zviewer/backend/internal/crawler"
)

func TestCrawlerRootFromEnv(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CRAWLER_ROOT", dir)
	if got := crawlerRoot(); got != dir {
		t.Errorf("crawlerRoot() = %q, want %q", got, dir)
	}
}

func TestCrawlerRootPrefersExplicitOverShell(t *testing.T) {
	explicit := t.TempDir()
	shell := t.TempDir()
	t.Setenv("CRAWLER_ROOT", explicit)
	t.Setenv("ZVIEWER_CRAWLER_ROOT", shell)
	if got := crawlerRoot(); got != explicit {
		t.Errorf("explicit CRAWLER_ROOT should win, got %q", got)
	}
}

func TestLocalCrawlerUsesRoot(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CRAWLER_ROOT", dir)
	t.Setenv("ZVIEWER_CRAWLER_ROOT", "")
	resetLocalCrawler()
	defer resetLocalCrawler()

	service := localCrawler()
	if service == nil {
		t.Fatal("localCrawler() returned nil with a valid root")
	}
	// 目录会被自动创建（与 Python 的 RuleStore 一致）。
	if _, err := os.Stat(filepath.Join(dir, "data", "rules")); err != nil {
		t.Errorf("rules dir not created: %v", err)
	}
	if sites := service.ListSites("", "guest"); len(sites) != 0 {
		t.Errorf("empty store should yield 0 sites, got %d", len(sites))
	}
	// 单例：再次调用返回同一实例。
	if again := localCrawler(); again != service {
		t.Error("localCrawler should be a singleton")
	}
}

func TestLocalCrawlerReadsPythonRules(t *testing.T) {
	// 与 Python 版共用一个规则目录：文件由任一侧写入，另一侧都能读到。
	dir := t.TempDir()
	rulesDir := filepath.Join(dir, "data", "rules")
	if err := os.MkdirAll(rulesDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ruleJSON := `{
	  "id": "demo",
	  "name": "示例站",
	  "site": "example.com",
	  "enabled": true,
	  "visibility": "public",
	  "search": {"mode": "http", "request": {"method": "GET", "url": "https://example.com/s?q={keyword}"}},
	  "parse": {"type": "html", "container": ".item", "fields": {"title": {"selector": ".t"}, "url": {"selector": "a", "attr": "href"}}}
	}`
	if err := os.WriteFile(filepath.Join(rulesDir, "demo.json"), []byte(ruleJSON), 0o644); err != nil {
		t.Fatalf("write rule: %v", err)
	}

	t.Setenv("CRAWLER_ROOT", dir)
	resetLocalCrawler()
	defer resetLocalCrawler()

	service := localCrawler()
	if service == nil {
		t.Fatal("service nil")
	}
	sites := service.ListSites("", "guest")
	if len(sites) != 1 {
		t.Fatalf("sites = %d", len(sites))
	}
	if sites[0]["name"] != "示例站" {
		t.Errorf("name = %v", sites[0]["name"])
	}
	// 解析段不应出现在列表视图里（只有 includeParse 才带）。
	if _, leaked := sites[0]["parse"]; leaked {
		t.Error("parse section leaked into list view")
	}
}

func TestCrawlerErrorStatus(t *testing.T) {
	cases := map[string]int{
		"challenge_required": 409,
		"site_not_found":     400,
		"site_forbidden":     400,
		"keyword_required":   400,
		"rule_error":         400,
		"fetch_error":        502,
		"llm_error":          500,
		"unknown_code":       500,
	}
	for code, want := range cases {
		if got := crawlerErrorStatus(code); got != want {
			t.Errorf("crawlerErrorStatus(%q) = %d, want %d", code, got, want)
		}
	}
}

func TestCrawlerErrorShape(t *testing.T) {
	engineErr := crawler.NewChallengeError(map[string]any{
		"reason":      "status:403",
		"name":        "示例站",
		"challengeId": "abc",
	})
	payload := engineErr.ToMap()
	if payload["code"] != "challenge_required" {
		t.Errorf("code = %v", payload["code"])
	}
	details, ok := payload["details"].(map[string]any)
	if !ok || details["challengeId"] != "abc" {
		t.Errorf("details = %#v", payload["details"])
	}
}
