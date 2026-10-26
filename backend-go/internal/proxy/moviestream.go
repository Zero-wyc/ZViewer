// Package proxy 的上游转发能力，以及影片流的凭证解析。
package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"zviewer/backend/internal/store"
)

// StreamError 是影片流解析失败的业务错误。
//
// Code 与 Node 的 StreamMovieError.code 同名（NOT_FOUND / NO_SERVER），
// 挂载源的 handlers 会按 code 分流成不同的 HTTP 文案。
type StreamError struct {
	Message string
	Code    string
	Status  int
	// FromCache 表示命中了「影片不存在」熔断缓存：调用方据此静默日志，
	// 避免观众端自动重试把日志刷爆（实测单个已删影片 3 天内被请求 3717 次）。
	FromCache bool
}

func (e *StreamError) Error() string { return e.Message }

// 熔断与缓存的时间参数，与 stream-movie.ts 一致。
const (
	notFoundTTL    = 30 * time.Second
	movieStreamTTL = 30 * time.Second
	movieStreamCap = 500
)

// ResolvedMovieStream 是 /stream 代理所需的全部上下文。
type ResolvedMovieStream struct {
	Movie *store.Movie
	Mount *store.Mount
	// 有显式挂载时使用其当前凭证；无挂载身份的旧记录保留影片凭证优先。
	Username string
	Password string
}

// StreamResolver 负责把 movieId 解析成可用的上游凭证。
//
// 两条缓存各司其职：
//   - notFound：被删影片的快速失败（30s），防止重试风暴；
//   - streams：正常解析结果（30s / 500 条），削减每个 Range 请求的 DB 查询。
//
// 变更影片或挂载后必须调 Invalidate，否则切源后最多 30 秒仍在用旧凭证。
type StreamResolver struct {
	Movies *store.Movies
	Rooms  *store.Rooms
	Mounts *store.Mounts

	mu       sync.Mutex
	streams  map[int64]streamEntry
	notFound map[int64]time.Time
}

type streamEntry struct {
	value  *ResolvedMovieStream
	expire time.Time
}

// NewStreamResolver 构造解析器。
func NewStreamResolver(movies *store.Movies, rooms *store.Rooms, mounts *store.Mounts) *StreamResolver {
	return &StreamResolver{
		Movies:   movies,
		Rooms:    rooms,
		Mounts:   mounts,
		streams:  make(map[int64]streamEntry, 64),
		notFound: make(map[int64]time.Time, 16),
	}
}

// Invalidate 清除单个影片的缓存（影片更新/删除后调用）。
func (r *StreamResolver) Invalidate(movieID int64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.streams, movieID)
	delete(r.notFound, movieID)
}

// Clear 清空全部缓存（房间影片被清空后调用）。
func (r *StreamResolver) Clear() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.streams = make(map[int64]streamEntry, 64)
	r.notFound = make(map[int64]time.Time, 16)
}

// NormalizeServerURL 允许调用方在按 serverUrl 匹配挂载前做规范化。
//
// openlist 的 movie.serverUrl 存的是用户原始输入，而挂载表里是补了 /dav
// 的规范地址；不 normalize 会因后缀差异匹配落空，表现为「影片配了密码
// 却提示未授权」。
type ResolveOptions struct {
	NormalizeServerURL func(string) string
}

// Resolve 解析影片流所需的 Movie 与凭证。
//
// 挂载解析优先级：
//  1. movie.sourceMountId（添加/更新时锚定的挂载，多挂载场景下唯一确定）；
//  2. 按 serverUrl + source + 房间房主 匹配（仅没有 sourceMountId 的旧数据兜底）。
func (r *StreamResolver) Resolve(ctx context.Context, movieID int64, source string, opts *ResolveOptions) (*ResolvedMovieStream, error) {
	now := time.Now()

	r.mu.Lock()
	if at, ok := r.notFound[movieID]; ok && now.Sub(at) < notFoundTTL {
		r.mu.Unlock()
		return nil, &StreamError{Message: "影片不存在", Code: "NOT_FOUND", Status: http.StatusNotFound, FromCache: true}
	}
	if e, ok := r.streams[movieID]; ok && now.Before(e.expire) && e.value.Movie.SourceMountID == nil {
		r.mu.Unlock()
		return e.value, nil
	}
	r.mu.Unlock()

	movie, err := r.Movies.FindByID(ctx, movieID)
	if err != nil {
		if errors.Is(err, store.ErrMovieNotFound) {
			r.mu.Lock()
			r.notFound[movieID] = now
			r.pruneLocked(now)
			r.mu.Unlock()
			return nil, &StreamError{Message: "影片不存在", Code: "NOT_FOUND", Status: http.StatusNotFound}
		}
		return nil, err
	}
	if movie.ServerURL == nil || *movie.ServerURL == "" || movie.Path == nil || *movie.Path == "" {
		return nil, &StreamError{Message: "该影片未挂载服务器信息", Code: "NO_SERVER", Status: http.StatusBadRequest}
	}

	var mount *store.Mount
	if movie.SourceMountID != nil {
		m, err := r.Mounts.FindByID(ctx, *movie.SourceMountID, source)
		if errors.Is(err, store.ErrMountNotFound) {
			return nil, &StreamError{Message: "指定挂载已删除，请重新选择挂载", Code: "MOUNT_NOT_FOUND", Status: http.StatusNotFound}
		}
		if err != nil {
			return nil, err
		}
		mount = m
	}
	if mount == nil && movie.SourceMountID == nil {
		target := *movie.ServerURL
		if opts != nil && opts.NormalizeServerURL != nil {
			target = opts.NormalizeServerURL(target)
		}
		room, roomErr := r.Rooms.FindByRoomID(ctx, movie.RoomID)
		if roomErr == nil && room.OwnerUserID != nil && *room.OwnerUserID > 0 {
			if m, err := r.Mounts.FindByRoomOwner(ctx, *room.OwnerUserID, target, source); err == nil {
				mount = m
			}
		}
	}

	username := ""
	if movie.Username != nil {
		username = *movie.Username
	}
	password := ""
	if movie.Password != nil {
		password = *movie.Password
	}
	if mount != nil {
		if (movie.SourceMountID != nil || username == "") && mount.Username != nil {
			username = *mount.Username
		}
		if (movie.SourceMountID != nil || password == "") && mount.Password != nil {
			password = *mount.Password
		}
	}

	resolved := &ResolvedMovieStream{Movie: movie, Mount: mount, Username: username, Password: password}
	r.mu.Lock()
	r.streams[movieID] = streamEntry{value: resolved, expire: now.Add(movieStreamTTL)}
	r.pruneLocked(now)
	r.mu.Unlock()
	return resolved, nil
}

// pruneLocked 清理过期条目；调用方必须持有 mu。
func (r *StreamResolver) pruneLocked(now time.Time) {
	for id, at := range r.notFound {
		if now.Sub(at) >= notFoundTTL {
			delete(r.notFound, id)
		}
	}
	for id, e := range r.streams {
		if now.After(e.expire) {
			delete(r.streams, id)
		}
	}
	// 超容量时按过期时间淘汰最旧的一批（近似 LRU）：每个条目都会在 30s 内
	// 过期，不存在长期热数据被误杀的问题。
	for len(r.streams) > movieStreamCap {
		var oldestID int64
		var oldest time.Time
		first := true
		for id, e := range r.streams {
			if first || e.expire.Before(oldest) {
				oldestID, oldest, first = id, e.expire, false
			}
		}
		delete(r.streams, oldestID)
	}
}

// MovieIDFromRequest 从 query 或路径里取 movieId。
func MovieIDFromRequest(r *http.Request) (int64, error) {
	raw := r.URL.Query().Get("movieId")
	if raw == "" {
		raw = r.PathValue("movieId")
	}
	if raw == "" {
		return 0, fmt.Errorf("movieId 参数无效")
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("movieId 参数无效")
	}
	return id, nil
}
