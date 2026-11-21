/**
 * 爬虫引擎代理：把网页端的搜片请求转给本机爬虫引擎。
 *
 * 引擎（crawler/engine，Python）只在桌面端本机运行，监听 127.0.0.1:3789；
 * 浏览器无法直连，所以由这里的 HTTP 层转发。部署到无引擎的服务器时接口
 * 返回 503，网页端只提示「引擎未运行」，不影响其它功能。
 */
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
)

// crawlerEngineURL 返回爬虫引擎地址，可用 CRAWLER_ENGINE_URL 覆盖。
func crawlerEngineURL() string {
	value := strings.TrimSpace(os.Getenv("CRAWLER_ENGINE_URL"))
	if value == "" {
		value = "http://127.0.0.1:3789"
	}
	return strings.TrimRight(value, "/")
}

// registerCrawlerRoutes 挂载爬虫相关路由。
//
// 解析/生成规则全部在引擎侧完成，网页端只负责发关键词与展示引擎已经解析好
// 的搜索结果；后端只做身份、房间权限与转发。成员提交站点的入口已移除。
func (s *Server) registerCrawlerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/crawler/sites", s.Auth.Require(s.handleCrawlerSites))
	mux.HandleFunc("POST /api/crawler/search", s.Auth.Require(s.handleCrawlerSearch))
	mux.HandleFunc("POST /api/crawler/play/resolve", s.Auth.Require(s.handleCrawlerResolvePlay))
	// 人机验证页：iframe 无法携带 Authorization，所以按不可猜测的会话 ID 放行。
	// 引擎只允许代访问该会话创建时的站点，Go 侧只做原样转发。
	mux.HandleFunc("/api/crawler/challenge/", s.handleCrawlerChallengeProxy)
}

// handleCrawlerChallengeProxy 原样转发验证页、静态资源、Cookie 与验证接口。
func (s *Server) handleCrawlerChallengeProxy(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/api/crawler/challenge/") {
		httpx.NotFound(w, "未知接口")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	target := crawlerEngineURL() + r.URL.RequestURI()
	var body io.Reader
	if r.Body != nil {
		body = r.Body
	}
	req, err := http.NewRequestWithContext(ctx, r.Method, target, body)
	if err != nil {
		httpx.InternalError(w, "GET /api/crawler/challenge", err)
		return
	}
	for _, name := range []string{"Content-Type", "Accept", "Accept-Language", "Cookie", "X-Requested-With", "User-Agent", "Range"} {
		if value := r.Header.Get(name); value != "" {
			req.Header.Set(name, value)
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("[crawler] 验证页转发失败: %v", err)
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未运行或验证页加载超时")
		return
	}
	defer resp.Body.Close()
	for _, name := range []string{"Content-Type", "Cache-Control", "Location", "Content-Disposition", "Set-Cookie"} {
		for _, value := range resp.Header.Values(name) {
			w.Header().Add(name, value)
		}
	}
	w.Header().Set("X-Frame-Options", "ALLOWALL")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, io.LimitReader(resp.Body, 16<<20))
}

// crawlerRole 把网页端身份映射成引擎的可见性角色：只有 root/admin 能看
// visibility=root 的规则，其余（含游客）一律按 guest 过滤。
func crawlerRole(claims *auth.Claims) string {
	if claims != nil && (claims.Role == auth.RoleRoot || claims.Role == auth.RoleAdmin) {
		return "root"
	}
	return "guest"
}

// crawlerProxy 把请求转发给本机引擎并解析 JSON。调用方已做完鉴权。
func (s *Server) crawlerProxy(ctx context.Context, method, path string, body any, timeout time.Duration) (map[string]any, int, error) {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return nil, http.StatusInternalServerError, err
		}
		reader = bytes.NewReader(buf)
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, crawlerEngineURL()+path, reader)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, http.StatusServiceUnavailable, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, http.StatusBadGateway, err
	}
	return result, resp.StatusCode, nil
}

// handleCrawlerSites 返回当前房间可用的站点规则（已按身份过滤可见性）。
func (s *Server) handleCrawlerSites(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	roomID := strings.TrimSpace(r.URL.Query().Get("roomId"))
	if roomID == "" {
		httpx.BadRequest(w, "缺少房间号")
		return
	}
	allowed, err := s.canReadRoom(r.Context(), roomID, claims)
	if err != nil {
		httpx.InternalError(w, "GET /api/crawler/sites", err)
		return
	}
	if !allowed {
		httpx.Forbidden(w, "无权限查看该房间的站点")
		return
	}
	query := url.Values{}
	query.Set("roomId", roomID)
	query.Set("role", crawlerRole(claims))
	// 本地引擎优先：Go 版已完成规则解析、可见性过滤与结果抽取，省掉一次进程间转发。
	if service := localCrawler(); service != nil {
		sites := service.ListSites(roomID, crawlerRole(claims))
		httpx.OK(w, map[string]any{"success": true, "sites": sites, "count": len(sites)})
		return
	}
	result, status, err := s.crawlerProxy(r.Context(), http.MethodGet, "/api/crawler/sites?"+query.Encode(), nil, 15*time.Second)
	if err != nil {
		log.Printf("[crawler] 引擎不可达: %v", err)
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未运行，请在桌面控制台启动")
		return
	}
	if status >= 400 {
		msg, _ := result["error"].(string)
		if msg == "" {
			msg = "爬虫引擎拒绝了本次请求"
		}
		httpx.Fail(w, http.StatusBadGateway, msg)
		return
	}
	httpx.OK(w, result)
}

type crawlerSearchBody struct {
	Site    string `json:"site"`
	Keyword string `json:"keyword"`
	RoomID  string `json:"roomId"`
	Limit   int    `json:"limit"`
}

// handleCrawlerSearch 在指定站点执行一次搜索。规则解析、请求构造与字段抽取
// 全部在引擎里完成，后端不解析页面。
func (s *Server) handleCrawlerSearch(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	var body crawlerSearchBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	body.Site = strings.TrimSpace(body.Site)
	body.Keyword = strings.TrimSpace(body.Keyword)
	body.RoomID = strings.TrimSpace(body.RoomID)
	if body.Site == "" || body.Keyword == "" {
		httpx.BadRequest(w, "缺少站点或搜索关键词")
		return
	}
	if body.RoomID == "" {
		httpx.BadRequest(w, "缺少房间号")
		return
	}
	if len([]rune(body.Keyword)) > 100 {
		httpx.BadRequest(w, "搜索关键词过长")
		return
	}
	if body.Limit <= 0 || body.Limit > 60 {
		body.Limit = 30
	}
	allowed, err := s.canReadRoom(r.Context(), body.RoomID, claims)
	if err != nil {
		httpx.InternalError(w, "POST /api/crawler/search", err)
		return
	}
	if !allowed {
		httpx.Forbidden(w, "无权限在该房间搜索站点")
		return
	}
	payload := map[string]any{
		"site":    body.Site,
		"keyword": body.Keyword,
		"roomId":  body.RoomID,
		"role":    crawlerRole(claims),
		"limit":   body.Limit,
	}
	// 本地引擎优先：规则解析、关键词编码、验证页识别都在进程内完成。
	if service := localCrawler(); service != nil {
		result, searchErr := service.Search(body.Site, body.Keyword, body.RoomID, crawlerRole(claims), body.Limit, nil, true)
		if searchErr != nil {
			writeCrawlerError(w, searchErr)
			return
		}
		httpx.OK(w, result)
		return
	}
	result, status, err := s.crawlerProxy(r.Context(), http.MethodPost, "/api/crawler/search", payload, 90*time.Second)
	if err != nil {
		log.Printf("[crawler] 搜索失败: %v", err)
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未运行或搜索超时，请在桌面控制台检查引擎")
		return
	}
	if status >= 400 {
		if code, _ := result["code"].(string); code == "challenge_required" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(w).Encode(result)
			return
		}
		msg, _ := result["error"].(string)
		if msg == "" {
			msg = "搜索引擎拒绝了本次请求"
		}
		httpx.Fail(w, http.StatusBadGateway, msg)
		return
	}
	httpx.OK(w, result)
}

type crawlerResolvePlayBody struct {
	URL    string `json:"url"`
	RoomID string `json:"roomId"`
}

// handleCrawlerResolvePlay 把详情页/播放页解析成可播放地址。解析规则、接口
// 调用与浏览器兜底都在引擎侧完成，后端只校验房间权限并转发。
func (s *Server) handleCrawlerResolvePlay(w http.ResponseWriter, r *http.Request) {
	claims := auth.ClaimsFrom(r.Context())
	if claims == nil {
		httpx.Unauthorized(w, "未提供认证令牌")
		return
	}
	var body crawlerResolvePlayBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	body.URL = strings.TrimSpace(body.URL)
	body.RoomID = strings.TrimSpace(body.RoomID)
	if body.URL == "" {
		httpx.BadRequest(w, "缺少要解析的页面地址")
		return
	}
	parsed, err := url.Parse(body.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		httpx.BadRequest(w, "页面地址必须是 http(s) 链接")
		return
	}
	if body.RoomID == "" {
		httpx.BadRequest(w, "缺少房间号")
		return
	}
	allowed, err := s.canReadRoom(r.Context(), body.RoomID, claims)
	if err != nil {
		httpx.InternalError(w, "POST /api/crawler/play/resolve", err)
		return
	}
	if !allowed {
		httpx.Forbidden(w, "无权限在该房间解析播放地址")
		return
	}
	payload := map[string]any{
		"url":    body.URL,
		"roomId": body.RoomID,
		"role":   crawlerRole(claims),
	}
	result, status, err := s.crawlerProxy(r.Context(), http.MethodPost, "/api/crawler/play/resolve", payload, 120*time.Second)
	if err != nil {
		log.Printf("[crawler] 播放解析失败: %v", err)
		httpx.Fail(w, http.StatusServiceUnavailable, "爬虫引擎未运行或播放解析超时，请在桌面控制台检查引擎")
		return
	}
	if status >= 400 {
		msg, _ := result["error"].(string)
		if msg == "" {
			msg = "没有解析到可播放地址"
		}
		httpx.Fail(w, http.StatusBadGateway, msg)
		return
	}
	httpx.OK(w, result)
}
