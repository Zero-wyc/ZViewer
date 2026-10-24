package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/cms"
	"zviewer/backend/internal/httpx"
)

// registerCMSRoutes 挂载 CMS 采集源的 6 个端点。
//
// 对应 routes/cms.ts。/api/stream/cms/proxy 已由 registerProxyRoutes 统一挂载，
// 这里不重复注册。全部要求登录 ZViewer 账号；inspect 额外要求 admin/root。
func (s *Server) registerCMSRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/stream/cms/sources", s.Auth.Require(s.handleCMSSources))
	mux.HandleFunc("GET /api/stream/cms/search", s.Auth.Require(s.handleCMSSearch))
	mux.HandleFunc("GET /api/stream/cms/search-all", s.Auth.Require(s.handleCMSSearchAll))
	mux.HandleFunc("GET /api/stream/cms/detail", s.Auth.Require(s.handleCMSDetail))
	mux.HandleFunc("POST /api/stream/cms/resolve", s.Auth.Require(s.handleCMSResolve))
	mux.HandleFunc("GET /api/stream/cms/inspect", s.Auth.Require(s.handleCMSInspect))
}

// cmsFail 输出上游/内部错误，优先透出 err 文案。
func cmsFail(w http.ResponseWriter, scope string, err error, status int, fallback string) {
	log.Printf("[cms] %s error: %v", scope, err)
	message := fallback
	if err != nil && err.Error() != "" {
		message = err.Error()
	}
	httpx.Fail(w, status, message)
}

// handleCMSSources 列出可用采集站点。
func (s *Server) handleCMSSources(w http.ResponseWriter, r *http.Request) {
	sources, err := s.CMS.Sources(r.Context())
	if err != nil {
		cmsFail(w, "list sources", err, http.StatusInternalServerError, "获取数据源列表失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "sources": sources})
}

// handleCMSSearch 站点内搜索。
func (s *Server) handleCMSSearch(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	source := strings.TrimSpace(query.Get("source"))
	keyword := strings.TrimSpace(query.Get("keyword"))
	if source == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return
	}
	if keyword == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 keyword 参数")
		return
	}

	provider, err := s.CMS.Provider(r.Context(), source)
	if err != nil {
		cmsFail(w, "search", err, http.StatusBadGateway, "搜索失败")
		return
	}
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的数据源")
		return
	}

	results, err := provider.Search(r.Context(), keyword)
	if err != nil {
		cmsFail(w, "search", err, http.StatusBadGateway, "搜索失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "results": results})
}

// handleCMSSearchAll 聚合搜索（全部站点并发 + 标题去重）。
func (s *Server) handleCMSSearchAll(w http.ResponseWriter, r *http.Request) {
	keyword := strings.TrimSpace(r.URL.Query().Get("keyword"))
	if keyword == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 keyword 参数")
		return
	}
	results, err := s.CMS.SearchAllCoalesced(r.Context(), keyword)
	if err != nil {
		cmsFail(w, "search-all", err, http.StatusBadGateway, "聚合搜索失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "results": results})
}

// handleCMSDetail 影片详情与剧集。
func (s *Server) handleCMSDetail(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	source := strings.TrimSpace(query.Get("source"))
	vodID := strings.TrimSpace(query.Get("vodId"))
	if source == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return
	}
	if vodID == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 vodId 参数")
		return
	}

	provider, err := s.CMS.Provider(r.Context(), source)
	if err != nil {
		cmsFail(w, "detail", err, http.StatusBadGateway, "获取影片详情失败")
		return
	}
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的数据源")
		return
	}

	detail, err := provider.Detail(r.Context(), vodID)
	if err != nil {
		cmsFail(w, "detail", err, http.StatusBadGateway, "获取影片详情失败")
		return
	}
	httpx.OK(w, map[string]any{"success": true, "detail": detail})
}

// handleCMSResolve 解析播放地址（6 分钟缓存 + 单飞）。
func (s *Server) handleCMSResolve(w http.ResponseWriter, r *http.Request) {
	// params 用 RawMessage：要区分「没给 params」与「params 不是对象」。
	var body struct {
		Source any             `json:"source"`
		Params json.RawMessage `json:"params"`
	}
	_ = httpx.DecodeJSON(r, &body)

	source := ""
	if raw, ok := body.Source.(string); ok {
		source = strings.TrimSpace(raw)
	}
	if source == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 source 参数")
		return
	}

	params := map[string]any{}
	if len(body.Params) == 0 || string(body.Params) == "null" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 params 参数")
		return
	}
	trimmed := strings.TrimSpace(string(body.Params))
	if trimmed == "" || (trimmed[0] != '{' && trimmed[0] != '[') {
		httpx.Fail(w, http.StatusBadRequest, "缺少 params 参数")
		return
	}
	// 数组也能通过 Node 的 typeof 检查（数组是 object），只是取不到 vodId。
	if trimmed[0] == '{' {
		if err := json.Unmarshal(body.Params, &params); err != nil {
			httpx.Fail(w, http.StatusBadRequest, "缺少 params 参数")
			return
		}
	}

	provider, err := s.CMS.Provider(r.Context(), source)
	if err != nil {
		cmsFail(w, "resolve", err, http.StatusBadGateway, "解析播放地址失败")
		return
	}
	if provider == nil {
		httpx.Fail(w, http.StatusBadRequest, "未知的数据源")
		return
	}

	normalized := cms.NormalizePlaybackParams(params)
	if normalized.VodID == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 vodId 参数")
		return
	}

	result, err := s.CMS.Resolve(r.Context(), provider, normalized)
	if err != nil {
		cmsFail(w, "resolve", err, http.StatusBadGateway, "解析播放地址失败")
		return
	}
	payload := map[string]any{"success": true, "url": result.URL, "format": result.Format}
	if len(result.Headers) > 0 {
		payload["headers"] = result.Headers
	}
	httpx.OK(w, payload)
}

// handleCMSInspect 预览 TVBox 配置里的 CMS 站点（仅 admin/root）。
func (s *Server) handleCMSInspect(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	role := ""
	if claims != nil {
		role = claims.Role
	}
	if role != "admin" && role != "root" {
		httpx.Fail(w, http.StatusForbidden, "需要管理员权限")
		return
	}

	query := r.URL.Query()
	rawURL := strings.TrimSpace(query.Get("url"))
	if rawURL == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 url 参数")
		return
	}
	lower := strings.ToLower(rawURL)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		httpx.Fail(w, http.StatusBadRequest, "配置地址必须是 http(s) URL")
		return
	}

	sites, err := s.CMS.LoadConfigSites(r.Context(), rawURL, query.Get("refresh") == "1")
	if err != nil {
		cmsFail(w, "inspect", err, http.StatusBadGateway, "拉取配置失败")
		return
	}

	view := make([]map[string]any, 0, len(sites))
	for _, site := range sites {
		view = append(view, map[string]any{
			"key":        site.Key,
			"name":       site.Name,
			"api":        site.API,
			"searchable": site.Searchable,
		})
	}
	httpx.OK(w, map[string]any{"success": true, "sites": view})
}
