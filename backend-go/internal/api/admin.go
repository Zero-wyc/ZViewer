package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/store"
)

// registerAdminRoutes 挂载管理端端点（对应 routes/admin.ts，12 个）。
//
// 鉴权分两档，文案是 Node 的原文，逐字不同：
//   - 整个路由组先过 RequireAdmin → 403「无权限：仅管理员可操作」；
//   - 组内以 root 为限的端点再套 RequireRootExact → 403「无权限：仅 root 可操作」。
//
// 不要为了"统一"把它们并成 RequireRoot（那是 serverFiles 用的
// 「无权限：仅超级管理员可操作」），三套文案在前端都是直接展示的。
func (s *Server) registerAdminRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/admin/users", s.Auth.RequireAdmin(s.handleAdminListUsers))
	mux.HandleFunc("PATCH /api/admin/users/{id}/role", s.Auth.RequireAdmin(s.Auth.RequireRootExact(s.handleAdminUpdateRole)))
	mux.HandleFunc("POST /api/admin/users/{id}/approve", s.Auth.RequireAdmin(s.Auth.RequireRootExact(s.handleAdminApproveUser)))
	mux.HandleFunc("DELETE /api/admin/users/{id}", s.Auth.RequireAdmin(s.Auth.RequireRootExact(s.handleAdminDeleteUser)))

	mux.HandleFunc("GET /api/admin/rooms", s.Auth.RequireAdmin(s.handleAdminListRooms))
	mux.HandleFunc("DELETE /api/admin/rooms/{roomId}", s.Auth.RequireAdmin(s.handleAdminDeleteRoom))
	mux.HandleFunc("POST /api/admin/rooms/{roomId}/reopen", s.Auth.RequireAdmin(s.handleAdminReopenRoom))
	mux.HandleFunc("POST /api/admin/rooms/batch-delete", s.Auth.RequireAdmin(s.Auth.RequireRootExact(s.handleAdminBatchDeleteRooms)))

	// delete-all / cleanup-unused 在 Node 里只挂 rootOnly（没有组内 admin 档），
	// 但它们仍在 `router.use(authenticateToken, adminOnly)` 之下，
	// 所以非管理员先撞 adminOnly 的 403。RequireAdmin 在外层正好复刻这个顺序。
	mux.HandleFunc("POST /api/admin/rooms/delete-all", s.Auth.RequireAdmin(s.Auth.RequireRootExact(s.handleAdminDeleteAllRooms)))
	mux.HandleFunc("POST /api/admin/rooms/cleanup-unused", s.Auth.RequireAdmin(s.handleAdminCleanupUnused))

	mux.HandleFunc("GET /api/admin/settings", s.Auth.RequireAdmin(s.handleAdminGetSettings))
	mux.HandleFunc("PUT /api/admin/settings", s.Auth.RequireAdmin(s.handleAdminUpdateSettings))
}

// ---------------------------------------------------------------------------
// 用户管理
// ---------------------------------------------------------------------------

// adminUserDTO 刻意不是 store.User：passwordHash / tokenInvalidBefore
// 绝不能出现在管理端响应里（Node 用 `select` 只取 7 列）。
type adminUserDTO struct {
	ID        int64   `json:"id"`
	Username  string  `json:"username"`
	Role      string  `json:"role"`
	Status    string  `json:"status"`
	Avatar    *string `json:"avatar"`
	CreatedAt string  `json:"createdAt"`
	UpdatedAt string  `json:"updatedAt"`
}

func (s *Server) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	users, err := s.Users.ListAll(r.Context())
	if err != nil {
		httpx.InternalError(w, "admin-users", err)
		return
	}
	out := make([]adminUserDTO, 0, len(users))
	for _, u := range users {
		out = append(out, adminUserDTO{
			ID:        u.ID,
			Username:  u.Username,
			Role:      u.Role,
			Status:    u.Status,
			Avatar:    u.Avatar,
			CreatedAt: isoMillis(u.CreatedAt),
			UpdatedAt: isoMillis(u.UpdatedAt),
		})
	}
	httpx.OK(w, map[string]any{"success": true, "users": out})
}

// adminIDStatus 是 adminParseUserID 的三种结果。
type adminIDStatus int

const (
	// adminIDNaN 表示 JS 的 `Number.isNaN(Number(raw))` 为真 → 400。
	adminIDNaN adminIDStatus = iota
	// adminIDNoMatch 表示能解析成数、但不可能命中整数主键（如 1.5，
	// 或空串解析出的 0）。Node 会拿它去查库然后得 404，这里同样交给 404。
	adminIDNoMatch
	// adminIDOK 表示是可用的整数主键。
	adminIDOK
)

// adminParseUserID 复刻 `Number(req.params.id)` + `Number.isNaN` 的判定。
//
// 三者必须区分开，否则 400「用户 ID 不正确」与 404「用户不存在」会互相串线：
// JS 里 "abc" 是 NaN（400），而 "1.5" 是合法数字、查库查不到（404）。
func adminParseUserID(raw string) (int64, adminIDStatus) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		// Number('') === 0，随后查 id=0 必然不存在。
		return 0, adminIDNoMatch
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, adminIDNaN
	}
	if value != float64(int64(value)) {
		return 0, adminIDNoMatch
	}
	return int64(value), adminIDOK
}

// writeAdminIDError 按解析结果写 400 或返回 false（表示可以继续往下查库）。
func writeAdminIDError(w http.ResponseWriter, status adminIDStatus) bool {
	if status == adminIDNaN {
		httpx.BadRequest(w, "用户 ID 不正确")
		return true
	}
	return false
}

func (s *Server) handleAdminUpdateRole(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Role string `json:"role"`
	}
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.BadRequest(w, "请求参数格式不正确")
		return
	}

	id, status := adminParseUserID(r.PathValue("id"))
	if writeAdminIDError(w, status) {
		return
	}
	if req.Role != "admin" && req.Role != "user" {
		httpx.BadRequest(w, "角色必须是 admin / user")
		return
	}

	ctx := r.Context()
	user, err := s.Users.FindByID(ctx, id)
	if err == store.ErrUserNotFound {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "admin-role", err)
		return
	}
	// root 身份只能属于用户名 root，且不能被修改。
	if user.Role == "root" || user.Username == "root" {
		httpx.BadRequest(w, "不能修改 root 账户")
		return
	}

	if err := s.Users.UpdateRole(ctx, id, req.Role); err != nil {
		httpx.InternalError(w, "admin-role", err)
		return
	}
	// 改角色必须立刻吊销令牌：JWT 里带着旧 role，不吊销的话被降级的管理员
	// 在令牌过期前仍然带着 admin 权限通过每一条 RequireAdmin。
	if err := s.Users.InvalidateTokens(ctx, id); err != nil {
		logAuditError(err)
	}
	s.writeAudit(ctx, store.AuditEntry{
		ActorUserID:   claimsUserID(r),
		ActorUsername: claimsUsername(r),
		ActorRole:     claimsRole(r),
		Action:        "role_changed",
		Target:        "user:" + strconv.FormatInt(user.ID, 10) + " (" + user.Username + ")",
		IP:            clientIP(r),
		Success:       true,
		Detail:        "new role: " + req.Role,
	})

	httpx.OK(w, map[string]any{
		"success": true,
		"user": map[string]any{
			"id": user.ID, "username": user.Username, "role": req.Role,
		},
	})
}

func (s *Server) handleAdminApproveUser(w http.ResponseWriter, r *http.Request) {
	id, status := adminParseUserID(r.PathValue("id"))
	if writeAdminIDError(w, status) {
		return
	}
	ctx := r.Context()

	user, err := s.Users.FindByID(ctx, id)
	if err == store.ErrUserNotFound {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "admin-approve", err)
		return
	}
	if user.Role == "root" || user.Username == "root" {
		httpx.BadRequest(w, "不能修改 root 账户")
		return
	}

	if err := s.Users.Approve(ctx, id); err != nil {
		httpx.InternalError(w, "admin-approve", err)
		return
	}
	s.writeAudit(ctx, store.AuditEntry{
		ActorUserID:   claimsUserID(r),
		ActorUsername: claimsUsername(r),
		ActorRole:     claimsRole(r),
		Action:        "user_approved",
		Target:        "user:" + strconv.FormatInt(user.ID, 10) + " (" + user.Username + ")",
		IP:            clientIP(r),
		Success:       true,
	})

	// 响应里的 role / status 是**落库后**的值（guest 会被提升成 user）。
	updated, err := s.Users.FindByID(ctx, id)
	if err != nil {
		httpx.InternalError(w, "admin-approve", err)
		return
	}
	httpx.OK(w, map[string]any{
		"success": true,
		"user": map[string]any{
			"id": updated.ID, "username": updated.Username,
			"role": updated.Role, "status": updated.Status,
		},
	})
}

func (s *Server) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, status := adminParseUserID(r.PathValue("id"))
	if writeAdminIDError(w, status) {
		return
	}
	ctx := r.Context()

	user, err := s.Users.FindByID(ctx, id)
	if err == store.ErrUserNotFound {
		httpx.NotFound(w, "用户不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "admin-delete-user", err)
		return
	}
	if user.Role == "root" || user.Username == "root" {
		httpx.BadRequest(w, "不能删除 root 账户")
		return
	}

	if err := s.Users.Delete(ctx, id); err != nil {
		httpx.InternalError(w, "admin-delete-user", err)
		return
	}
	// 删用户后必须吊销：JWT 无状态，不主动吊销的话被删用户的 access token
	// 在过期前（最长 1h）仍能通过鉴权——认证入口会查用户存在性兜住，
	// 但吊销还会顺带立刻断开该用户已连接的 socket。
	if err := s.Users.InvalidateTokens(ctx, id); err != nil {
		logAuditError(err)
	}
	s.writeAudit(ctx, store.AuditEntry{
		ActorUserID:   claimsUserID(r),
		ActorUsername: claimsUsername(r),
		ActorRole:     claimsRole(r),
		Action:        "user_deleted",
		Target:        "user:" + strconv.FormatInt(user.ID, 10) + " (" + user.Username + ")",
		IP:            clientIP(r),
		Success:       true,
	})

	httpx.OK(w, map[string]any{"success": true})
}

// ---------------------------------------------------------------------------
// 房间管理
// ---------------------------------------------------------------------------

type adminRoomDTO struct {
	ID              int64   `json:"id"`
	RoomID          string  `json:"roomId"`
	Name            *string `json:"name"`
	Status          string  `json:"status"`
	RequireApproval bool    `json:"requireApproval"`
	MaxViewers      int64   `json:"maxViewers"`
	HasPassword     bool    `json:"hasPassword"`
	ViewerCount     int64   `json:"viewerCount"`
	SharerOnline    bool    `json:"sharerOnline"`
	OwnerUserID     *int64  `json:"ownerUserId"`
	LastAccessedAt  string  `json:"lastAccessedAt"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
}

func (s *Server) handleAdminListRooms(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rooms, err := s.Rooms.ListAll(ctx)
	if err != nil {
		httpx.InternalError(w, "admin-rooms", err)
		return
	}

	// 批量查在线人数与 sharer 状态，消除 N+1。
	ids := make([]string, 0, len(rooms))
	for _, room := range rooms {
		ids = append(ids, room.RoomID)
	}
	counts, err := s.Rooms.ActiveSessionCounts(ctx, ids)
	if err != nil {
		httpx.InternalError(w, "admin-rooms", err)
		return
	}

	out := make([]adminRoomDTO, 0, len(rooms))
	for _, room := range rooms {
		_, sharerOnline := counts.Sharers[room.RoomID]
		out = append(out, adminRoomDTO{
			ID:              room.ID,
			RoomID:          room.RoomID,
			Name:            room.Name,
			Status:          room.Status,
			RequireApproval: room.RequireApproval,
			MaxViewers:      room.MaxViewers,
			HasPassword:     room.HasPassword,
			ViewerCount:     counts.Viewers[room.RoomID],
			SharerOnline:    sharerOnline,
			OwnerUserID:     room.OwnerUserID,
			LastAccessedAt:  isoMillis(room.LastAccessedAt),
			CreatedAt:       isoMillis(room.CreatedAt),
			UpdatedAt:       isoMillis(room.UpdatedAt),
		})
	}
	httpx.OK(w, map[string]any{"success": true, "rooms": out})
}

// adminCanManageRoom 复刻「root 任意 / admin 仅自己创建」的判定。
func adminCanManageRoom(r *http.Request, room *store.Room) bool {
	claims := claimsOf(r)
	if claims == nil {
		return false
	}
	if claims.Role == "root" {
		return true
	}
	return claims.Role == "admin" &&
		room.OwnerUserID != nil && *room.OwnerUserID == claims.UserID
}

func (s *Server) handleAdminDeleteRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if roomID == "" {
		httpx.BadRequest(w, "房间号不正确")
		return
	}
	ctx := r.Context()

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err == store.ErrRoomNotFound {
		httpx.NotFound(w, "房间不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "admin-close-room", err)
		return
	}
	if !adminCanManageRoom(r, room) {
		httpx.Forbidden(w, "无权限：仅 root 或房间创建者可关闭该房间")
		return
	}

	if err := s.deleteRoom(ctx, roomID); err != nil {
		httpx.InternalError(w, "admin-close-room", err)
		return
	}
	// 这里**不写审计**：Node 的 DELETE /rooms/:roomId 就没有 writeAuditLog
	// （只有 batch-delete 写了）。补齐会让"逐个删"与"批量删"的审计记录
	// 数量对不上，用户看到的行为也就跟着不一致。
	httpx.OK(w, map[string]any{"success": true})
}

func (s *Server) handleAdminReopenRoom(w http.ResponseWriter, r *http.Request) {
	roomID := r.PathValue("roomId")
	if roomID == "" {
		httpx.BadRequest(w, "房间号不正确")
		return
	}
	ctx := r.Context()

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err == store.ErrRoomNotFound {
		httpx.NotFound(w, "房间不存在")
		return
	}
	if err != nil {
		httpx.InternalError(w, "admin-reopen-room", err)
		return
	}
	if !adminCanManageRoom(r, room) {
		httpx.Forbidden(w, "无权限：仅 root 或房间创建者可重开该房间")
		return
	}
	if room.Status != "closed" {
		httpx.BadRequest(w, "该房间未处于关闭状态")
		return
	}

	// 恢复为 active 即可：观众加入/评论/权限校验/推流入口全部按 status 判断。
	// 播放记忆在关闭时已清理，重开后从头播放（不做"恢复上次进度"）。
	if err := s.Rooms.SetStatus(ctx, roomID, "active"); err != nil {
		httpx.InternalError(w, "admin-reopen-room", err)
		return
	}
	s.invalidateRoomPermissions(roomID)
	s.writeAudit(ctx, store.AuditEntry{
		ActorUserID:   claimsUserID(r),
		ActorUsername: claimsUsername(r),
		ActorRole:     claimsRole(r),
		Action:        "room_reopened",
		Target:        "room:" + roomID,
		IP:            clientIP(r),
		Success:       true,
	})

	httpx.OK(w, map[string]any{"success": true})
}

func (s *Server) handleAdminBatchDeleteRooms(w http.ResponseWriter, r *http.Request) {
	var body map[string]json.RawMessage
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求参数格式不正确")
		return
	}
	// Node 先判 `Array.isArray(roomIds)`：非数组同样落到这条 400，
	// 不能靠结构体解码失败去报「请求参数格式不正确」。
	var roomIDs []string
	raw, present := body["roomIds"]
	if present && !isJSONNull(raw) {
		if err := json.Unmarshal(raw, &roomIDs); err != nil {
			roomIDs = nil
		}
	}
	if len(roomIDs) == 0 {
		httpx.BadRequest(w, "roomIds 必须是非空数组")
		return
	}

	ctx := r.Context()
	count := 0
	for _, roomID := range roomIDs {
		if roomID == "" {
			continue
		}
		if err := s.deleteRoom(ctx, roomID); err != nil {
			// 单个房间失败不中断整批：Node 也是 catch + console.error 继续。
			continue
		}
		count++
		s.writeAudit(ctx, store.AuditEntry{
			ActorUserID:   claimsUserID(r),
			ActorUsername: claimsUsername(r),
			ActorRole:     claimsRole(r),
			Action:        "room_deleted",
			Target:        "room:" + roomID,
			IP:            clientIP(r),
			Success:       true,
		})
	}

	httpx.OK(w, map[string]any{"success": true, "count": count})
}

func (s *Server) handleAdminDeleteAllRooms(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rooms, err := s.Rooms.ListAll(ctx)
	if err != nil {
		httpx.InternalError(w, "admin-delete-all-rooms", err)
		return
	}

	count := 0
	for _, room := range rooms {
		if err := s.deleteRoom(ctx, room.RoomID); err != nil {
			continue
		}
		count++
	}
	httpx.OK(w, map[string]any{"success": true, "count": count})
}

func (s *Server) handleAdminCleanupUnused(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rooms, err := s.Rooms.ListAll(ctx)
	if err != nil {
		httpx.InternalError(w, "admin-cleanup-unused", err)
		return
	}
	ids := make([]string, 0, len(rooms))
	for _, room := range rooms {
		ids = append(ids, room.RoomID)
	}
	counts, err := s.Rooms.ActiveSessionCounts(ctx, ids)
	if err != nil {
		httpx.InternalError(w, "admin-cleanup-unused", err)
		return
	}

	count := 0
	for _, room := range rooms {
		// admin 只能清理自己创建的房间；root 不限。
		if !adminCanManageRoom(r, room) {
			continue
		}
		// closed 的房间关闭时已踢人、必然无人使用，直接清理；
		// 不这么判会让已关闭房间无限堆积。
		if room.Status == "closed" {
			if err := s.deleteRoom(ctx, room.RoomID); err == nil {
				count++
			}
			continue
		}
		_, hasSharer := counts.Sharers[room.RoomID]
		if counts.Viewers[room.RoomID] == 0 && !hasSharer {
			if err := s.deleteRoom(ctx, room.RoomID); err == nil {
				count++
			}
		}
	}

	httpx.OK(w, map[string]any{"success": true, "count": count})
}

// deleteRoom 走房间层的物理删除（含内存清理、级联落库、room-closed 广播与踢人）。
func (s *Server) deleteRoom(ctx context.Context, roomID string) error {
	if s.RoomSvc == nil {
		return s.Rooms.DeleteCascade(ctx, roomID)
	}
	return s.RoomSvc.DeleteRoomAndRelations(ctx, roomID)
}

// invalidateRoomPermissions 让房间权限缓存立刻失效（重开后生效）。
func (s *Server) invalidateRoomPermissions(roomID string) {
	if s.RoomSvc != nil {
		s.RoomSvc.InvalidateRoomPermissions(roomID)
	}
}

// ---------------------------------------------------------------------------
// 系统设置
// ---------------------------------------------------------------------------

// adminSettingsDTO 是管理端设置响应体。
//
// 字段顺序与 routes/admin.ts 一致，方便人工比对；JSON 对拍会先排序，
// 所以顺序本身不构成契约，**键集合**才是。
type adminSettingsDTO struct {
	AutoDeleteInactiveRooms   bool            `json:"autoDeleteInactiveRooms"`
	AutoDeleteAfterHours      int             `json:"autoDeleteAfterHours"`
	RoomDefaultMusicVolume    int             `json:"roomDefaultMusicVolume"`
	DataSourceConfig          json.RawMessage `json:"dataSourceConfig"`
	RegistrationMode          string          `json:"registrationMode"`
	RoomCreationMode          string          `json:"roomCreationMode"`
	BetaFeaturesEnabled       bool            `json:"betaFeaturesEnabled"`
	DashDisabled              bool            `json:"dashDisabled"`
	BilibiliDefaultParseMode  string          `json:"bilibiliDefaultParseMode"`
	BilibiliPgcDefaultMode    string          `json:"bilibiliPgcDefaultMode"`
	CdnAccelerate             bool            `json:"cdnAccelerate"`
	CdnProxyURL               string          `json:"cdnProxyUrl"`
	PlaysvideoEnabled         bool            `json:"playsvideoEnabled"`
	RoomMultiInstanceLogin    bool            `json:"roomMultiInstanceLogin"`
	LivekitExternalURL        string          `json:"livekitExternalUrl"`
	RoomPermissionMatrix      json.RawMessage `json:"roomPermissionMatrix"`
	AnnounceAutoPopupOnUpdate bool            `json:"announceAutoPopupOnUpdate"`
	// DesktopManaged 是运行时环境标识（非数据库设置）：桌面 GUI 托管时
	// 前端要禁用网页端更新入口，否则网页更新只换 runtime/ 会和整包版本脱节。
	DesktopManaged bool `json:"desktopManaged"`
}

func adminSettingsOf(cfg *store.SystemSettings) adminSettingsDTO {
	dataSource := cfg.DataSourceConfig
	if len(dataSource) == 0 {
		dataSource = json.RawMessage("null")
	}
	matrix := cfg.RoomPermissionMatrix
	if len(matrix) == 0 {
		matrix = json.RawMessage("null")
	}
	return adminSettingsDTO{
		AutoDeleteInactiveRooms:   cfg.AutoDeleteInactiveRooms,
		AutoDeleteAfterHours:      cfg.AutoDeleteAfterHours,
		RoomDefaultMusicVolume:    cfg.RoomDefaultMusicVolume,
		DataSourceConfig:          dataSource,
		RegistrationMode:          cfg.RegistrationMode,
		RoomCreationMode:          cfg.RoomCreationMode,
		BetaFeaturesEnabled:       cfg.BetaFeaturesEnabled,
		DashDisabled:              cfg.DashDisabled,
		BilibiliDefaultParseMode:  cfg.BilibiliDefaultParseMode,
		BilibiliPgcDefaultMode:    cfg.BilibiliPgcDefaultMode,
		CdnAccelerate:             cfg.CdnAccelerate,
		CdnProxyURL:               cfg.CdnProxyURL,
		PlaysvideoEnabled:         cfg.PlaysvideoEnabled,
		RoomMultiInstanceLogin:    cfg.RoomMultiInstanceLogin,
		LivekitExternalURL:        cfg.LivekitExternalURL,
		RoomPermissionMatrix:      matrix,
		AnnounceAutoPopupOnUpdate: cfg.AnnounceAutoPopupOnUpdate,
		DesktopManaged:            isDesktopManaged(),
	}
}

func (s *Server) handleAdminGetSettings(w http.ResponseWriter, r *http.Request) {
	cfg, err := s.Settings.Get(r.Context())
	if err != nil {
		httpx.InternalError(w, "admin-get-settings", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "settings": adminSettingsOf(cfg)})
}

// 房间权限矩阵的合法动作与角色字段（与 routes/admin.ts 的两个常量表一致）。
var (
	adminMatrixActions = []string{"addMovie", "manageMovie", "musicQueue", "kickViewer", "muteViewer"}
	adminMatrixFields  = []string{"moderator", "admin", "user"}
)

func (s *Server) handleAdminUpdateSettings(w http.ResponseWriter, r *http.Request) {
	// 用 RawMessage 保留"字段缺失 vs 显式 null vs 类型不符"三者差异：
	// Node 全部靠 `!== undefined` 判定，结构体零值分不出来。
	var body map[string]json.RawMessage
	if err := httpx.DecodeJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求参数格式不正确")
		return
	}

	// ---- 校验顺序与 Node 逐条对应（先报先返回）----
	if raw, ok := body["roomDefaultMusicVolume"]; ok {
		n, ok := rawInt(raw)
		if !ok || n < 0 || n > 100 {
			httpx.BadRequest(w, "一起听默认音量必须是 0 到 100 的整数")
			return
		}
	}
	matrixRaw, hasMatrix := body["roomPermissionMatrix"]
	if hasMatrix && !isJSONNull(matrixRaw) {
		if !validPermissionMatrix(matrixRaw) {
			httpx.BadRequest(w, "roomPermissionMatrix 格式无效")
			return
		}
	}

	autoDeleteInactive, ok := rawBool(body["autoDeleteInactiveRooms"])
	if !ok {
		httpx.BadRequest(w, "autoDeleteInactiveRooms 必须是布尔值")
		return
	}
	autoDeleteHours, ok := rawInt(body["autoDeleteAfterHours"])
	if !ok || autoDeleteHours < 1 {
		httpx.BadRequest(w, "autoDeleteAfterHours 必须是大于等于 1 的整数")
		return
	}
	if raw, ok := body["dataSourceConfig"]; ok && !isJSONNull(raw) {
		if !isJSONObject(raw) {
			httpx.BadRequest(w, "dataSourceConfig 必须是对象或 null")
			return
		}
	}
	if raw, ok := body["registrationMode"]; ok {
		mode, ok := rawString(raw)
		if !ok || (mode != "open" && mode != "approval" && mode != "closed") {
			httpx.BadRequest(w, "registrationMode 必须是 open / approval / closed 之一")
			return
		}
	}
	if raw, ok := body["roomCreationMode"]; ok {
		mode, ok := rawString(raw)
		if !ok || (mode != "admin-only" && mode != "all-users") {
			httpx.BadRequest(w, "roomCreationMode 必须是 admin-only / all-users 之一")
			return
		}
	}
	if raw, ok := body["betaFeaturesEnabled"]; ok {
		if _, ok := rawBool(raw); !ok {
			httpx.BadRequest(w, "betaFeaturesEnabled 必须是布尔值")
			return
		}
	}
	if raw, ok := body["dashDisabled"]; ok {
		if _, ok := rawBool(raw); !ok {
			httpx.BadRequest(w, "dashDisabled 必须是布尔值")
			return
		}
	}
	if raw, ok := body["bilibiliDefaultParseMode"]; ok {
		mode, ok := rawString(raw)
		if !ok || (mode != "mp4" && mode != "dash") {
			httpx.BadRequest(w, "bilibiliDefaultParseMode 必须是 mp4 / dash 之一")
			return
		}
	}
	if raw, ok := body["bilibiliPgcDefaultMode"]; ok {
		mode, ok := rawString(raw)
		if !ok || (mode != "mp4" && mode != "dash" && mode != "cliOnly") {
			httpx.BadRequest(w, "bilibiliPgcDefaultMode 必须是 mp4 / dash / cliOnly 之一")
			return
		}
	}
	if raw, ok := body["cdnAccelerate"]; ok {
		if _, ok := rawBool(raw); !ok {
			httpx.BadRequest(w, "cdnAccelerate 必须是布尔值")
			return
		}
	}
	if raw, ok := body["playsvideoEnabled"]; ok {
		if _, ok := rawBool(raw); !ok {
			httpx.BadRequest(w, "playsvideoEnabled 必须是布尔值")
			return
		}
	}
	if raw, ok := body["cdnProxyUrl"]; ok {
		if _, ok := rawString(raw); !ok {
			httpx.BadRequest(w, "cdnProxyUrl 必须是字符串")
			return
		}
	}
	if raw, ok := body["livekitExternalUrl"]; ok {
		if _, ok := rawString(raw); !ok {
			httpx.BadRequest(w, "livekitExternalUrl 必须是字符串")
			return
		}
	}
	livekitURL := ""
	if raw, ok := body["livekitExternalUrl"]; ok {
		livekitURL, _ = rawString(raw)
		livekitURL = strings.TrimSpace(livekitURL)
		if livekitURL != "" && !hasWSOrWSSPrefix(livekitURL) {
			httpx.BadRequest(w, "livekitExternalUrl 必须以 ws:// 或 wss:// 开头")
			return
		}
	}

	// 到这里校验大部分已过；Node 也是在此处才 getSystemSettings()（表为空则
	// 立刻建一条默认行），随后的两条内联校验失败时该默认行已经存在。
	ctx := r.Context()
	cfg, err := s.Settings.GetOrCreate(ctx)
	if err != nil {
		httpx.InternalError(w, "admin-update-settings", err)
		return
	}

	cfg.AutoDeleteInactiveRooms = autoDeleteInactive
	cfg.AutoDeleteAfterHours = autoDeleteHours
	if raw, ok := body["roomDefaultMusicVolume"]; ok {
		cfg.RoomDefaultMusicVolume, _ = rawInt(raw)
	}
	if hasMatrix {
		// 显式 null 表示清空（写库为 NULL）。
		if isJSONNull(matrixRaw) {
			cfg.RoomPermissionMatrix = nil
		} else {
			cfg.RoomPermissionMatrix = matrixRaw
		}
	}
	if raw, ok := body["dataSourceConfig"]; ok {
		if isJSONNull(raw) {
			cfg.DataSourceConfig = nil
		} else {
			cfg.DataSourceConfig = raw
		}
	}
	if raw, ok := body["registrationMode"]; ok {
		cfg.RegistrationMode, _ = rawString(raw)
	}
	if raw, ok := body["roomCreationMode"]; ok {
		cfg.RoomCreationMode, _ = rawString(raw)
	}
	if raw, ok := body["betaFeaturesEnabled"]; ok {
		cfg.BetaFeaturesEnabled, _ = rawBool(raw)
	}
	if raw, ok := body["dashDisabled"]; ok {
		cfg.DashDisabled, _ = rawBool(raw)
	}
	if raw, ok := body["bilibiliDefaultParseMode"]; ok {
		cfg.BilibiliDefaultParseMode, _ = rawString(raw)
	}
	if raw, ok := body["bilibiliPgcDefaultMode"]; ok {
		cfg.BilibiliPgcDefaultMode, _ = rawString(raw)
	}
	if raw, ok := body["cdnAccelerate"]; ok {
		cfg.CdnAccelerate, _ = rawBool(raw)
	}
	if raw, ok := body["playsvideoEnabled"]; ok {
		cfg.PlaysvideoEnabled, _ = rawBool(raw)
	}
	if raw, ok := body["roomMultiInstanceLogin"]; ok {
		v, ok := rawBool(raw)
		if !ok {
			httpx.BadRequest(w, "roomMultiInstanceLogin 必须是布尔值")
			return
		}
		cfg.RoomMultiInstanceLogin = v
	}
	if raw, ok := body["cdnProxyUrl"]; ok {
		v, _ := rawString(raw)
		cfg.CdnProxyURL = strings.TrimSpace(v)
	}
	if raw, ok := body["livekitExternalUrl"]; ok {
		_ = raw
		cfg.LivekitExternalURL = livekitURL
	}
	if raw, ok := body["announceAutoPopupOnUpdate"]; ok {
		v, ok := rawBool(raw)
		if !ok {
			httpx.BadRequest(w, "announceAutoPopupOnUpdate 必须是布尔值")
			return
		}
		cfg.AnnounceAutoPopupOnUpdate = v
	}

	if err := s.Settings.Save(ctx, cfg); err != nil {
		httpx.InternalError(w, "admin-update-settings", err)
		return
	}
	httpx.OK(w, map[string]any{"success": true, "settings": adminSettingsOf(cfg)})
}

// ---------------------------------------------------------------------------
// JSON 取值助手
//
// 全部按 encoding/json 的解码语义工作：`null` 解到 bool/int/string 会报错，
// 与 Node 的 `typeof` 判定等价（`typeof null === 'object'`，所以 null 永远
// 不是 boolean / number / string）。
// ---------------------------------------------------------------------------

// isJSONNull 判断原始 JSON 是否是字面量 null。
func isJSONNull(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed == "null"
}

// rawBool 取布尔值；缺失或类型不符返回 (false, false)。
func rawBool(raw json.RawMessage) (bool, bool) {
	if len(raw) == 0 {
		return false, false
	}
	var v bool
	if err := json.Unmarshal(raw, &v); err != nil {
		return false, false
	}
	return v, true
}

// rawInt 取整数：`50.5` 与 `"50"` 都算类型不符（对应 Number.isInteger）。
func rawInt(raw json.RawMessage) (int, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, false
	}
	if f != float64(int(f)) {
		return 0, false
	}
	return int(f), true
}

// rawString 取字符串。
func rawString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 {
		return "", false
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		return "", false
	}
	return v, true
}

// isJSONObject 判断是否为 JSON 对象（数组与标量都不算）。
func isJSONObject(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	return json.Unmarshal(raw, &m) == nil
}

// validPermissionMatrix 复刻 Node 的矩阵校验：
// 键必须在动作白名单内，值必须是对象，对象内每个键必须在角色白名单内且为布尔值。
//
// 缺字段是合法的（只校验出现的键），所以前端可以只提交要改的那几格。
func validPermissionMatrix(raw json.RawMessage) bool {
	if !isJSONObject(raw) {
		return false
	}
	var matrix map[string]json.RawMessage
	if err := json.Unmarshal(raw, &matrix); err != nil {
		return false
	}
	for action, value := range matrix {
		if !containsString(adminMatrixActions, action) {
			return false
		}
		if isJSONNull(value) || !isJSONObject(value) {
			return false
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(value, &fields); err != nil {
			return false
		}
		for field, flag := range fields {
			if !containsString(adminMatrixFields, field) {
				return false
			}
			if _, ok := rawBool(flag); !ok {
				return false
			}
		}
	}
	return true
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

// hasWSOrWSSPrefix 等价于 Node 的 /^wss?:\/\//i。
func hasWSOrWSSPrefix(v string) bool {
	lower := strings.ToLower(v)
	return strings.HasPrefix(lower, "ws://") || strings.HasPrefix(lower, "wss://")
}

// ---------------------------------------------------------------------------
// 操作者身份（审计用）
// ---------------------------------------------------------------------------

// claimsUserID 返回操作者用户 ID；游客（userId<=0）返回 nil。
//
// 审计表的 actorUserId 是可空外键，写 0 会挂上一条指向不存在用户的记录。
func claimsUserID(r *http.Request) *int64 {
	claims := claimsOf(r)
	if claims == nil || claims.UserID <= 0 {
		return nil
	}
	id := claims.UserID
	return &id
}

func claimsUsername(r *http.Request) string {
	if claims := claimsOf(r); claims != nil {
		return claims.Username
	}
	return ""
}

func claimsRole(r *http.Request) string {
	if claims := claimsOf(r); claims != nil {
		return claims.Role
	}
	return ""
}
