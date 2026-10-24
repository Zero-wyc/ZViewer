// Package api 组装 HTTP 路由。
//
// 装配顺序刻意与 routes/register.ts 对齐：中间件 → API → 健康检查 →
// 静态资源 → SPA 回退。顺序即行为，改动前请先确认老实现。
package api

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// Deps 是 Server 的依赖集合，全部由 main 注入，便于测试替换。
type Deps struct {
	Cfg      *config.Config
	DB       *sql.DB
	Users    *store.Users
	Settings *store.Settings
	Audit    *store.Audit
	Tokens   *auth.Manager
	Auth     *auth.Authenticator
}

// Server 持有路由所需的全部依赖。
type Server struct {
	Deps
}

// New 构造 Server。
func New(deps Deps) *Server { return &Server{Deps: deps} }

// Handler 返回完整可用的 http.Handler。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	s.registerAuthRoutes(mux)
	mux.HandleFunc("GET /health", s.handleHealth)

	// 头像静态资源无需鉴权（通过 URL 公开访问）
	mux.Handle("/uploads/avatars/", s.avatarsHandler())
	// 前端产物 + SPA 回退
	mux.Handle("/", s.spaHandler())

	// 中间件：由外向内 = 恢复 → 日志 → CORS → 路由
	return s.recoverer(s.requestLogger(s.cors(mux)))
}

// ==================== 中间件 ====================

// recoverer 兜住 panic，避免单个请求打挂整个进程。
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] %s %s: %v\n%s", r.Method, r.URL.Path, rec, debug.Stack())
				httpx.InternalError(w, "panic", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// requestLogger 记录 /api/ 请求的方法、状态、体积与耗时。
// 与 Node 版一样跳过 /health 与 /uploads/，减少噪音。
func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" || strings.HasPrefix(r.URL.Path, "/uploads/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			return
		}
		size := "-"
		if rec.bytes > 0 {
			size = humanSize(rec.bytes)
		}
		log.Printf("[req] %s %d %s %s %s", r.Method, rec.status, size, time.Since(start).Round(time.Millisecond), r.URL.Path)
	})
}

// cors 按 CORS_ORIGIN 配置下发跨域头。
//
// credentials=true 时不能返回 "*"，必须反射请求的 Origin，
// 否则浏览器会拒绝携带 cookie（登录态直接失效）。
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !s.Cfg.CORS.Disabled {
			if s.Cfg.CORS.AllowAll || containsFold(s.Cfg.CORS.Origins, origin) {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges")
				w.Header().Add("Vary", "Origin")
				if r.Method == http.MethodOptions {
					w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,PUT,PATCH,POST,DELETE")
					if reqHeaders := r.Header.Get("Access-Control-Request-Headers"); reqHeaders != "" {
						w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
					}
					w.WriteHeader(http.StatusNoContent)
					return
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}

// statusRecorder 记录状态码与已写字节数，供访问日志使用。
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	n, err := r.ResponseWriter.Write(p)
	r.bytes += n
	return n, err
}

// Flush 透传，避免流式响应（代理、SSE）被包装层缓冲。
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func containsFold(list []string, target string) bool {
	for _, item := range list {
		if strings.EqualFold(item, target) {
			return true
		}
	}
	return false
}

func humanSize(bytes int) string {
	const mb = 1024 * 1024
	if bytes < mb {
		return fmt.Sprintf("%.1fKB", float64(bytes)/1024)
	}
	return fmt.Sprintf("%.2fMB", float64(bytes)/mb)
}
