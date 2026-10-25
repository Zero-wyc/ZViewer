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

	"zviewer/backend/internal/anime"
	"zviewer/backend/internal/anisubs"
	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/bilibili"
	"zviewer/backend/internal/cms"
	"zviewer/backend/internal/config"
	"zviewer/backend/internal/ftp"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/proxy"
	"zviewer/backend/internal/ratelimit"
	"zviewer/backend/internal/realtime"
	"zviewer/backend/internal/room"
	"zviewer/backend/internal/serverfiles"
	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/subtitle"
	"zviewer/backend/internal/webdav"
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
	Tracks   *store.Tracks
	Metas    *store.Metas
	// Bus 是房间事件广播器。实时层（socket.io）未迁移前用 realtime.Noop，
	// 接入后只替换实现，handler 无需改动。
	Bus realtime.Bus
	// Stream 是影片流凭证解析器（/api/<source>/stream 共用）。
	Stream *proxy.StreamResolver
	// OpenList 是 AList 客户端（token / raw_url 三层缓存都在里面）。
	OpenList *openlist.Client
	Tokens   *auth.Manager
	Auth     *auth.Authenticator
	// Bilibili 是 B站 解析服务（迁移期由 Go 侧独立持有，不通过 Node 转手）。
	Bilibili *bilibili.Service
	// RoomSvc 是房间实时业务（生命周期 / 会话 / 运行时状态）。
	RoomSvc *room.Service
	// ServerFolders 是服务器文件管理的自定义根目录表。
	ServerFolders *store.ServerFolders
	// Files 是服务器文件的根目录注册表（含 30s TTL 缓存与路径安全解析）。
	Files *serverfiles.Registry
	// Subtitles 是字幕取数服务（搜索 / 浏览 / 加载 / Emby 内嵌轨道）。
	Subtitles *subtitle.Service
	// CMS 是 CMS 采集源注册表（TVBox 配置 → 苹果 CMS 站点）。
	CMS *cms.Service
	// Anime 是动漫源注册表（B站番剧 + RSS + 第三方 HTTP 源）。
	Anime *anime.Service
	// AniSubs 是 ani-subs 订阅源注册表（web-selector 抓站 + RSS）。
	AniSubs *anisubs.Service
	// Socket 是 Socket.IO 服务端；为 nil 时不挂载实时层（REST 仍可用）。
	Socket *sio.Server
}

// Server 持有路由所需的全部依赖。
type Server struct {
	Deps

	// passwordLimiter 是改密端点限流器（每用户 1 分钟 3 次）。
	// 放进程内存即可：单机部署，重启后计数清零只会放宽限制。
	passwordLimiter *ratelimit.Limiter

	// WebDAV 的两级缓存：属性 30s（seek 时不重复 PROPFIND）、目录 60s。
	webdavStats *webdav.StatCache
	webdavDirs  *webdav.DirCache

	// FTP 的两级缓存：stat 30s（seek 时不重复登录+SIZE）、目录 60s。
	ftpStats *ftp.StatCache
	ftpDirs  *ftp.DirCache
	// ftpTickets 是临时 FTP 连接的播放票据（凭证不进播放 URL）。
	ftpTickets *ftpTickets

	// 直链实时解析：5 分钟 TTL 缓存 + 单飞去重。
	directResolveState
}

// New 构造 Server。
func New(deps Deps) *Server {
	if deps.Bus == nil {
		// 没有实时层时退化为丢弃事件，不能让 handler 撞上 nil 接口。
		deps.Bus = realtime.Noop{}
	}
	s := &Server{
		Deps: deps,
		// 与 middleware/rate-limit.ts#passwordLimiter 参数一致
		passwordLimiter: ratelimit.New(3, time.Minute),
		webdavStats:     webdav.NewStatCache(),
		webdavDirs:      webdav.NewDirCache(),
		ftpStats:        ftp.NewStatCache(),
		ftpDirs:         ftp.NewDirCache(),
		ftpTickets:      newFTPTickets(),
		directResolveState: directResolveState{
			directCache:    make(map[string]directResolveCacheEntry, 16),
			directInflight: make(map[string]chan directResolveResult, 4),
		},
	}
	// 房间层需要「按房间读影片 DTO」，DTO 定义在 api 包里，只能反向注入。
	if deps.RoomSvc != nil {
		deps.RoomSvc.SetMovieLister(s.movieList)
	}
	return s
}

// Handler 返回完整可用的 http.Handler。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	s.registerAuthRoutes(mux)
	s.registerProfileRoutes(mux)
	s.registerProxyRoutes(mux)
	s.registerMovieRoutes(mux)
	s.registerRoomRoutes(mux)
	s.registerWebDAVRoutes(mux)
	s.registerFTPRoutes(mux)
	s.registerEmbyRoutes(mux)
	s.registerMountStreamRoutes(mux)
	s.registerStreamRoutes(mux)
	s.registerBilibiliExtraRoutes(mux)
	s.registerBilibiliAccountRoutes(mux)
	s.registerBilibiliBrowseRoutes(mux)
	s.registerServerFilesRoutes(mux)
	s.registerDirectResolveRoutes(mux)
	s.registerStatsRoutes(mux)
	s.registerClientLogRoutes(mux)
	s.registerCLIRoutes(mux)
	s.registerAdminRoutes(mux)
	s.registerSubtitleRoutes(mux)
	s.registerCMSRoutes(mux)
	s.registerAnimeRoutes(mux)
	s.registerAniSubsRoutes(mux)
	s.registerSocketRoutes(mux)
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
