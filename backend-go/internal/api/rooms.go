package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/realtime"
	"zviewer/backend/internal/store"
)

// registerRoomRoutes 注册房间与房间内弹幕数据相关端点。
//
// 对应 routes/rooms.ts。房间的「创建/进房/准入审批」全在 socket.io 侧，
// 这里只有 REST 能覆盖的部分：列表、改名、弹幕轨道、弹幕辅助数据。
func (s *Server) registerRoomRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/rooms", s.Auth.Require(s.handleListRooms))
	mux.HandleFunc("PUT /api/rooms/{roomId}/name", s.Auth.Require(s.handleRenameRoom))

	mux.HandleFunc("GET /api/rooms/{roomId}/danmaku-tracks", s.Auth.Require(s.handleListTracks))
	mux.HandleFunc("POST /api/rooms/{roomId}/danmaku-tracks", s.Auth.Require(s.handleUpsertTrack))
	mux.HandleFunc("POST /api/rooms/{roomId}/danmaku-tracks/bulk", s.Auth.Require(s.handleBulkTracks))
	mux.HandleFunc("PUT /api/rooms/{roomId}/danmaku-tracks/{trackId}/offset", s.Auth.Require(s.handleUpdateTrack))
	mux.HandleFunc("DELETE /api/rooms/{roomId}/danmaku-tracks/{trackId}", s.Auth.Require(s.handleDeleteTrack))

	mux.HandleFunc("GET /api/rooms/{roomId}/danmaku-meta", s.Auth.Require(s.handleGetDanmakuMeta))
	mux.HandleFunc("PUT /api/rooms/{roomId}/danmaku-meta", s.Auth.Require(s.handlePutDanmakuMeta))
}

// ==================== DTO ====================

type roomDTO struct {
	ID              int64   `json:"id"`
	RoomID          string  `json:"roomId"`
	Name            *string `json:"name"`
	Status          string  `json:"status"`
	RequireApproval bool    `json:"requireApproval"`
	MaxViewers      int64   `json:"maxViewers"`
	HasPassword     bool    `json:"hasPassword"`
	ViewerCount     int64   `json:"viewerCount"`
	SharerOnline    bool    `json:"sharerOnline"`
	Mode            string  `json:"mode"`
	LastAccessedAt  string  `json:"lastAccessedAt"`
	CreatedAt       string  `json:"createdAt"`
}

type trackDTO struct {
	TrackID string          `json:"trackId"`
	Label   string          `json:"label"`
	Source  string          `json:"source"`
	Items   json.RawMessage `json:"items"`
	Offset  float64         `json:"offset"`
	Hidden  bool            `json:"hidden"`
}

type metaDTO struct {
	BlockKeywords json.RawMessage `json:"blockKeywords"`
	DeletedLog    json.RawMessage `json:"deletedLog"`
	RealtimeLog   json.RawMessage `json:"realtimeLog"`
}

// jsonArrayOrEmpty 把库里的 JSON 文本还原成数组，坏数据一律当空数组。
//
// 与 store 不同：这里的兜底是「给前端一个能遍历的值」，而不是 null。
// 前端对 items/blockKeywords 直接 forEach，给 null 会直接抛异常。
func jsonArrayOrEmpty(raw string) json.RawMessage {
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "[") && json.Valid([]byte(trimmed)) {
		return json.RawMessage(trimmed)
	}
	return json.RawMessage("[]")
}

func toTrackDTO(t *store.DanmakuTrack) trackDTO {
	return trackDTO{
		TrackID: t.TrackID,
		Label:   t.Label,
		Source:  t.Source,
		Items:   jsonArrayOrEmpty(t.Items),
		Offset:  t.Offset,
		Hidden:  t.Hidden,
	}
}

func toMetaDTO(m *store.DanmakuMeta) metaDTO {
	return metaDTO{
		BlockKeywords: jsonArrayOrEmpty(m.BlockKeywords),
		DeletedLog:    jsonArrayOrEmpty(m.DeletedLog),
		RealtimeLog:   jsonArrayOrEmpty(m.RealtimeLog),
	}
}

// ==================== 权限 ====================

// requireRoomControlMsg 校验「房间存在 + root/owner」，403 文案由调用方给。
//
// Node 每个端点都有自己的无权限文案（「…可修改房间名称」「…可添加弹幕轨道」），
// 前端直接把它们当提示弹出来，所以不能统一成一句话。
func (s *Server) requireRoomControlMsg(w http.ResponseWriter, r *http.Request, roomID, scope, forbidden string) (*store.Room, bool) {
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return nil, false
		}
		httpx.InternalError(w, scope, err)
		return nil, false
	}
	if !canControlRoom(auth.ClaimsFrom(r.Context()), room) {
		httpx.Forbidden(w, forbidden)
		return nil, false
	}
	return room, true
}

// ==================== 房间列表 / 改名 ====================

func (s *Server) handleListRooms(w http.ResponseWriter, r *http.Request) {
	rooms, err := s.Rooms.ListActive(r.Context())
	if err != nil {
		httpx.InternalError(w, "GET /rooms", err)
		return
	}
	ids := make([]string, 0, len(rooms))
	for _, room := range rooms {
		ids = append(ids, room.RoomID)
	}
	counts, err := s.Rooms.ActiveSessionCounts(r.Context(), ids)
	if err != nil {
		httpx.InternalError(w, "GET /rooms", err)
		return
	}
	out := make([]roomDTO, 0, len(rooms))
	for _, room := range rooms {
		_, sharerOnline := counts.Sharers[room.RoomID]
		if !sharerOnline && s.RoomSvc != nil {
			sharerOnline = s.RoomSvc.IsStreamPublishing(room)
		}
		out = append(out, roomDTO{
			ID:              room.ID,
			RoomID:          room.RoomID,
			Name:            room.Name,
			Status:          room.Status,
			RequireApproval: room.RequireApproval,
			MaxViewers:      room.MaxViewers,
			HasPassword:     room.HasPassword,
			ViewerCount:     counts.Viewers[room.RoomID],
			SharerOnline:    sharerOnline,
			Mode:            room.Mode,
			LastAccessedAt:  isoMillis(room.LastAccessedAt),
			CreatedAt:       isoMillis(room.CreatedAt),
		})
	}
	httpx.OK(w, map[string]any{"success": true, "rooms": out})
}

func (s *Server) handleRenameRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	var body struct {
		Name *string `json:"name"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	trimmed := ""
	if body.Name != nil {
		trimmed = strings.TrimSpace(*body.Name)
	}
	if trimmed == "" {
		httpx.BadRequest(w, "房间名称不能为空")
		return
	}

	// 先用改名语句判定存在性，避免「读取 → 判断 → 再写」之间的竞态；
	// 但 403 文案需要知道房间是否真的存在，所以还是走一次读取。
	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			httpx.NotFound(w, "房间不存在")
			return
		}
		httpx.InternalError(w, "PUT /rooms/:roomId/name", err)
		return
	}
	if !canControlRoom(auth.ClaimsFrom(r.Context()), room) {
		httpx.Forbidden(w, "无权限：仅 root 或房间创建者可修改房间名称")
		return
	}
	if err := s.Rooms.Rename(r.Context(), roomID, trimmed); err != nil {
		httpx.InternalError(w, "PUT /rooms/:roomId/name", err)
		return
	}
	s.Bus.EmitRoom(roomID, realtime.EventRoomNameUpdated, map[string]any{
		"roomId": roomID,
		"name":   trimmed,
	})
	httpx.OK(w, map[string]any{
		"success": true,
		"room":    map[string]any{"roomId": roomID, "name": trimmed},
	})
}

// ==================== 弹幕轨道 ====================

func (s *Server) handleListTracks(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !s.requireRoomRead(w, r, roomID) {
		return
	}
	tracks, err := s.Tracks.ListByRoom(r.Context(), roomID)
	if err != nil {
		httpx.InternalError(w, "GET /danmaku-tracks", err)
		return
	}
	out := make([]trackDTO, 0, len(tracks))
	for _, t := range tracks {
		out = append(out, toTrackDTO(t))
	}
	httpx.OK(w, map[string]any{"success": true, "tracks": out})
}

// trackBody 是弹幕轨道入参。
//
// Items 用 RawMessage：需要区分「没传」和「传了 null」，前者按 400 处理
// （Node 用 Array.isArray 判定），后者同样不是数组，行为一致。
type trackBody struct {
	TrackID *string         `json:"trackId"`
	Label   *string         `json:"label"`
	Source  *string         `json:"source"`
	Items   json.RawMessage `json:"items"`
	Offset  *float64        `json:"offset"`
	Hidden  *bool           `json:"hidden"`
}

// isJSONArray 判断请求体里的数组字段是否真的是数组。
func isJSONArray(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return strings.HasPrefix(trimmed, "[") && json.Valid([]byte(trimmed))
}

// toUpsert 把请求体转成落库结构；校验不通过返回 false。
func (b trackBody) toUpsert(roomID string) (store.TrackUpsert, bool) {
	if b.TrackID == nil || strings.TrimSpace(*b.TrackID) == "" ||
		b.Label == nil || strings.TrimSpace(*b.Label) == "" ||
		b.Source == nil || strings.TrimSpace(*b.Source) == "" ||
		!isJSONArray(b.Items) {
		return store.TrackUpsert{}, false
	}
	offset := 0.0
	if b.Offset != nil {
		offset = *b.Offset
	}
	return store.TrackUpsert{
		TrackID: strings.TrimSpace(*b.TrackID),
		RoomID:  roomID,
		Label:   strings.TrimSpace(*b.Label),
		Source:  strings.TrimSpace(*b.Source),
		Items:   strings.TrimSpace(string(b.Items)),
		Offset:  offset,
		Hidden:  b.Hidden != nil && *b.Hidden,
	}, true
}

func (s *Server) handleUpsertTrack(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControlMsg(w, r, roomID, "POST /danmaku-tracks",
		"无权限：仅 root 或房间创建者可添加弹幕轨道"); !ok {
		return
	}
	var body trackBody
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	in, ok := body.toUpsert(roomID)
	if !ok {
		httpx.BadRequest(w, "trackId/label/source/items 为必填项")
		return
	}
	track, err := s.Tracks.Upsert(r.Context(), in)
	if err != nil {
		httpx.InternalError(w, "POST /danmaku-tracks", err)
		return
	}
	s.broadcastTracks(r, roomID)
	httpx.JSON(w, http.StatusCreated, map[string]any{"success": true, "track": toTrackDTO(track)})
}

func (s *Server) handleUpdateTrack(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	trackID := r.PathValue("trackId")
	if _, ok := s.requireRoomControlMsg(w, r, roomID, "PUT /danmaku-tracks/:trackId/offset",
		"无权限：仅 root 或房间创建者可修改弹幕轨道"); !ok {
		return
	}
	var body struct {
		Offset *float64 `json:"offset"`
		Hidden *bool    `json:"hidden"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	track, err := s.Tracks.UpdateTrack(r.Context(), roomID, trackID, body.Offset, body.Hidden)
	if err != nil {
		if errors.Is(err, store.ErrTrackNotFound) {
			httpx.NotFound(w, "弹幕轨道不存在")
			return
		}
		httpx.InternalError(w, "PUT /danmaku-tracks/:trackId/offset", err)
		return
	}
	s.broadcastTracks(r, roomID)
	httpx.OK(w, map[string]any{"success": true, "track": toTrackDTO(track)})
}

func (s *Server) handleDeleteTrack(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	trackID := r.PathValue("trackId")
	if _, ok := s.requireRoomControlMsg(w, r, roomID, "DELETE /danmaku-tracks/:trackId",
		"无权限：仅 root 或房间创建者可删除弹幕轨道"); !ok {
		return
	}
	if err := s.Tracks.Delete(r.Context(), roomID, trackID); err != nil {
		httpx.InternalError(w, "DELETE /danmaku-tracks/:trackId", err)
		return
	}
	s.broadcastTracks(r, roomID)
	httpx.OK(w, map[string]any{"success": true})
}

func (s *Server) handleBulkTracks(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControlMsg(w, r, roomID, "POST /danmaku-tracks/bulk",
		"无权限：仅 root 或房间创建者可修改弹幕轨道"); !ok {
		return
	}
	var body struct {
		Tracks []json.RawMessage `json:"tracks"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	if body.Tracks == nil {
		httpx.BadRequest(w, "tracks 必须是数组")
		return
	}

	// 逐条解析，格式不合法的条目直接跳过（Node 用 continue）；
	// 整体替换是有意的：调用方语义是「用这份列表覆盖房间轨道」。
	list := make([]store.TrackUpsert, 0, len(body.Tracks))
	for _, rawTrack := range body.Tracks {
		var one trackBody
		if err := json.Unmarshal(rawTrack, &one); err != nil {
			continue
		}
		in, ok := one.toUpsert(roomID)
		if !ok {
			continue
		}
		list = append(list, in)
	}
	saved, err := s.Tracks.ReplaceAll(r.Context(), roomID, list)
	if err != nil {
		httpx.InternalError(w, "POST /danmaku-tracks/bulk", err)
		return
	}
	s.broadcastTracks(r, roomID)
	out := make([]trackDTO, 0, len(saved))
	for _, t := range saved {
		out = append(out, toTrackDTO(t))
	}
	httpx.OK(w, map[string]any{"success": true, "tracks": out})
}

// broadcastTracks 广播房间轨道全量快照。
//
// 事件载荷是「全量」而非增量：前端收到后直接覆盖本地状态，
// 省掉各种增量合并的边界情况（也有利于断线重连后的一次性对齐）。
func (s *Server) broadcastTracks(r *http.Request, roomID string) {
	tracks, err := s.Tracks.ListByRoom(r.Context(), roomID)
	if err != nil {
		// 广播失败不该影响已经成功的写操作
		return
	}
	out := make([]trackDTO, 0, len(tracks))
	for _, t := range tracks {
		out = append(out, toTrackDTO(t))
	}
	s.Bus.EmitRoom(roomID, realtime.EventDanmakuTracksUpdate, map[string]any{
		"roomId": roomID,
		"tracks": out,
	})
}

// ==================== 弹幕辅助数据 ====================

func (s *Server) handleGetDanmakuMeta(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if !s.requireRoomRead(w, r, roomID) {
		return
	}
	meta, err := s.Metas.GetOrCreate(r.Context(), roomID)
	if err != nil {
		httpx.InternalError(w, "GET /danmaku-meta", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "meta": toMetaDTO(meta)})
}

func (s *Server) handlePutDanmakuMeta(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if _, ok := s.requireRoomControlMsg(w, r, roomID, "PUT /danmaku-meta",
		"无权限：仅 root 或房间创建者可修改弹幕辅助数据"); !ok {
		return
	}
	var body struct {
		BlockKeywords json.RawMessage `json:"blockKeywords"`
		DeletedLog    json.RawMessage `json:"deletedLog"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	existing, err := s.Metas.GetOrCreate(r.Context(), roomID)
	if err != nil {
		httpx.InternalError(w, "PUT /danmaku-meta", err)
		return
	}

	// 未提供的字段保持原值；提供但类型不对的也保持原值（Node 用 Array.isArray 判定）。
	keywords := store.JSONArrayText([]byte(existing.BlockKeywords), "[]")
	if isJSONArray(body.BlockKeywords) {
		var raw []any
		if err := json.Unmarshal(body.BlockKeywords, &raw); err == nil {
			kept := make([]string, 0, len(raw))
			for _, item := range raw {
				if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
					kept = append(kept, s)
				}
			}
			if encoded, err := json.Marshal(kept); err == nil {
				keywords = string(encoded)
			}
		}
	}
	deleted := store.JSONArrayText([]byte(existing.DeletedLog), "[]")
	if isJSONArray(body.DeletedLog) {
		deleted = store.JSONArrayText(body.DeletedLog, deleted)
	}

	meta, err := s.Metas.ReplaceBlockAndDeleted(r.Context(), roomID, keywords, deleted)
	if err != nil {
		httpx.InternalError(w, "PUT /danmaku-meta", err)
		return
	}
	s.Bus.EmitRoom(roomID, realtime.EventDanmakuMetaUpdated, map[string]any{
		"roomId": roomID,
		"meta":   toMetaDTO(meta),
	})
	httpx.OK(w, map[string]any{"success": true, "meta": toMetaDTO(meta)})
}

// ==================== 工具 ====================

// decodeOptionalJSON 解析可选请求体：空 body 视为 {}，而不是 400。
//
// Node 的 express.json 对空 body 直接给 {}，于是「PUT 名称不带 body」
// 走的是「名称为空」的 400 文案，而不是「请求体格式无效」。两者前端
// 提示完全不同，不能混。
func decodeOptionalJSON(r *http.Request, dst any) error {
	err := httpx.DecodeJSON(r, dst)
	if errors.Is(err, io.EOF) {
		return nil
	}
	return err
}
