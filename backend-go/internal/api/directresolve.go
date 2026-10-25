package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/mountutil"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/openlist"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/webdav"
)

// directResolveCacheTTL 与 openlist /proxy 的 raw_url 缓存一致：
// AList 签名直链短期有效，缓存过久会把过期直链发给浏览器。
const directResolveCacheTTL = 5 * time.Minute

// directResolveCacheMax 是缓存条目上限（超出按最久未用淘汰）。
const directResolveCacheMax = 500

// Cache entries are shared only for the same target, effective credentials and
// HTTPS preference. Different upstream users can see different files at /a.mp4.
type directResolveCacheEntry struct {
	url       string
	expiresAt time.Time
}

// registerDirectResolveRoutes 挂载直链实时解析端点（复刻 routes/direct-resolve.ts）。
func (s *Server) registerDirectResolveRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/direct-resolve/movie", s.Auth.Require(s.handleDirectResolveMovie))
}

// directResolveTarget 是解析输入（从影片记录提取并规范化）。
type directResolveTarget struct {
	Kind      string // openlist / webdav
	ServerURL string
	Path      string
}

// directResolveError 是带业务码的解析失败（路由据此映射状态码）。
type directResolveError struct {
	Code    string
	Message string
}

func (e *directResolveError) Error() string { return e.Message }

func newDirectResolveError(code, message string) *directResolveError {
	return &directResolveError{Code: code, Message: message}
}

// handleDirectResolveMovie 按影片记录实时解析 openlist/webdav 直链。
//
// 存在的理由：movie.url 是「添加影片那一刻」的快照，AList 签名会过期、
// 源站协议可能变。前端播放时改从这里取新鲜直链，固化 URL 只作兜底。
func (s *Server) handleDirectResolveMovie(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireMovieReadAccess(w, r); !ok {
		return
	}
	movieIDRaw := r.URL.Query().Get("movieId")
	if movieIDRaw == "" {
		httpx.Fail(w, http.StatusBadRequest, "缺少 movieId 参数")
		return
	}
	movieID, err := strconv.ParseInt(movieIDRaw, 10, 64)
	if err != nil {
		httpx.Fail(w, http.StatusBadRequest, "movieId 不正确")
		return
	}
	movie, err := s.Movies.FindByID(r.Context(), movieID)
	if err != nil {
		if errors.Is(err, store.ErrMovieNotFound) {
			httpx.NotFound(w, "影片不存在")
			return
		}
		httpx.InternalError(w, "GET /api/direct-resolve/movie", err)
		return
	}

	directURL, resolveErr := s.resolveMovieDirectURL(r.Context(), movie)
	if resolveErr != nil {
		status := http.StatusBadRequest
		switch resolveErr.Code {
		case "NOT_FOUND", "MOUNT_NOT_FOUND":
			status = http.StatusNotFound
		case "AUTH_FAILED":
			status = http.StatusUnauthorized
		}
		httpx.FailWithCode(w, status, resolveErr.Message, resolveErr.Code)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "directUrl": directURL})
}

// resolveMovieDirectURL 按影片记录解析直链（带 TTL 缓存 + 单飞去重）。
func (s *Server) resolveMovieDirectURL(ctx context.Context, movie *store.Movie) (string, *directResolveError) {
	target, ok := extractDirectTarget(movie)
	if !ok {
		return "", newDirectResolveError("INVALID_MOVIE",
			"该影片不是 openlist/webdav 直链影片，或缺少挂载服务器信息")
	}
	if netutil.IsInternalServerURL(target.ServerURL) {
		return "", newDirectResolveError("INTERNAL_NETWORK_FORBIDDEN",
			"该挂载为内网地址，无法使用直链模式，请使用服务器转发")
	}
	access, accessErr := s.directResolveAccess(ctx, movie, target)
	if accessErr != nil {
		return "", accessErr
	}

	key := access.cacheKey(target)
	s.directMu.Lock()
	if entry, hit := s.directCache[key]; hit {
		if time.Now().Before(entry.expiresAt) {
			s.directMu.Unlock()
			return entry.url, nil
		}
		delete(s.directCache, key)
	}
	// 单飞：同一 key 并发解析只打一次上游（多人同时进房很常见）。
	if pending, inflight := s.directInflight[key]; inflight {
		s.directMu.Unlock()
		select {
		case <-pending.done:
			return pending.result.url, pending.result.err
		case <-ctx.Done():
			return "", newDirectResolveError("UNREACHABLE", ctx.Err().Error())
		}
	}
	call := &directResolveCall{done: make(chan struct{})}
	s.directInflight[key] = call
	s.directMu.Unlock()

	url, err := s.resolveDirectUncached(ctx, target, access)

	s.directMu.Lock()
	call.result = directResolveResult{url: url, err: err}
	delete(s.directInflight, key)
	if err == nil {
		s.pruneDirectCacheLocked()
		s.directCache[key] = directResolveCacheEntry{url: url, expiresAt: time.Now().Add(directResolveCacheTTL)}
	}
	// Closing a completion channel broadcasts to every waiter; sending one result
	// would leave the other waiters reading zero values after the channel closes.
	close(call.done)
	s.directMu.Unlock()
	return url, err
}

type directResolveCall struct {
	done   chan struct{}
	result directResolveResult
}

type directResolveResult struct {
	url string
	err *directResolveError
}

// pruneDirectCacheLocked 在缓存超限时清掉已过期条目，仍超限就整体清空。
//
// 不做严格 LRU：这里的命中率取决于「同一影片重复播放」，容量 500 已经
// 远超单机实际影片数，简单策略足够，实现成本低得多。
func (s *Server) pruneDirectCacheLocked() {
	if len(s.directCache) < directResolveCacheMax {
		return
	}
	now := time.Now()
	for k, v := range s.directCache {
		if now.After(v.expiresAt) {
			delete(s.directCache, k)
		}
	}
	if len(s.directCache) >= directResolveCacheMax {
		s.directCache = make(map[string]directResolveCacheEntry, directResolveCacheMax)
	}
}

// extractDirectTarget 从影片记录提取解析输入；非直链影片返回 false。
//
// openlist 的 serverUrl 存的是添加时的原始输入（未规范化），必须先
// normalize 再匹配挂载表——挂载表里存的是规范化后的地址。
func extractDirectTarget(movie *store.Movie) (directResolveTarget, bool) {
	if !movie.DirectLink || movie.Source == nil {
		return directResolveTarget{}, false
	}
	kind := *movie.Source
	if kind != "openlist" && kind != "webdav" {
		return directResolveTarget{}, false
	}
	if movie.ServerURL == nil || movie.Path == nil {
		return directResolveTarget{}, false
	}
	serverURL := strings.TrimSpace(*movie.ServerURL)
	path := strings.TrimSpace(*movie.Path)
	if serverURL == "" || path == "" {
		return directResolveTarget{}, false
	}
	if kind == "openlist" {
		serverURL = openlist.NormalizeServerURL(serverURL)
	}
	return directResolveTarget{Kind: kind, ServerURL: serverURL, Path: path}, true
}

type directResolveAccess struct {
	mount              *store.Mount
	username, password string
}

func (a directResolveAccess) cacheKey(target directResolveTarget) string {
	var httpsDirect *bool
	if a.mount != nil {
		httpsDirect = a.mount.HttpsDirect
	}
	// JSON provides unambiguous field boundaries; credentials never appear in the
	// key in plaintext. Resolve them before lookup so edits cannot reuse old URLs.
	raw, _ := json.Marshal([]any{target.Kind, target.ServerURL, target.Path, a.username, a.password, httpsDirect})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

// Match the /stream credential priority: anchored mount, room owner's legacy
// mount, then movie-local credentials overriding the mount defaults. Never pick
// an arbitrary user's mount just because it has the same server URL.
func (s *Server) directResolveAccess(ctx context.Context, movie *store.Movie, target directResolveTarget) (directResolveAccess, *directResolveError) {
	var mount *store.Mount
	if s.Mounts != nil {
		if movie.SourceMountID != nil {
			found, err := s.Mounts.FindByID(ctx, *movie.SourceMountID, target.Kind)
			if err == nil {
				mount = found
			} else if !errors.Is(err, store.ErrMountNotFound) {
				return directResolveAccess{}, newDirectResolveError("UNREACHABLE", err.Error())
			}
		}
		if mount == nil && s.Rooms != nil {
			room, err := s.Rooms.FindByRoomID(ctx, movie.RoomID)
			if err != nil && !errors.Is(err, store.ErrRoomNotFound) {
				return directResolveAccess{}, newDirectResolveError("UNREACHABLE", err.Error())
			}
			if err == nil && room.OwnerUserID != nil && *room.OwnerUserID > 0 {
				found, err := s.Mounts.FindByRoomOwner(ctx, *room.OwnerUserID, target.ServerURL, target.Kind)
				if err == nil {
					mount = found
				} else if !errors.Is(err, store.ErrMountNotFound) {
					return directResolveAccess{}, newDirectResolveError("UNREACHABLE", err.Error())
				}
			}
		}
	}
	access := directResolveAccess{mount: mount, username: derefString(movie.Username), password: derefString(movie.Password)}
	if mount != nil {
		if access.username == "" {
			access.username = derefString(mount.Username)
		}
		if access.password == "" {
			access.password = derefString(mount.Password)
		}
	}
	return access, nil
}

// resolveDirectUncached 真正打上游（调用方已保证 target 与凭证有效）。
func (s *Server) resolveDirectUncached(ctx context.Context, target directResolveTarget, access directResolveAccess) (string, *directResolveError) {
	rawDirectURL := ""
	info, infoErr := s.OpenList.FetchFileInfo(ctx, target.ServerURL, access.username, access.password, target.Path)
	if infoErr == nil {
		rawDirectURL = info.RawURL
	} else {
		if target.Kind == "openlist" {
			// openlist 不回退拼接（与 /api/openlist/direct-url 一致）。
			return "", mapOpenListDirectError(infoErr)
		}
		// webdav：明确是 AList 服务器但路径/凭证有问题 → 直接报错不回退；
		// 其他错误（可能压根不是 AList）→ 回退 WebDAV 拼接直链。
		var oe *openlist.Error
		if errors.As(infoErr, &oe) && (oe.Code == openlist.CodeNotFound || oe.Code == openlist.CodeAuthFailed) {
			return "", mapOpenListDirectError(infoErr)
		}
		rawDirectURL = webdav.DirectURL(target.ServerURL, target.Path)
	}

	if access.mount != nil {
		return mountutil.UpgradeDirectURLValidated(ctx, s.Mounts, access.mount, rawDirectURL), nil
	}
	// 无挂载记录：无法做 httpsDirect 探测，原样返回（保持旧行为）。
	return rawDirectURL, nil
}

func mapOpenListDirectError(err error) *directResolveError {
	var oe *openlist.Error
	if errors.As(err, &oe) {
		switch oe.Code {
		case openlist.CodeAuthFailed:
			return newDirectResolveError("AUTH_FAILED", oe.Message)
		case openlist.CodeNotFound:
			return newDirectResolveError("NOT_FOUND", oe.Message)
		}
	}
	return newDirectResolveError("UNREACHABLE", err.Error())
}

func derefString(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

// directResolveState 收拢直链缓存与单飞表（嵌入 Server 使用）。
type directResolveState struct {
	directMu       sync.Mutex
	directCache    map[string]directResolveCacheEntry
	directInflight map[string]*directResolveCall
}
