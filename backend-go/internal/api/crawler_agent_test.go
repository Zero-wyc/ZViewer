package api

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Agent 由 crawler/config.json 构建：Key/模型/自定义提示词都从配置读。
func TestLocalAgentBuildsFromConfig(t *testing.T) {
	dir := t.TempDir()
	config := `{
	  "llm": {"base_url": "http://llm.invalid/v1", "api_key": "sk-test", "model": "fake-model", "temperature": 0.2, "max_tokens": 1024, "timeout_sec": 30, "reasoning_effort": "low"},
	  "agent": {"max_steps": 5, "auto_continue": 1, "custom_prompt": "只测 hls"},
	  "generation": {"max_steps": 8, "sample_keyword": "动画"}
	}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(config), 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}
	t.Setenv("CRAWLER_ROOT", dir)
	resetLocalCrawler()
	defer resetLocalCrawler()

	if localCrawler() == nil {
		t.Fatal("bundle not built")
	}
	agent, runs, err := localAgentPair()
	if err != nil || agent == nil || runs == nil {
		t.Fatalf("localAgentPair = %v, %v, %v", agent, runs, err)
	}
	if agent.DefaultModel() != "fake-model" {
		t.Errorf("model = %q", agent.DefaultModel())
	}
	if !agent.HasTool("generate_rule") {
		t.Error("generate_rule not registered")
	}
	if !agent.HasTool("fetch_page") || !agent.HasTool("test_play") {
		t.Error("core tools missing")
	}

	// 改配置文件后自动重建（新模型名生效，run 管理器保留）。
	time.Sleep(10 * time.Millisecond) // 保证 mtime 变化
	updated := `{"llm": {"base_url": "http://llm.invalid/v1", "api_key": "sk-test", "model": "other-model"}}`
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(updated), 0o644); err != nil {
		t.Fatalf("rewrite config: %v", err)
	}
	agent2, runs2, err := localAgentPair()
	if err != nil || agent2 == nil {
		t.Fatalf("second pair: %v", err)
	}
	if agent2.DefaultModel() != "other-model" {
		t.Errorf("model after change = %q", agent2.DefaultModel())
	}
	if runs2 != runs {
		t.Error("run manager should survive config reload")
	}
}

// 没有本地引擎时 agent 与 run 都是 nil（老安装走 3789 回退）。
//
// crawlerRoot 的环境变量是直接采信的（壳注入的路径一定是真的），所以这里
// 用干净的临时工作目录 + 清空环境变量来模拟「什么都没有」。
func TestLocalAgentNilWithoutRoot(t *testing.T) {
	t.Setenv("CRAWLER_ROOT", "")
	t.Setenv("ZVIEWER_CRAWLER_ROOT", "")
	t.Chdir(t.TempDir())
	resetLocalCrawler()
	defer resetLocalCrawler()

	if crawlerRoot() != "" {
		t.Fatalf("crawlerRoot = %q, want empty", crawlerRoot())
	}
	agent, runs, err := localAgentPair()
	if err != nil || agent != nil || runs != nil {
		t.Errorf("expected all nil, got %v %v %v", agent, runs, err)
	}
}
