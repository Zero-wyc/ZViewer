package crawler

import (
	"testing"
	"time"
)

// StartRun 后台执行：rename → task_complete 两个工具调用后结束。
func TestAgentRunManagerLifecycle(t *testing.T) {
	service, store, fetcher, _ := newTestService(t)
	fake := newFakeLLM(t, []map[string]any{
		toolReply("rename_session", map[string]any{"title": "后台任务"}),
		toolReply("task_complete", map[string]any{"summary": "干完了"}),
	})
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	agent, err := NewRuleAgent(fake.client(), registry, store, service, AgentConfig{}, t.TempDir())
	if err != nil {
		t.Fatalf("NewRuleAgent: %v", err)
	}
	manager := NewAgentRunManager()

	started, err := manager.StartRun(agent, ChatRequest{Message: "处理一下"})
	if err != nil {
		t.Fatalf("StartRun: %v", err)
	}
	if started["success"] != true || started["runId"] == "" || started["sessionId"] == "" {
		t.Fatalf("start = %+v", started)
	}
	runID := stringOf(started["runId"])

	deadline := time.Now().Add(10 * time.Second)
	for {
		snapshot := manager.GetRun(runID, 0)
		if snapshot == nil {
			t.Fatal("run snapshot missing")
		}
		if boolValue(snapshot["done"]) {
			if snapshot["status"] != "done" || snapshot["reply"] != "干完了" {
				t.Fatalf("final = %+v", snapshot)
			}
			if snapshot["steps"].(int) < 2 {
				t.Errorf("steps = %v", snapshot["steps"])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run not done in time: %+v", snapshot)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// 事件游标：cursor 之后没有新事件。
	snapshot := manager.GetRun(runID, 1000000)
	if len(snapshot["events"].([]map[string]any)) != 0 {
		t.Error("cursor filtering failed")
	}

	// 取消不存在的 run。
	if manager.CancelRun("run-missing") != nil {
		t.Error("cancel missing should be nil")
	}
}

// 消息为空必须报错，不允许起空 run。
func TestAgentRunManagerRejectsEmpty(t *testing.T) {
	service, store, fetcher, _ := newTestService(t)
	registry := BuildRegistry(ToolOptions{Store: store, Search: service, Fetcher: fetcher})
	agent, err := NewRuleAgent(NewLLMClient(LLMConfig{APIKey: "k"}), registry, store, service, AgentConfig{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	manager := NewAgentRunManager()
	if _, err := manager.StartRun(agent, ChatRequest{}); err == nil {
		t.Fatal("empty message should fail")
	}
}
