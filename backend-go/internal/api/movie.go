package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/netutil"
	"zviewer/backend/internal/store"
)

// registerMovieRoutes 挂载影片 REST 路由。
//
// 路径与 modules/movie/movie.routes.ts 一致。Go 的 ServeMux 对 `{movieId}`
// 与字面量 `reorder` 的优先级按「更具体者优先」判定，所以 `POST .../reorder`
// 不会被 `POST .../{movieId}` 吞掉——但 DELETE 的 `/movies` 与
// `/movies/{movieId}` 必须分别注册（Node 那边是靠声明顺序保证的）。
func (s *Server) registerMovieRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms/{roomId}/movies", s.Auth.Require(s.handleListMovies))
	mux.HandleFunc("POST /api/rooms/{roomId}/movies", s.Auth.Require(s.handleCreateMovie))
	mux.HandleFunc("POST /api/rooms/{roomId}/movies/reorder", s.Auth.Require(s.handleReorderMovies))
	mux.HandleFunc("PUT /api/rooms/{roomId}/movies/{movieId}", s.Auth.Require(s.handleUpdateMovie))
	mux.HandleFunc("DELETE /api/rooms/{roomId}/movies", s.Auth.Require(s.handleClearMovies))
	mux.HandleFunc("DELETE /api/rooms/{roomId}/movies/{movieId}", s.Auth.Require(s.handleDeleteMovie))
}

// ==================== DTO ====================

// movieDTO 是影片的对外表示，字段名与 types 逐字对齐。
//
// 两个约定必须保住：
//   - username / password **恒为 null**：凭证只在服务端流转，连 socket 广播
//     也不下发（否则任何观众都能拿到房主的 NAS 账号）。
//   - acceptQuality / pages / sourceMeta 在 DB 里是 JSON 字符串，对前端必须
//     还原成数组/对象；解析失败时给 null，不要给半个可用的结构。
type movieDTO struct {
	ID                int64           `json:"id"`
	RoomID            string          `json:"roomId"`
	URL               string          `json:"url"`
	Title             string          `json:"title"`
	Cover             *string         `json:"cover"`
	Source            *string         `json:"source"`
	AudioURL          *string         `json:"audioUrl"`
	Format            *string         `json:"format"`
	VideoCodec        *string         `json:"videoCodec"`
	AudioCodec        *string         `json:"audioCodec"`
	Duration          *float64        `json:"duration"`
	Cid               *int64          `json:"cid"`
	CurrentQn         *int64          `json:"currentQn"`
	AcceptQuality     json.RawMessage `json:"acceptQuality"`
	Pages             json.RawMessage `json:"pages"`
	CurrentPage       *int64          `json:"currentPage"`
	ServerURL         *string         `json:"serverUrl"`
	SourceMountID     *int64          `json:"sourceMountId"`
	Path              *string         `json:"path"`
	Username          *string         `json:"username"`
	Password          *string         `json:"password"`
	DirectLink        bool            `json:"directLink"`
	ServerProxy       bool            `json:"serverProxy"`
	WasmEngine        bool            `json:"wasmEngine"`
	PlaysVideoEnabled bool            `json:"playsvideoEnabled"`
	CLIOnly           bool            `json:"cliOnly"`
	MultiVersion      bool            `json:"multiVersion"`
	SourceMeta        json.RawMessage `json:"sourceMeta"`
	Order             int64           `json:"order"`
	CreatedAt         string          `json:"createdAt"`
	UpdatedAt         string          `json:"updatedAt"`
}

func toMovieDTO(m *store.Movie) movieDTO {
	return movieDTO{
		ID:                m.ID,
		RoomID:            m.RoomID,
		URL:               m.URL,
		Title:             m.Title,
		Cover:             m.Cover,
		Source:            m.Source,
		AudioURL:          m.AudioURL,
		Format:            m.Format,
		VideoCodec:        m.VideoCodec,
		AudioCodec:        m.AudioCodec,
		Duration:          m.Duration,
		Cid:               m.Cid,
		CurrentQn:         m.CurrentQn,
		AcceptQuality:     jsonArrayOrNull(m.AcceptQuality),
		Pages:             jsonArrayOrNull(m.Pages),
		CurrentPage:       m.CurrentPage,
		ServerURL:         m.ServerURL,
		SourceMountID:     m.SourceMountID,
		Path:              m.Path,
		Username:          nil,
		Password:          nil,
		DirectLink:        m.DirectLink,
		ServerProxy:       m.ServerProxy,
		WasmEngine:        m.WasmEngine,
		PlaysVideoEnabled: m.PlaysVideoEnabled,
		CLIOnly:           m.CLIOnly,
		MultiVersion:      m.MultiVersion,
		SourceMeta:        sourceMetaOrNull(m.SourceMeta),
		Order:             m.Order,
		CreatedAt:         isoMillis(m.CreatedAt),
		UpdatedAt:         isoMillis(m.UpdatedAt),
	}
}

// isoMillis 复刻 JS 的 Date#toISOString（毫秒固定三位、带 Z）。
func isoMillis(t time.Time) string {
	if t.IsZero() {
		return "0001-01-01T00:00:00.000Z"
	}
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// jsonArrayOrNull 只在值确实是 JSON 数组时透传，其余一律 null。
func jsonArrayOrNull(raw *string) json.RawMessage {
	if raw == nil {
		return jsonNull
	}
	trimmed := strings.TrimSpace(*raw)
	if !strings.HasPrefix(trimmed, "[") || !json.Valid([]byte(trimmed)) {
		return jsonNull
	}
	return json.RawMessage(trimmed)
}

// sourceMetaOrNull 要求对象且含 sourceId——缺 sourceId 的 sourceMeta 前端
// 拿去重解析会立刻失败，不如直接当没有。
func sourceMetaOrNull(raw *string) json.RawMessage {
	if raw == nil {
		return jsonNull
	}
	trimmed := strings.TrimSpace(*raw)
	if !strings.HasPrefix(trimmed, "{") || !json.Valid([]byte(trimmed)) {
		return jsonNull
	}
	var probe struct {
		SourceID *string `json:"sourceId"`
	}
	if err := json.Unmarshal([]byte(trimmed), &probe); err != nil || probe.SourceID == nil {
		return jsonNull
	}
	return json.RawMessage(trimmed)
}

var jsonNull = json.RawMessage("null")

// ==================== 权限 ====================

// canControlRoom 对应 movie.routes.ts#canControlRoom：root 或房间 owner。
func canControlRoom(claims *auth.Claims, room *store.Room) bool {
	if claims == nil {
		return false
	}
	if claims.Role == auth.RoleRoot {
		return true
	}
	return claims.UserID > 0 && room.OwnerUserID != nil && *room.OwnerUserID == claims.UserID
}

// canReadRoom 对应 services/room-access.ts#canReadRoom。
//
// 顺序有意义：先看 root/owner（房间关闭也能管），再要求房间处于 active，
// 最后才是「有没有未结束的会话」。游客必须按 guestId 匹配会话。
func (s *Server) canReadRoom(ctx context.Context, roomID string, claims *auth.Claims) (bool, error) {
	if claims == nil {
		return false, nil
	}
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			return false, nil
		}
		return false, err
	}
	if claims.Role == auth.RoleRoot {
		return true, nil
	}
	if claims.UserID > 0 && room.OwnerUserID != nil && *room.OwnerUserID == claims.UserID {
		return true, nil
	}
	if room.Status != "active" {
		return false, nil
	}
	if claims.UserID == 0 && claims.GuestID == "" {
		return false, nil
	}
	return s.Rooms.HasActiveSession(ctx, roomID, claims.UserID, claims.GuestID)
}

// requireRoomRead 返回 false 时已写好响应。
func (s *Server) requireRoomRead(w http.ResponseWriter, r *http.Request, roomID string) bool {
	ok, err := s.Rooms.Exists(r.Context(), roomID)
	if err != nil {
		httpx.InternalError(w, "GET /rooms/:roomId/movies", err)
		return false
	}
	if !ok {
		httpx.NotFound(w, "房间不存在")
		return false
	}
	allowed, err := s.canReadRoom(r.Context(), roomID, auth.ClaimsFrom(r.Context()))
	if err != nil {
		httpx.InternalError(w, "GET /rooms/:roomId/movies", err)
		return false
	}
	if !allowed {
		httpx.Forbidden(w, "请先通过房间准入验证")
		return false
	}
	return true
}

// requireRoomControl 校验「房间存在 + root/owner」，并返回房间。
func (s *Server) requireRoomControl(w http.ResponseWriter, r *http.Request, roomID, scope string) (*store.Room, bool) {
	return s.requireRoomControlMsg(w, r, roomID, scope, "无权限：仅 root 或房间创建者可操作影片")
}

// ==================== 请求体 ====================

// movieBody 是新增/更新影片的入参。
//
// 指针类型用来区分「没传」与「传了零值」；三个 JSON 列用 RawMessage，
// 因为更新时 `null` 是「清空」而「缺失」是「不动」，指针分不出这两者。
type movieBody struct {
	URL               *string         `json:"url"`
	Title             *string         `json:"title"`
	Cover             *string         `json:"cover"`
	Source            *string         `json:"source"`
	AudioURL          *string         `json:"audioUrl"`
	Format            *string         `json:"format"`
	VideoCodec        *string         `json:"videoCodec"`
	AudioCodec        *string         `json:"audioCodec"`
	Duration          *float64        `json:"duration"`
	Cid               *int64          `json:"cid"`
	CurrentQn         *int64          `json:"currentQn"`
	AcceptQuality     json.RawMessage `json:"acceptQuality"`
	Pages             json.RawMessage `json:"pages"`
	CurrentPage       *int64          `json:"currentPage"`
	ServerURL         *string         `json:"serverUrl"`
	SourceMountID     json.RawMessage `json:"sourceMountId"`
	Path              *string         `json:"path"`
	Username          *string         `json:"username"`
	Password          *string         `json:"password"`
	DirectLink        *bool           `json:"directLink"`
	ServerProxy       *bool           `json:"serverProxy"`
	WasmEngine        *bool           `json:"wasmEngine"`
	PlaysvideoEnabled *bool           `json:"playsvideoEnabled"`
	CliOnly           *bool           `json:"cliOnly"`
	MultiVersion      *bool           `json:"multiVersion"`
	SourceMeta        json.RawMessage `json:"sourceMeta"`
	Order             *int64          `json:"order"`
}

func (b movieBody) sourceType() string {
	if b.Source == nil {
		return ""
	}
	return strings.ToLower(*b.Source)
}

// ==================== 处理器 ====================

func (s *Server) handleListMovies(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !s.requireRoomRead(w, r, roomID) {
		return
	}
	movies, err := s.Movies.ListByRoom(r.Context(), roomID)
	if err != nil {
		httpx.InternalError(w, "GET /movies", err)
		return
	}
	out := make([]movieDTO, 0, len(movies))
	for _, m := range movies {
		out = append(out, toMovieDTO(m))
	}
	httpx.OK(w, map[string]any{"success": true, "movies": out})
}

func (s *Server) handleCreateMovie(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControl(w, r, roomID, "POST /movies"); !ok {
		return
	}
	var body movieBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	if body.URL == nil || strings.TrimSpace(*body.URL) == "" ||
		body.Title == nil || strings.TrimSpace(*body.Title) == "" {
		httpx.BadRequest(w, "url 和 title 为必填项")
		return
	}

	claims := auth.ClaimsFrom(r.Context())

	// WebDAV / OpenList：前端不传凭证（挂载列表 API 不返回密码），
	// 后端从 user_mount 表按 userId + serverUrl 自动补全。
	sourceType := body.sourceType()
	if (sourceType == "webdav" || sourceType == "openlist") && body.ServerURL != nil {
		if body.Username == nil || body.Password == nil {
			mount, err := s.Mounts.FindByServerURL(r.Context(), claims.UserID, *body.ServerURL, sourceType)
			if err == nil {
				if body.Username == nil && mount.Username != nil {
					body.Username = mount.Username
				}
				if body.Password == nil && mount.Password != nil {
					body.Password = mount.Password
				}
			}
		}
	}

	// 内网地址强制使用服务器转发：浏览器（尤其公网访问者）无法直连内网 NAS。
	// 覆盖全部挂载型源——emby/jellyfin 的直链 URL 同样指向挂载的 NAS。
	directLink := body.DirectLink != nil && *body.DirectLink
	if directLink && isMountSourceType(sourceType) {
		checkURL := ""
		if body.ServerURL != nil && *body.ServerURL != "" {
			checkURL = *body.ServerURL
		} else if body.URL != nil {
			checkURL = *body.URL
		}
		if checkURL != "" && netutil.IsInternalServerURL(checkURL) {
			directLink = false
		}
	}

	playsvideo := body.PlaysvideoEnabled == nil || *body.PlaysvideoEnabled

	created, err := s.Movies.Create(r.Context(), roomID, store.MovieInput{
		URL:               *body.URL,
		Title:             *body.Title,
		Cover:             body.Cover,
		Source:            body.Source,
		AudioURL:          body.AudioURL,
		Format:            body.Format,
		VideoCodec:        body.VideoCodec,
		AudioCodec:        body.AudioCodec,
		Duration:          body.Duration,
		Cid:               body.Cid,
		CurrentQn:         body.CurrentQn,
		AcceptQuality:     body.AcceptQuality,
		Pages:             body.Pages,
		CurrentPage:       body.CurrentPage,
		ServerURL:         body.ServerURL,
		Path:              body.Path,
		Username:          body.Username,
		Password:          body.Password,
		DirectLink:        directLink,
		ServerProxy:       body.ServerProxy != nil && *body.ServerProxy,
		WasmEngine:        body.WasmEngine != nil && *body.WasmEngine,
		PlaysVideoEnabled: playsvideo,
		MultiVersion:      body.MultiVersion != nil && *body.MultiVersion,
		SourceMeta:        body.SourceMeta,
	}, claims.UserID)
	if err != nil {
		httpx.InternalError(w, "POST /movies", err)
		return
	}
	s.broadcastMovieList(r.Context(), roomID)
	httpx.JSON(w, http.StatusCreated, map[string]any{"success": true, "movie": toMovieDTO(created)})
}

func (s *Server) handleUpdateMovie(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControl(w, r, roomID, "PUT /movies/:movieId"); !ok {
		return
	}
	movieID, ok := parseIDParam(w, r.PathValue("movieId"), "movieId")
	if !ok {
		return
	}
	var body movieBody
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}

	// 内网地址强制服务器转发：传了 directLink=true 时要按「更新后」的
	// serverUrl / url 判定，都没传则回落到库里的现有值。
	if body.DirectLink != nil && *body.DirectLink {
		checkURL := ""
		if body.ServerURL != nil && *body.ServerURL != "" {
			checkURL = *body.ServerURL
		} else if body.URL != nil && *body.URL != "" {
			checkURL = *body.URL
		}
		if checkURL == "" {
			existing, err := s.Movies.FindInRoom(r.Context(), roomID, movieID)
			if err == nil {
				src := ""
				if existing.Source != nil {
					src = strings.ToLower(*existing.Source)
				}
				if isMountSourceType(src) {
					if existing.ServerURL != nil && netutil.IsInternalServerURL(*existing.ServerURL) {
						checkURL = *existing.ServerURL
					} else if netutil.IsInternalServerURL(existing.URL) {
						checkURL = existing.URL
					}
				}
			}
		}
		if checkURL != "" && netutil.IsInternalServerURL(checkURL) {
			off := false
			body.DirectLink = &off
		}
	}

	patch := store.MoviePatch{
		URL:                  body.URL,
		Title:                body.Title,
		Cover:                body.Cover,
		Order:                body.Order,
		Source:               body.Source,
		AudioURL:             body.AudioURL,
		Format:               body.Format,
		VideoCodec:           body.VideoCodec,
		AudioCodec:           body.AudioCodec,
		Duration:             body.Duration,
		Cid:                  body.Cid,
		CurrentQn:            body.CurrentQn,
		AcceptQuality:        body.AcceptQuality,
		Pages:                body.Pages,
		CurrentPage:          body.CurrentPage,
		ServerURL:            body.ServerURL,
		Path:                 body.Path,
		Username:             body.Username,
		Password:             body.Password,
		DirectLink:           body.DirectLink,
		ServerProxy:          body.ServerProxy,
		WasmEngine:           body.WasmEngine,
		PlaysVideoEnabled:    body.PlaysvideoEnabled,
		CLIOnly:              body.CliOnly,
		MultiVersion:         body.MultiVersion,
		SourceMeta:           body.SourceMeta,
		SourceMountIDTouched: body.SourceMountID != nil,
	}
	updated, err := s.Movies.Update(r.Context(), roomID, movieID, patch, auth.ClaimsFrom(r.Context()).UserID)
	if err != nil {
		if errors.Is(err, store.ErrMovieNotFound) {
			httpx.NotFound(w, "影片不存在")
			return
		}
		httpx.InternalError(w, "PUT /movies/:movieId", err)
		return
	}
	// 切源/改路径/改凭证后立即失效流解析缓存：否则 30s 内 /stream 仍在用
	// 旧凭证打旧地址，用户会以为「改了没生效」。
	s.Stream.Invalidate(movieID)
	s.broadcastMovieList(r.Context(), roomID)
	httpx.OK(w, map[string]any{"success": true, "movie": toMovieDTO(updated)})
}

func (s *Server) handleDeleteMovie(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControl(w, r, roomID, "DELETE /movies/:movieId"); !ok {
		return
	}
	movieID, ok := parseIDParam(w, r.PathValue("movieId"), "movieId")
	if !ok {
		return
	}
	deleted, err := s.Movies.Delete(r.Context(), roomID, movieID)
	if err != nil {
		httpx.InternalError(w, "DELETE /movies/:movieId", err)
		return
	}
	if !deleted {
		httpx.NotFound(w, "影片不存在")
		return
	}
	s.Stream.Invalidate(movieID)
	s.broadcastMovieList(r.Context(), roomID)
	httpx.OK(w, map[string]any{"success": true})
}

func (s *Server) handleClearMovies(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControl(w, r, roomID, "DELETE /movies"); !ok {
		return
	}
	removed, err := s.Movies.ClearRoom(r.Context(), roomID)
	if err != nil {
		httpx.InternalError(w, "DELETE /movies", err)
		return
	}
	s.Stream.Clear()
	s.broadcastMovieList(r.Context(), roomID)
	httpx.OK(w, map[string]any{"success": true, "removed": removed})
}

func (s *Server) handleReorderMovies(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControl(w, r, roomID, "POST /movies/reorder"); !ok {
		return
	}
	var body struct {
		Orders     []store.MovieOrder `json:"orders"`
		OrderedIDs []int64            `json:"orderedIds"`
	}
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	// 兼容两种格式：orderedIds（前端 roomStore.reorderMovies 用的）与
	// orders（显式指定 order 值）。
	var orders []store.MovieOrder
	if body.Orders != nil {
		orders = body.Orders
	} else if body.OrderedIDs != nil {
		orders = make([]store.MovieOrder, 0, len(body.OrderedIDs))
		for i, id := range body.OrderedIDs {
			orders = append(orders, store.MovieOrder{ID: id, Order: int64(i)})
		}
	} else {
		httpx.BadRequest(w, "orders/orderedIds 必须是数组")
		return
	}
	if err := s.Movies.Reorder(r.Context(), roomID, orders); err != nil {
		httpx.InternalError(w, "POST /movies/reorder", err)
		return
	}
	s.broadcastMovieList(r.Context(), roomID)
	httpx.OK(w, map[string]any{"success": true})
}

// broadcastMovieList 在影片写操作后把最新列表推给房间。
//
// 少了这一步的表现很隐蔽：REST 返回 200、库里也改了，但观众端列表不动，
// 要刷新页面才看得到——因为前端只监听 movie-list 事件。
func (s *Server) broadcastMovieList(ctx context.Context, roomID string) {
	if s.RoomSvc == nil {
		return
	}
	if err := s.RoomSvc.BroadcastMovieList(ctx, roomID); err != nil {
		log.Printf("[movies] 广播影片列表失败 %s: %v", roomID, err)
	}
}

// isMountSourceType 与 store 里的判定保持一致（api 层只需要判断
// 「这条影片的直链是否指向挂载的 NAS」）。
func isMountSourceType(source string) bool {
	switch source {
	case "webdav", "openlist", "ftp", "emby", "jellyfin":
		return true
	default:
		return false
	}
}

// parseIDParam 解析正整数路径参数，失败时已写好 400 响应。
func parseIDParam(w http.ResponseWriter, raw, name string) (int64, bool) {
	var id int64
	if _, err := fmt.Sscan(raw, &id); err != nil || id <= 0 {
		httpx.BadRequest(w, name+" 无效")
		return 0, false
	}
	return id, true
}
