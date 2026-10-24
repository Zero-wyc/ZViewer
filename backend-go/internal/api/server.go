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
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/ratelimit"
	"zviewer/backend/internal/store"
)

// Deps 是 Server 的依赖集合，全部由 main 注入，便于测试替换。
type Deps struct {
	Cfg      *config.Config
	DB       *sql.DB
	Users    *store.Users
	Settings *store.Settings
	Audit    *store.Audit
	Movies   *store.Movies
	Rooms    *store.Rooms
	Mounts   *store.Mounts
	// Stream 是影片流凭证解析器（/api/<source>/stream 共用）。
	Stream *proxy.StreamResolver
	// OpenList 是 AList 客户端（token / raw_url 三层缓存都在里面）。
	OpenList *openlist.Client
	Tokens   *auth.Manager
	Auth     *auth.Authenticator
	// Bilibili 是 B站 解析服务（迁移期由 Go 侧独立持有，不通过 Node 转手）。
	Bilibili *bilibili.Service
}

// Server 持有路由所需的全部依赖。
type Server struct {
	Deps

	// passwordLimiter 是改密端点限流器（每用户 1 分钟 3 次）。
	// 放进程内存即可：单机部署，重启后计数清零只会放宽限制。
	passwordLimiter *ratelimit.Limiter
}

// New 构造 Server。
func New(deps Deps) *Server {
	return &Server{
		Deps: deps,
		// 与 middleware/rate-limit.ts#passwordLimiter 参数一致
		passwordLimiter: ratelimit.New(3, time.Minute),
	}
}

// Handler 返回完整可用的 http.Handler。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	s.registerAuthRoutes(mux)
	s.registerProfileRoutes(mux)
	s.registerProxyRoutes(mux)
	s.registerMovieRoutes(mux)
	s.registerMountStreamRoutes(mux)
	s.registerStreamRoutes(mux)
	s.registerBilibiliExtraRoutes(mux)
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
		// status 留 0：由第一次 WriteHeader 决定；若整个请求没显式写头，
		// 日志里按隐式 200 处理。预置成 200 会让所有错误响应都记成 200，
		// 排查「接口一直返回 200 但前端报错」时会直接把人带偏。
		rec := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(rec, r)
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			return
		}
		size := "-"
		if rec.bytes > 0 {
			size = humanSize(rec.bytes)
		}
		status := rec.status
		if status == 0 {
			status = http.StatusOK
		}
		log.Printf("[req] %s %d %s %s %s", r.Method, status, size, time.Since(start).Round(time.Millisecond), r.URL.Path)
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
	if r.status == 0 {
		r.status = code
	}
	r.ResponseWriter.WriteHeader(code)
}

// Unwrap 让 http.ResponseController 能穿透到真实 ResponseWriter。
//
// 代理/SSE 的流式输出依赖 SetWriteDeadline、Flush 等能力；ResponseController
// 找不到 Unwrap 会直接报 unsupported，包一层就等于把流式能力包没了。
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

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
