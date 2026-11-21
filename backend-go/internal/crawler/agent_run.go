package crawler

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Agent run 管理器：后台 goroutine 执行一轮对话，前端用游标轮询事件。
//
// 对应 Python 版 agent_run.py。run 在模型调用 task_complete、用户取消或
// 出错时结束；事件上限与保留策略与 Python 一致（6000 条 / 60 个 run）。

const (
	maxEventsPerRun = 6000
	maxRuns         = 60
)

// AgentRun 是一次后台执行的快照容器。
type AgentRun struct {
	ID        string
	SessionID string

	mu        sync.Mutex
	status    string // running / done / error / cancelled
	errorText string
	reply     string
	steps     int
	createdAt time.Time
	updatedAt time.Time
	cancelled bool
	events    []map[string]any
	nextSeq   int64
}

func newAgentRun(id, sessionID string) *AgentRun {
	now := time.Now()
	return &AgentRun{
		ID:        id,
		SessionID: sessionID,
		status:    "running",
		createdAt: now,
		updatedAt: now,
		events:    []map[string]any{},
		nextSeq:   1,
	}
}

// Emit 追加一条事件（打上序号与毫秒时间戳）。
func (r *AgentRun) Emit(event map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	item := map[string]any{}
	for key, value := range event {
		item[key] = value
	}
	item["seq"] = r.nextSeq
	item["at"] = time.Now().UnixMilli()
	r.nextSeq++
	if len(r.events) < maxEventsPerRun {
		r.events = append(r.events, item)
	}
	r.updatedAt = time.Now()
}

// Cancelled 返回是否已请求取消。
func (r *AgentRun) Cancelled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.cancelled
}

// RequestCancel 标记取消。
func (r *AgentRun) RequestCancel() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cancelled = true
}

func (r *AgentRun) finish(status, errorText, reply string, steps int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status = status
	r.errorText = errorText
	r.reply = reply
	r.steps = steps
	r.updatedAt = time.Now()
}

func (r *AgentRun) snapshot(cursor int64) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	events := make([]map[string]any, 0, len(r.events))
	var next int64 = cursor
	for _, item := range r.events {
		if seq, _ := item["seq"].(int64); seq > cursor {
			events = append(events, item)
			if seq > next {
				next = seq
			}
		}
	}
	done := r.status == "done" || r.status == "error" || r.status == "cancelled"
	return map[string]any{
		"id":              r.ID,
		"sessionId":       r.SessionID,
		"status":          r.status,
		"error":           r.errorText,
		"reply":           r.reply,
		"steps":           r.steps,
		"events":          events,
		"nextCursor":      next,
		"done":            done,
		"cancelRequested": r.cancelled,
		"tookMs":          time.Since(r.createdAt).Milliseconds(),
	}
}

// AgentRunManager 管理活跃与近期完成的 run。
type AgentRunManager struct {
	mu   sync.Mutex
	runs map[string]*AgentRun
}

// NewAgentRunManager 构造管理器。
func NewAgentRunManager() *AgentRunManager {
	return &AgentRunManager{runs: map[string]*AgentRun{}}
}

// StartRun 在后台执行一轮对话并返回 run 快照。
func (m *AgentRunManager) StartRun(agent *RuleAgent, req ChatRequest) (map[string]any, error) {
	message := req.Message
	if strings.TrimSpace(message) == "" && len(req.Images) > 0 {
		message = "请查看图片。"
	}
	if strings.TrimSpace(message) == "" {
		return nil, RuleError("消息不能为空", nil)
	}
	sessionID := req.SessionID
	if sessionID == "" {
		created, err := agent.NewSession(truncateRunes(message, 24), req.ReasoningEffort, req.Model)
		if err != nil {
			return nil, err
		}
		sessionID = stringOf(created["id"])
	}
	now := time.Now()
	runID := fmt.Sprintf("run-%s-%03d", now.Format("20060102-150405"), now.UnixMilli()%1000)
	run := newAgentRun(runID, sessionID)
	m.mu.Lock()
	m.pruneLocked()
	m.runs[runID] = run
	m.mu.Unlock()

	request := req
	request.Message = message
	request.SessionID = sessionID
	request.Autonomous = true
	request.Emit = run.Emit
	request.Cancel = run.Cancelled
	go func() {
		result, err := agent.Chat(context.Background(), request)
		if err != nil {
			run.finish("error", truncateRunes(err.Error(), 1000), "", 0)
			run.Emit(map[string]any{"kind": "error", "error": truncateRunes(err.Error(), 1000)})
			return
		}
		reply := stringOf(result["reply"])
		steps := 0
		if value, ok := result["steps"].(int); ok {
			steps = value
		}
		switch {
		case boolValue(result["cancelled"]):
			run.finish("cancelled", "已停止生成", reply, steps)
		case boolValue(result["success"]):
			run.finish("done", "", reply, steps)
		default:
			run.finish("error", firstNonEmpty(stringOf(result["error"]), "执行失败"), reply, steps)
		}
	}()
	return map[string]any{
		"success":   true,
		"runId":     runID,
		"sessionId": sessionID,
		"run":       run.snapshot(0),
	}, nil
}

// GetRun 取 run 快照（不存在返回 nil）。
func (m *AgentRunManager) GetRun(runID string, cursor int64) map[string]any {
	m.mu.Lock()
	run := m.runs[runID]
	m.mu.Unlock()
	if run == nil {
		return nil
	}
	return run.snapshot(cursor)
}

// CancelRun 请求取消并返回当前快照。
func (m *AgentRunManager) CancelRun(runID string) map[string]any {
	m.mu.Lock()
	run := m.runs[runID]
	m.mu.Unlock()
	if run == nil {
		return nil
	}
	run.RequestCancel()
	return run.snapshot(0)
}

// ActiveCount 返回仍在执行的 run 数。
func (m *AgentRunManager) ActiveCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, run := range m.runs {
		if run.snapshotLockedStatus() == "running" {
			count++
		}
	}
	return count
}

func (r *AgentRun) snapshotLockedStatus() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status
}

// pruneLocked 清理过期 run：完成超过 2 小时的先删，超量的按创建时间删。
// 调用方必须已持有 m.mu。
func (m *AgentRunManager) pruneLocked() {
	now := time.Now()
	stale := make([]string, 0, 4)
	for id, run := range m.runs {
		if run.isFinished() && now.Sub(run.lastUpdated()) > 2*time.Hour {
			stale = append(stale, id)
		}
	}
	for _, id := range stale {
		delete(m.runs, id)
	}
	if len(m.runs) <= maxRuns {
		return
	}
	ids := make([]string, 0, len(m.runs))
	for id := range m.runs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		return m.runs[ids[i]].createdAt.Before(m.runs[ids[j]].createdAt)
	})
	for _, id := range ids[:len(m.runs)-maxRuns] {
		delete(m.runs, id)
	}
}

func (r *AgentRun) isFinished() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.status != "running"
}

func (r *AgentRun) lastUpdated() time.Time {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.updatedAt
}
