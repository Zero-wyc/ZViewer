/**
 * 网页内登录：站点登录不再依赖本机浏览器。
 *
 * 控制台（桌面壳 / 网页端）在页面上弹窗打开同源反代页面，用户在那里完成登录
 * 或人机验证；Cookie 由引擎的登录会话收集，随后由这里落成一条账号。
 * 三个端共用同一套接口，Linux 上没有 Edge/Chrome 也能登录。
 */
package api

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"zviewer/backend/internal/crawler"
	"zviewer/backend/internal/httpx"
)

// registerCrawlerLoginRoutes 挂载登录会话接口（admin only）。
func (s *Server) registerCrawlerLoginRoutes(mux *http.ServeMux) {
	admin := s.Auth.RequireDesktopOrAdmin
	mux.HandleFunc("POST /api/crawler/login/session", admin(s.handleCrawlerLoginCreate))
	mux.HandleFunc("GET /api/crawler/login/{id}", admin(s.handleCrawlerLoginGet))
	mux.HandleFunc("POST /api/crawler/login/{id}/save", admin(s.handleCrawlerLoginSave))
	mux.HandleFunc("DELETE /api/crawler/login/{id}", admin(s.handleCrawlerLoginDelete))
}

// handleCrawlerLoginCreate 新建登录会话，返回可以给 iframe 用的同源反代地址。
func (s *Server) handleCrawlerLoginCreate(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Challenges == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	var body struct {
		URL  string `json:"url"`
		Site string `json:"site"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	session, err := bundle.Challenges.CreateLogin(body.Site, body.URL)
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{
		"success":   true,
		"id":        session.ID,
		"site":      session.Site,
		"name":      session.Name,
		"url":       session.PageURL,
		"proxyUrl":  bundle.Challenges.ProxyBase(session),
		"expiresAt": session.ExpiresAt,
	})
}

// handleCrawlerLoginGet 返回登录会话状态（Cookie 数量，不含内容）。
func (s *Server) handleCrawlerLoginGet(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Challenges == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	session, err := bundle.Challenges.Get(r.PathValue("id"))
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	httpx.OK(w, map[string]any{
		"success":     true,
		"id":          session.ID,
		"site":        session.Site,
		"name":        session.Name,
		"url":         session.PageURL,
		"proxyUrl":    bundle.Challenges.ProxyBase(session),
		"expiresAt":   session.ExpiresAt,
		"cookieCount": bundle.Challenges.CookieCount(session),
		"completed":   session.Completed,
	})
}

// handleCrawlerLoginSave 把登录会话里捕获的 Cookie 存成一条账号。
func (s *Server) handleCrawlerLoginSave(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Challenges == nil || bundle.Accounts == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	session, err := bundle.Challenges.Get(r.PathValue("id"))
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	var body struct {
		Name string `json:"name"`
		Site string `json:"site"`
	}
	if decodeErr := httpx.DecodeJSON(r, &body); decodeErr != nil && !errors.Is(decodeErr, io.EOF) {
		httpx.BadRequest(w, "请求体不是有效 JSON")
		return
	}
	pairs := bundle.Challenges.CookiePairs(session)
	if len(pairs) == 0 {
		httpx.Fail(w, http.StatusBadRequest, "还没有捕获到登录 Cookie，请先在弹窗里完成登录")
		return
	}
	parts := make([]string, 0, len(pairs))
	for _, pair := range pairs {
		parts = append(parts, pair[0]+"="+pair[1])
	}
	site := strings.TrimSpace(body.Site)
	if site == "" {
		site = session.Site
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		name = session.Site + " 登录"
	}
	saved, err := bundle.Accounts.Save(map[string]any{
		"name":    name,
		"site":    site,
		"cookies": strings.Join(parts, "; "),
		"notes":   "通过控制台内嵌页面登录保存",
	})
	if err != nil {
		writeCrawlerError(w, err)
		return
	}
	bundle.Challenges.MarkCompleted(session.ID, true)
	httpx.OK(w, map[string]any{
		"success":     true,
		"account":     crawler.PublicAccountView(saved, true),
		"cookieCount": len(pairs),
	})
}

// handleCrawlerLoginDelete 结束登录会话。
func (s *Server) handleCrawlerLoginDelete(w http.ResponseWriter, r *http.Request) {
	bundle := localBundle()
	if bundle == nil || bundle.Challenges == nil {
		s.proxyCrawlerRequest(w, r, 15*time.Second)
		return
	}
	deleted := bundle.Challenges.Delete(r.PathValue("id"))
	httpx.OK(w, map[string]any{"success": true, "deleted": deleted})
}
