/**
 * 爬虫 Agent 的 HTTP 接口：生成规则、后台 run、会话与同步对话。
 *
 * 对应 Python 引擎 api.py 里的 agent 段。全部优先走进程内 localBundle；
 * 没有可用爬虫根目录（老安装）时回退转发 127.0.0.1:3789，行为不变。
 *
 * 鉴权与 Python 的 _require_admin 一致：这些接口只给管理员。
 */
package api

import (
	"bytes"
	"context"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

// registerCrawlerAgentRoutes 挂载 agent 相关路由（admin only）。
func (s *Server) registerCrawlerAgentRoutes(mux *http.ServeMux) {
	admin := s.Auth.RequireDesktopOrAdmin
	mux.HandleFunc("POST /api/crawler/generate", admin(s.handleCrawlerGenerate))
	mux.HandleFunc("POST /api/crawler/agent/runs", admin(s.handleCrawlerRunStart))
	mux.HandleFunc("GET /api/crawler/agent/runs/{id}", admin(s.handleCrawlerRunGet))
	mux.HandleFunc("POST /api/crawler/agent/runs/{id}/cancel", admin(s.handleCrawlerRunCancel))
	mux.HandleFunc("GET /api/crawler/agent/sessions", admin(s.handleCrawlerSessionsList))
	mux.HandleFunc("POST /api/crawler/agent/sessions", admin(s.handleCrawlerSessionCreate))
	mux.HandleFunc("GET /api/crawler/agent/sessions/{id}", admin(s.handleCrawlerSessionGet))
	mux.HandleFunc("PUT /api/crawler/agent/sessions/{id}", admin(s.handleCrawlerSessionUpdate))
	mux.HandleFunc("DELETE /api/crawler/agent/sessions/{id}", admin(s.handleCrawlerSessionDelete))
	mux.HandleFunc("POST /api/crawler/agent/chat", admin(s.handleCrawlerChat))
}

// ---------------------------------------------------------------- 生成规则

func (s *Server) handleCrawlerGenerate(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		var body crawlerAgentBody
		if decodeErr := httpx.DecodeJSON(r, &body); decodeErr != nil {
			httpx.BadRequest(w, "请求体不是有效 JSON")
			return
		}
		result, genErr := agent.Generate(r.Context(), body.URL, body.Keyword, body.Notes, body.Effort())
		if genErr != nil {
			httpx.InternalError(w, "POST /api/crawler/generate", genErr)
			return
		}
		httpx.OK(w, result)
		return
	}
	s.proxyCrawlerRequest(w, r, 5*time.Minute)
}

// ---------------------------------------------------------------- 后台 run

func (s *Server) handleCrawlerRunStart(w http.ResponseWriter, r *http.Request) {
	agent, runs, err := localAgentPair()
	if err == nil && agent != nil && runs != nil {
		var body crawlerAgentBody
		if decodeErr := httpx.DecodeJSON(r, &body); decodeErr != nil {
			httpx.BadRequest(w, "请求体不是有效 JSON")
			return
		}
		result, startErr := runs.StartRun(agent, body.chatRequest())
		if startErr != nil {
			writeCrawlerError(w, startErr)
			return
		}
		httpx.OK(w, result)
		return
	}
	s.proxyCrawlerRequest(w, r, 2*time.Minute)
}

func (s *Server) handleCrawlerRunGet(w http.ResponseWriter, r *http.Request) {
	_, runs, err := localAgentPair()
	if err == nil && runs != nil {
		cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
		snapshot := runs.GetRun(r.PathValue("id"), cursor)
		if snapshot == nil {
			httpx.Fail(w, http.StatusNotFound, "任务不存在或已过期")
			return
		}
		httpx.OK(w, snapshot)
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

func (s *Server) handleCrawlerRunCancel(w http.ResponseWriter, r *http.Request) {
	_, runs, err := localAgentPair()
	if err == nil && runs != nil {
		snapshot := runs.CancelRun(r.PathValue("id"))
		if snapshot == nil {
			httpx.Fail(w, http.StatusNotFound, "任务不存在或已过期")
			return
		}
		httpx.OK(w, snapshot)
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

// ---------------------------------------------------------------- 会话

func (s *Server) handleCrawlerSessionsList(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		sessions := agent.ListSessions()
		httpx.OK(w, map[string]any{"success": true, "sessions": sessions, "count": len(sessions)})
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

func (s *Server) handleCrawlerSessionCreate(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		var body crawlerAgentBody
		_ = httpx.DecodeJSON(r, &body)
		session, sessionErr := agent.NewSession(body.Title, body.Effort(), body.Model)
		if sessionErr != nil {
			writeCrawlerError(w, sessionErr)
			return
		}
		httpx.OK(w, map[string]any{"success": true, "session": session})
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

func (s *Server) handleCrawlerSessionGet(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		session, sessionErr := agent.GetSession(r.PathValue("id"))
		if sessionErr != nil {
			writeCrawlerError(w, sessionErr)
			return
		}
		httpx.OK(w, map[string]any{"success": true, "session": session})
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

func (s *Server) handleCrawlerSessionUpdate(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		var body crawlerAgentBody
		_ = httpx.DecodeJSON(r, &body)
		session, sessionErr := agent.UpdateSession(r.PathValue("id"), body.Effort(), body.Title, body.Model)
		if sessionErr != nil {
			writeCrawlerError(w, sessionErr)
			return
		}
		httpx.OK(w, map[string]any{"success": true, "session": session})
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

func (s *Server) handleCrawlerSessionDelete(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		sessionID := r.PathValue("id")
		if !agent.DeleteSession(sessionID) {
			httpx.Fail(w, http.StatusNotFound, "会话不存在: "+sessionID)
			return
		}
		httpx.OK(w, map[string]any{"success": true, "deleted": true, "sessionId": sessionID})
		return
	}
	s.proxyCrawlerRequest(w, r, 30*time.Second)
}

// ---------------------------------------------------------------- 同步对话

func (s *Server) handleCrawlerChat(w http.ResponseWriter, r *http.Request) {
	agent, _, err := localAgentPair()
	if err == nil && agent != nil {
		var body crawlerAgentBody
		if decodeErr := httpx.DecodeJSON(r, &body); decodeErr != nil {
			httpx.BadRequest(w, "请求体不是有效 JSON")
			return
		}
		// 同步对话可能跑几分钟（自主任务多步工具调用），超时给足。
		result, chatErr := agent.Chat(r.Context(), body.chatRequest())
		if chatErr != nil {
			writeCrawlerError(w, chatErr)
			return
		}
		httpx.OK(w, result)
		return
	}
	s.proxyCrawlerRequest(w, r, 5*time.Minute)
}

// ---------------------------------------------------------------- 请求体与回退

// crawlerAgentBody 是 agent 各接口共用的请求体。
type crawlerAgentBody struct {
	Message          string         `json:"message"`
	SessionID        string         `json:"sessionId"`
	Context          map[string]any `json:"context"`
	ReasoningEffort  string         `json:"reasoningEffort"`
	ReasoningEffort2 string         `json:"reasoning_effort"`
	Model            string         `json:"model"`
	Title            string         `json:"title"`
	URL              string         `json:"url"`
	Keyword          string         `json:"keyword"`
	Notes            string         `json:"notes"`
	Images           []string       `json:"images"`
	Autonomous       bool           `json:"autonomous"`
}

// Effort 兼容两种字段名（GUI 用驼峰，Python 习惯蛇形）。
func (b *crawlerAgentBody) Effort() string {
	return strings.TrimSpace(firstString(b.ReasoningEffort, b.ReasoningEffort2))
}

// ChatRequest 转成引擎的对话请求。
func (b *crawlerAgentBody) chatRequest() crawler.ChatRequest {
	return crawler.ChatRequest{
		Message:         b.Message,
		SessionID:       b.SessionID,
		Context:         b.Context,
		ReasoningEffort: b.Effort(),
		Model:           b.Model,
		Images:          b.Images,
		Autonomous:      b.Autonomous,
	}
}

func firstString(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

// localAgentPair 是 (agent, runs, error) 的包级入口；没有本地引擎时全 nil。
func localAgentPair() (*crawler.RuleAgent, *crawler.AgentRunManager, error) {
	bundle := localBundle()
	if bundle == nil {
		return nil, nil, nil
	}
	return bundle.localAgent()
}

// proxyCrawlerRequest 把请求原样转发给 3789 上的 Python 引擎（老安装回退）。
// 响应不解析：agent 接口的 JSON 形状由引擎保证，客户端直接透传。
func (s *Server) proxyCrawlerRequest(w http.ResponseWriter, r *http.Request, timeout time.Duration) {
	target := crawlerEngineURL() + r.URL.RequestURI()
	var reader io.Reader
	if r.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
		if err != nil {
			httpx.InternalError(w, "crawler-agent", err)
			return
		}
		reader = bytes.NewReader(raw)
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, r.Method, target, reader)
	if err != nil {
		httpx.InternalError(w, "crawler-agent", err)
		return
	}
	if reader != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		log.Printf("[crawler] agent 接口转发失败: %v", err)
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未运行")
		return
	}
	defer response.Body.Close()
	for _, name := range []string{"Content-Type", "Cache-Control"} {
		if value := response.Header.Get(name); value != "" {
			w.Header().Set(name, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(response.Body, 16<<20))
}
