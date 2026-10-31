package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"zviewer/backend/internal/auth"
	"zviewer/backend/internal/httpx"
	"zviewer/backend/internal/livekit"
	"zviewer/backend/internal/store"
	"zviewer/backend/internal/voice"
)

// registerVoiceRoutes 挂载 /api/voice。
//
// 三个端点都要登录态：游客也能用语音，但必须带 guestId 的令牌
// （Require 已经验过），否则拿不到稳定的参与者身份。
// 组件状态与下载另开两个端点：LiveKit 二进制随产物分发，只有被删掉时才需要下载补回。
func (s *Server) registerVoiceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/voice/token", s.Auth.Require(s.handleVoiceToken))
	mux.HandleFunc("POST /api/voice/mute", s.Auth.Require(s.handleVoiceMute))
	mux.HandleFunc("POST /api/voice/kick", s.Auth.Require(s.handleVoiceKick))
	// 状态无需鉴权：游客也要能在房间里看到「下载语音组件」入口。
	mux.HandleFunc("GET /api/voice/status", s.handleVoiceStatus)
	// 下载要登录：避免匿名脚本反复触发 17 MB 下载（服务端另有单飞去重）。
	mux.HandleFunc("POST /api/voice/install", s.Auth.Require(s.handleVoiceInstall))
}

// handleVoiceStatus 报告内嵌 LiveKit 组件的可用性与下载进度。
func (s *Server) handleVoiceStatus(w http.ResponseWriter, r *http.Request) {
	if s.VoiceBin == nil {
		// 单测 / 精简装配：没有托管进程，按「外置 LiveKit」处理，前端不显示下载入口。
		httpx.OK(w, map[string]any{"success": true, "status": livekit.Status{
			Available: true,
			State:     livekit.StateExternal,
			External:  true,
			Version:   livekit.BinaryVersion,
		}})
		return
	}
	httpx.OK(w, map[string]any{"success": true, "status": s.VoiceBin.Status()})
}

// handleVoiceInstall 触发一次后台下载，立刻返回当前状态（前端靠轮询看进度）。
func (s *Server) handleVoiceInstall(w http.ResponseWriter, r *http.Request) {
	if s.VoiceBin == nil {
		httpx.Fail(w, http.StatusServiceUnavailable, "当前部署未托管内嵌 LiveKit")
		return
	}
	switch err := s.VoiceBin.Install(r.Context()); {
	case err == nil, errors.Is(err, livekit.ErrInstallInProgress),
		errors.Is(err, livekit.ErrAlreadyInstalled), errors.Is(err, livekit.ErrExternalLiveKit):
		// 重复点击 / 已装好都返回当前状态，前端按状态机走，不弹错误。
		httpx.OK(w, map[string]any{"success": true, "status": s.VoiceBin.Status()})
	default:
		httpx.Fail(w, http.StatusInternalServerError, err.Error())
	}
}

// handleVoiceToken 签发 LiveKit 接入凭证。
func (s *Server) handleVoiceToken(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RoomID   any     `json:"roomId"`
		Username *string `json:"username"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}

	if !voiceTruthy(body.RoomID) {
		httpx.BadRequest(w, "roomId 为必填项")
		return
	}
	roomID := voiceString(body.RoomID)

	room, err := s.Rooms.FindByRoomID(r.Context(), roomID)
	if err != nil || room.Status != "active" {
		// 与 Node 的 existsBy({roomId, status:'active'}) 等价：查不到和查到了
		// 但已关闭都是 404，前端只按「房间没了」处理。
		httpx.NotFound(w, "房间不存在或已关闭")
		return
	}

	claims := auth.ClaimsFrom(r.Context())
	allowed, err := s.canReadRoom(r.Context(), roomID, claims)
	if err != nil {
		httpx.InternalError(w, "POST /api/voice/token", err)
		return
	}
	if !allowed {
		httpx.Forbidden(w, "尚未获准进入房间")
		return
	}

	if !s.Voice.Configured() {
		httpx.Fail(w, http.StatusServiceUnavailable, "语音服务未配置（需要 LIVEKIT_API_KEY/API_SECRET）")
		return
	}
	// 二进制随产物分发，只有被手动删掉时才会没有：那前端会在房间里显示下载入口，
	// 这里兜住「旧页面 / 直接调用」的情况，给出可执行的提示而不是让客户端连不上。
	if s.VoiceBin != nil {
		if status := s.VoiceBin.Status(); !status.Available {
			httpx.Fail(w, http.StatusServiceUnavailable,
				"语音聊天组件未下载，请在房间右下角「语音聊天」面板中点击下载")
			return
		}
	}

	// 登录用户身份稳定（重连能顶替同一条轨）；游客每次加入生成一次性身份，
	// 否则两个游客会互相顶掉。
	identity := voiceGuestIdentity()
	if claims.UserID > 0 {
		identity = "user:" + strconv.FormatInt(claims.UserID, 10)
	}
	// `req.body?.username ?? user.username ?? '成员'`：null/缺失才回落，
	// 空串是用户填的（虽然罕见），照原样传。
	name := ""
	switch {
	case body.Username != nil:
		name = *body.Username
	case claims.Username != "":
		name = claims.Username
	default:
		name = "成员"
	}

	token, err := s.Voice.IssueJoinToken(roomID, identity, name)
	if err != nil {
		log.Printf("[voice] token error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "签发语音凭证失败")
		return
	}

	httpx.OK(w, struct {
		Success bool   `json:"success"`
		URL     string `json:"url"`
		Token   string `json:"token"`
	}{Success: true, URL: s.Voice.ResolveClientURL(r.Context(), r), Token: token})
}

// handleVoiceMute 管理员禁言/解禁（服务器侧静音麦克风 + metadata 同步 UI）。
func (s *Server) handleVoiceMute(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RoomID   any `json:"roomId"`
		Identity any `json:"identity"`
		Muted    any `json:"muted"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	muted, mutedIsBool := body.Muted.(bool)
	if !voiceTruthy(body.RoomID) || !voiceTruthy(body.Identity) || !mutedIsBool {
		httpx.BadRequest(w, "roomId/identity/muted 为必填项")
		return
	}
	roomID := voiceString(body.RoomID)
	identity := voiceString(body.Identity)

	admin, err := s.isVoiceAdmin(r.Context(), roomID, auth.ClaimsFrom(r.Context()))
	if err != nil {
		httpx.InternalError(w, "POST /api/voice/mute", err)
		return
	}
	if !admin {
		httpx.Forbidden(w, "无权限：仅房主或房管可操作")
		return
	}

	participants, err := s.Voice.ListParticipants(r.Context(), roomID)
	if err != nil {
		log.Printf("[voice] mute error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "操作失败")
		return
	}
	var target *voice.Participant
	for i := range participants {
		if participants[i].Identity == identity {
			target = &participants[i]
			break
		}
	}
	if target == nil {
		httpx.NotFound(w, "目标不在语音中")
		return
	}

	// 禁言：静音其全部音频轨（服务端强制，客户端绕不过）。
	// 解禁不在这里取消静音——metadata 一变，客户端自己会把麦克风开回来。
	if muted {
		for _, track := range target.Tracks {
			if track.Kind != voice.TrackAudio {
				continue
			}
			if err := s.Voice.MutePublishedTrack(r.Context(), roomID, identity, track.SID, true); err != nil {
				log.Printf("[voice] mute error: %v", err)
				httpx.Fail(w, http.StatusInternalServerError, "操作失败")
				return
			}
		}
	}

	metadata, _ := json.Marshal(struct {
		AdminMuted bool `json:"adminMuted"`
	}{AdminMuted: muted})
	if err := s.Voice.UpdateParticipantMetadata(r.Context(), roomID, identity, string(metadata)); err != nil {
		log.Printf("[voice] mute error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "操作失败")
		return
	}

	httpx.OK(w, struct {
		Success bool `json:"success"`
	}{Success: true})
}

// handleVoiceKick 管理员把参与者踢出语音。
func (s *Server) handleVoiceKick(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RoomID   any `json:"roomId"`
		Identity any `json:"identity"`
	}
	if err := decodeOptionalJSON(r, &body); err != nil {
		httpx.BadRequest(w, "请求体格式无效")
		return
	}
	if !voiceTruthy(body.RoomID) || !voiceTruthy(body.Identity) {
		httpx.BadRequest(w, "roomId/identity 为必填项")
		return
	}
	roomID := voiceString(body.RoomID)
	identity := voiceString(body.Identity)

	admin, err := s.isVoiceAdmin(r.Context(), roomID, auth.ClaimsFrom(r.Context()))
	if err != nil {
		httpx.InternalError(w, "POST /api/voice/kick", err)
		return
	}
	if !admin {
		httpx.Forbidden(w, "无权限：仅房主或房管可操作")
		return
	}

	if err := s.Voice.RemoveParticipant(r.Context(), roomID, identity); err != nil {
		log.Printf("[voice] kick error: %v", err)
		httpx.Fail(w, http.StatusInternalServerError, "操作失败")
		return
	}

	httpx.OK(w, struct {
		Success bool `json:"success"`
	}{Success: true})
}

// isVoiceAdmin 判定语音管理权限：root / admin-房主 / 房主 / 房管。
//
// 与 Node 的 isVoiceAdmin 逐条对齐。注意 admin 只有**在自己是房主时**才有权；
// 普通 admin 不能管别人的房间——这一条容易在重构时被"简化"成
// 「admin 或房主」，那等于给所有管理员开了后门。
func (s *Server) isVoiceAdmin(ctx context.Context, roomID string, claims *auth.Claims) (bool, error) {
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
	isOwner := room.OwnerUserID != nil && *room.OwnerUserID == claims.UserID
	if claims.Role == auth.RoleAdmin && isOwner {
		return true, nil
	}
	if isOwner {
		return true, nil
	}
	return moderatorContains(room.Moderators, claims.UserID), nil
}

// moderatorContains 判断 moderators JSON 数组里有没有这个 userId。
//
// 脏数据按「不是房管」处理（Node 的 try/catch 也是这个语义）：
// 解析失败就锁死权限，宁可让管理员不能用，也不能让陌生人拿到禁言权。
func moderatorContains(raw string, userID int64) bool {
	if raw == "" {
		return false
	}
	var items []any
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return false
	}
	for _, item := range items {
		switch value := item.(type) {
		case float64:
			if int64(value) == userID {
				return true
			}
		case string:
			if value == strconv.FormatInt(userID, 10) {
				return true
			}
		}
	}
	return false
}

// voiceGuestIdentity 生成游客的一次性 LiveKit identity。
//
// 形如 `guest:<base36 时间戳><4 位 base36 随机>`，与 Node 的
// `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` 同形。
func voiceGuestIdentity() string {
	stamp := strconv.FormatInt(time.Now().UnixMilli(), 36)
	return "guest:" + stamp + randomBase36(4)
}

// voiceTruthy 复刻 JS 的 `!value` 判定。
//
// 用 `!roomId` 判空而不是 `roomId == ""`：Node 里 `roomId: 0` 同样算缺失，
// 而 Go 的零值判断会把 "0" 当成有效房间号去查库。
func voiceTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0
	case string:
		return v != ""
	default:
		return true
	}
}

// voiceString 复刻 JS 的 `String(value)`（只覆盖 JSON 能出现的类型）。
func voiceString(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		// JS 的 Number→String 对整数不带小数点，FormatFloat 的 'f'/-1 同效。
		return strconv.FormatFloat(v, 'f', -1, 64)
	default:
		return fmt.Sprint(v)
	}
}

// randomBase36 生成 n 位 base36 随机串（小写，与 JS 的 toString(36) 同字符集）。
func randomBase36(n int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		// 极端情况下退化成时间派生：identity 只需唯一，不需要不可预测。
		seed := time.Now().UnixNano()
		for i := range buf {
			buf[i] = alphabet[byte(seed>>uint(i*3))%36]
		}
		return string(buf)
	}
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%36]
	}
	return string(buf)
}
