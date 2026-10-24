package room

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// hostJoinGrace 是房主离线后观众仍可加入的宽限期。
//
// 比重连宽限期（10 分钟）短一半：房主掉线 5 分钟内观众还能进来看，
// 再久就别放新人进来了（房间里没人能控制播放）。
const hostJoinGrace = 5 * time.Minute

// roomIDAlphabet 与 Node 侧 nanoid customAlphabet 的字符集一致。
const roomIDAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

// ctx 为单个事件提供超时上下文。
//
// handler 在传输读协程里同步执行（与 Node 事件循环等价），一个卡住的
// 数据库查询会连带卡掉同一连接的心跳与后续事件，所以必须设上限。
func handlerCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// ==================== socket.data 读取 ====================

func socketUserID(sc *sio.Socket) *int64 {
	v, ok := sc.Data["userId"]
	if !ok {
		return nil
	}
	switch n := v.(type) {
	case int64:
		return &n
	case float64:
		i := int64(n)
		return &i
	case int:
		i := int64(n)
		return &i
	case json.Number:
		if i, err := n.Int64(); err == nil {
			return &i
		}
	}
	return nil
}

func socketRole(sc *sio.Socket) string {
	if v, ok := sc.Data["role"].(string); ok {
		return v
	}
	return RoleGuest
}

func socketUsername(sc *sio.Socket) *string {
	if v, ok := sc.Data["username"].(string); ok && v != "" {
		return &v
	}
	return nil
}

func socketGuestID(sc *sio.Socket) *string {
	if v, ok := sc.Data["guestId"].(string); ok && v != "" {
		return &v
	}
	return nil
}

// ==================== ack 应答 ====================

// AckResponse 是 ack 回调的应答体，字段名与 Node 的 AckResponse 一致。
//
// data 为 nil 时**整个键消失**（对应 Node 的 `{success:true}`）：
// 下发 `"data":null` 会让前端 `res.data?.xxx` 之类的判断多一种形态。
type AckResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message,omitempty"`
	Code    string `json:"code,omitempty"`
	Data    any    `json:"data,omitempty"`
}

func safeAck(ack func(...any), resp AckResponse) {
	if ack == nil {
		return
	}
	// 客户端可能已断开，ack 写不出去是正常现象。
	defer func() { _ = recover() }()
	ack(resp)
}

func ackOK(ack func(...any), data any) {
	safeAck(ack, AckResponse{Success: true, Data: data})
}

func ackOKMsg(ack func(...any), message string, data any) {
	safeAck(ack, AckResponse{Success: true, Message: message, Data: data})
}

func ackFail(ack func(...any), message string) {
	safeAck(ack, AckResponse{Success: false, Message: message})
}

func ackFailCode(ack func(...any), code, message string) {
	safeAck(ack, AckResponse{Success: false, Code: code, Message: message})
}

// ackRaw 原样发送应答体。
//
// AckResponse 的 Data 带 omitempty，表达不了「data 键存在但值为 null」；
// watch-together-request-state 里 `data: null` 是「房间暂无播放状态」的
// 显式信号，前端靠它区分「没数据」与「字段缺失」，所以那条事件绕开结构体。
func ackRaw(ack func(...any), resp any) {
	if ack == nil {
		return
	}
	defer func() { _ = recover() }()
	ack(resp)
}

// ==================== payload 解析 ====================

// decodePayload 把事件第一个参数解成结构体。
//
// 参数缺失 / 为 null 时返回零值且 ok=false（不是错误）：Node 侧
// `payload.name` 对 undefined 也只是得到 undefined，不会抛异常。
func decodePayload[T any](args []json.RawMessage) (T, bool) {
	var out T
	if len(args) == 0 {
		return out, false
	}
	raw := strings.TrimSpace(string(args[0]))
	if raw == "" || raw == "null" {
		return out, false
	}
	if err := json.Unmarshal(args[0], &out); err != nil {
		return out, false
	}
	return out, true
}

// ==================== 事件注册 ====================

// AttachSocket 把房间相关事件挂到一条新连接上。
//
// 注册顺序即 Node 侧 createSocketRegistry 的顺序
// （生命周期 → 房间设置 → 断线 → 房主注册 → 观众加入 → 观众管理）；
// 同一事件被多个模块认领时以先注册者为准，所以这里不能随意调换。
func (s *Service) AttachSocket(sc *sio.Socket) {
	s.bindLifecycle(sc)
	s.bindRoomSettings(sc)
	s.bindDisconnect(sc)
	s.bindRegisterHost(sc)
	s.bindViewerJoin(sc)
	s.bindViewerManagement(sc)
	// 播放控制 / 影片列表 / 字幕轨道 / 跳转申请：顺序不影响行为
	// （事件名两两不重叠），但保持与 Node 侧 register-handlers 相近的
	// 排列，方便对照。
	s.bindPlaybackSync(sc)
	s.bindMovieList(sc)
	s.bindSubtitleAndTracks(sc)
	s.bindSeekApproval(sc)
	s.bindComments(sc)
	// 一起听音乐：队列 CRUD / 播放状态与心跳 / 观众申请制控制。
	// 事件名与前面的模块无重叠，位置不影响行为。
	s.bindMusic(sc)
	// WebRTC 信令与观众就绪。
	s.bindWebRTC(sc)
	// CLI 代理 / 预览源 / 投屏子模式（零散能力）。
	s.bindMisc(sc)
}

// ---------- 房间生命周期 ----------

func (s *Service) bindLifecycle(sc *sio.Socket) {
	sc.On("create-room", func(args []json.RawMessage, ack func(...any)) {
		s.handleCreateRoom(sc, args, ack)
	})
	sc.On("host-leave", func(_ []json.RawMessage, ack func(...any)) {
		s.handleHostLeave(sc, ack)
	})
	sc.On("close-room", func(_ []json.RawMessage, ack func(...any)) {
		s.handleCloseRoom(sc, ack)
	})
	sc.On("admin-close-room", func(args []json.RawMessage, ack func(...any)) {
		s.handleAdminCloseRoom(sc, args, ack)
	})
}

type createRoomPayload struct {
	Name            *string `json:"name"`
	Password        *string `json:"password"`
	MaxViewers      *int64  `json:"maxViewers"`
	RequireApproval *bool   `json:"requireApproval"`
	Mode            *string `json:"mode"`
}

func (s *Service) handleCreateRoom(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[createRoomPayload](args)

	userID := int64(0)
	if uid := socketUserID(sc); uid != nil {
		userID = *uid
	}
	role := socketRole(sc)

	settings, err := s.Settings.Get(ctx)
	if err != nil {
		s.Logger.Printf("[create-room] 读取设置失败: %v", err)
	}
	if !CanCreateRoom(role, settings) {
		hint := "无权限：当前账号无法创建房间"
		if role == RoleGuest {
			hint = "请先登录后再创建房间"
		} else if settings != nil && settings.RoomCreationMode == "admin-only" {
			hint = "无权限：当前仅管理员可创建房间（请联系管理员开启「所有用户」权限）"
		}
		ackFail(ack, hint)
		return
	}

	if payload.MaxViewers != nil && (*payload.MaxViewers < 1 || *payload.MaxViewers > 100) {
		ackFail(ack, "观看人数必须为 1 到 100 的整数")
		return
	}
	if payload.Mode != nil && !validRoomMode(*payload.Mode) {
		ackFail(ack, "房间模式无效")
		return
	}

	// 建新房间前先退出旧房间：否则这一个 socket 同时待在新旧两个房间，
	// 会继续收到旧房间的 movie-list，新房间就显示出旧房间的影片列表。
	oldSharer, err := s.SharerBySocketID(ctx, sc.ID)
	if err != nil {
		s.Logger.Printf("[create-room] 查询旧会话失败: %v", err)
	}
	if oldSharer != nil && oldSharer.RoomID != "" {
		sc.Leave(oldSharer.RoomID)
		if err := s.Sessions.EndByID(ctx, oldSharer.ID); err != nil {
			s.Logger.Printf("[create-room] 结束旧会话失败: %v", err)
		}
		s.perm.invalidate(oldSharer.SocketID, oldSharer.RoomID)
		s.CancelReconnectTimer(oldSharer.RoomID)
	}

	roomID, err := s.uniqueRoomID(ctx)
	if err != nil {
		s.Logger.Printf("[create-room] 生成房间号失败: %v", err)
		ackFail(ack, "创建房间失败")
		return
	}

	var passwordHash *string
	rawPassword := ""
	if payload.Password != nil {
		rawPassword = strings.TrimSpace(*payload.Password)
	}
	if rawPassword != "" {
		// cost 10 与 Node 侧 bcrypt.hash(rawPassword, 10) 一致，两边可互验。
		hashed, err := bcrypt.GenerateFromPassword([]byte(rawPassword), 10)
		if err != nil {
			s.Logger.Printf("[create-room] 加密密码失败: %v", err)
			ackFail(ack, "创建房间失败")
			return
		}
		h := string(hashed)
		passwordHash = &h
	}

	name := "房间 " + roomID
	if payload.Name != nil && strings.TrimSpace(*payload.Name) != "" {
		name = strings.TrimSpace(*payload.Name)
	}
	maxViewers := int64(10)
	if payload.MaxViewers != nil {
		maxViewers = *payload.MaxViewers
	}
	mode := "screen-share"
	if payload.Mode != nil {
		mode = *payload.Mode
	}
	requireApproval := false
	if payload.RequireApproval != nil {
		requireApproval = *payload.RequireApproval
	}

	var owner *int64
	if userID > 0 {
		uid := userID
		owner = &uid
	}

	room := &store.Room{
		RoomID:          roomID,
		Name:            &name,
		Password:        passwordHash,
		MaxViewers:      maxViewers,
		Status:          "active",
		Mode:            mode,
		RequireApproval: requireApproval,
		OwnerUserID:     owner,
	}
	if err := s.Rooms.Create(ctx, room); err != nil {
		s.Logger.Printf("[create-room] 落库失败: %v", err)
		ackFail(ack, "创建房间失败")
		return
	}

	// 房主注册：建 sharer 会话 + 进房间。失败不回滚房间——
	// Node 侧同样是「房间建了但没人注册」，重进会走 register-host 恢复。
	if _, err := s.RegisterHost(ctx, sc.ID, roomID, userID); err != nil {
		s.Logger.Printf("[create-room] 注册房主失败: %v", err)
		ackFail(ack, "创建房间失败")
		return
	}
	sc.Join(roomID)

	ackOK(ack, map[string]any{"roomId": roomID, "mode": mode})
}

func (s *Service) handleHostLeave(sc *sio.Socket, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	sharer, err := s.SharerBySocketID(ctx, sc.ID)
	if err != nil {
		s.Logger.Printf("[host-leave] 查询会话失败: %v", err)
		ackFail(ack, "离开房间失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "无权限离开房间")
		return
	}
	roomID := sharer.RoomID

	// 与断线处理保持一致：结束会话 → 清 hostSocketId → 广播 → 起重连定时器。
	// 区别只是房主还能继续用这条连接浏览别的页面。
	if _, err := s.EndSession(ctx, sc.ID); err != nil {
		s.Logger.Printf("[host-leave] 结束会话失败: %v", err)
		ackFail(ack, "离开房间失败")
		return
	}
	if err := s.Playback.UpdateHostSocket(ctx, roomID, nil); err != nil {
		s.Logger.Printf("[host-leave] 清空房主 socket 失败: %v", err)
	}
	if s.Hub != nil {
		s.Hub.EmitRoom(roomID, "host-disconnected", map[string]any{"roomId": roomID})
	}

	settings := s.Settings
	s.StartReconnectTimer(roomID, func() {
		closeCtx, closeCancel := handlerCtx()
		defer closeCancel()
		s.CloseAfterHostGrace(closeCtx, settings, roomID, sc.ID)
	})

	sc.Leave(roomID)
	ackOK(ack, nil)
}

func (s *Service) handleCloseRoom(sc *sio.Socket, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	sharer, err := s.SharerBySocketID(ctx, sc.ID)
	if err != nil {
		s.Logger.Printf("[close-room] 查询会话失败: %v", err)
		ackFail(ack, "关闭房间失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "无权限关闭房间")
		return
	}
	// 先取消重连定时器，避免 10 分钟后再触发一次关闭（重复广播 room-closed）。
	s.CancelReconnectTimer(sharer.RoomID)

	if err := s.CloseAndNotify(ctx, sharer.RoomID, sc.ID); err != nil {
		s.Logger.Printf("[close-room] 关闭失败: %v", err)
		ackFail(ack, "关闭房间失败")
		return
	}
	sc.Leave(sharer.RoomID)
	ackOK(ack, nil)
}

type adminCloseRoomPayload struct {
	RoomID string `json:"roomId"`
}

func (s *Service) handleAdminCloseRoom(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	role := socketRole(sc)
	if role != RoleAdmin && role != RoleRoot {
		ackFail(ack, "无权限：仅管理员可关闭房间")
		return
	}
	payload, _ := decodePayload[adminCloseRoomPayload](args)

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if err != nil || room == nil {
		ackFail(ack, "房间不存在")
		return
	}
	sharer, err := s.Sharer(ctx, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[admin-close-room] 查询房主失败: %v", err)
	}
	sharerSocketID := ""
	if sharer != nil {
		sharerSocketID = sharer.SocketID
	}

	s.CancelReconnectTimer(payload.RoomID)
	if err := s.CloseAndNotify(ctx, payload.RoomID, sharerSocketID); err != nil {
		s.Logger.Printf("[admin-close-room] 关闭失败: %v", err)
		ackFail(ack, "关闭房间失败")
		return
	}
	ackOK(ack, nil)
}

// ---------- 房主注册 / 重连 ----------

func (s *Service) bindRegisterHost(sc *sio.Socket) {
	sc.On("register-host", func(args []json.RawMessage, ack func(...any)) {
		s.handleRegisterHost(sc, args, ack)
	})
}

type registerHostPayload struct {
	RoomID string `json:"roomId"`
}

func (s *Service) handleRegisterHost(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[registerHostPayload](args)
	uid := socketUserID(sc)
	userID := int64(0)
	if uid != nil {
		userID = *uid
	}

	// 重复进入检测：同一账号不能在两个标签页同时当房主。
	// 真正的重连不会命中这里——旧 socket 已断，session 会被复用。
	if existing, err := s.ActiveSessionByUser(ctx, payload.RoomID, uid); err != nil {
		s.Logger.Printf("[register-host] 查询既有会话失败: %v", err)
	} else if existing != nil && existing.SocketID != sc.ID {
		if s.Hub != nil && s.Hub.Connected(existing.SocketID) {
			ackFailCode(ack, "ALREADY_IN_ROOM", "该账户已在此房间内，不能同时打开多个标签页")
			return
		}
		// 旧 socket 已断但 session 没清理（进程被杀等）：收尾后放行。
		if _, err := s.EndSession(ctx, existing.SocketID); err != nil {
			s.Logger.Printf("[register-host] 结束陈旧会话失败: %v", err)
		}
	}

	result, err := s.RegisterHost(ctx, sc.ID, payload.RoomID, userID)
	if err != nil {
		s.Logger.Printf("[register-host] 注册失败: %v", err)
		ackFail(ack, "恢复房主身份失败")
		return
	}
	if result == nil {
		ackFail(ack, "房间不存在或无权限")
		return
	}

	sc.Join(payload.RoomID)

	// 同步 DB 影片到运行时状态并广播 movie-list：后端重启后内存是空的，
	// 不恢复的话 play-movie 会一直报「影片不存在」。
	if err := s.BroadcastMovieList(ctx, payload.RoomID); err != nil {
		s.Logger.Printf("[register-host] 广播影片列表失败: %v", err)
	}

	// sharer-ready 只发给别人（socket.to）：房主自己也收会导致
	// viewer-events 监听器重复触发。
	sc.To(payload.RoomID).Emit("sharer-ready", map[string]any{"roomId": payload.RoomID})

	data := map[string]any{
		"mode":            result.Mode,
		"shareMethod":     result.ShareMethod,
		"name":            result.Name,
		"streamKey":       result.StreamKey,
		"requireApproval": result.RequireApproval,
	}
	if result.Playback != nil {
		data["playback"] = result.Playback
	}
	ackOK(ack, data)
}

// ---------- 观众加入 ----------

func (s *Service) bindViewerJoin(sc *sio.Socket) {
	sc.On("request-join", func(args []json.RawMessage, ack func(...any)) {
		s.handleRequestJoin(sc, args, ack)
	})
}

type requestJoinPayload struct {
	RoomID   string `json:"roomId"`
	Password string `json:"password"`
}

func (s *Service) handleRequestJoin(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[requestJoinPayload](args)
	role := socketRole(sc)

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if err != nil || room == nil {
		ackFail(ack, "房间不存在")
		return
	}
	if room.Status != "active" {
		ackFail(ack, "房间已关闭")
		return
	}

	uid := socketUserID(sc)
	settings, err := s.Settings.Get(ctx)
	if err != nil {
		s.Logger.Printf("[request-join] 读取设置失败: %v", err)
	}

	// 同账号多端检测。游客共享 userId=0，不能按它判定（会互相顶替），
	// 而「多页面同时登录」开关打开时也跳过（仅供测试）。
	if settings == nil || !settings.RoomMultiInstanceLogin {
		if uid != nil && role != RoleGuest {
			existing, err := s.ActiveSessionByUser(ctx, payload.RoomID, uid)
			if err != nil {
				s.Logger.Printf("[request-join] 查询既有会话失败: %v", err)
			} else if existing != nil && existing.SocketID != sc.ID {
				if s.Hub != nil && s.Hub.Connected(existing.SocketID) {
					ackFailCode(ack, "ALREADY_IN_ROOM", "该账户已在此房间内，不能同时打开多个标签页")
					return
				}
				if _, err := s.EndSession(ctx, existing.SocketID); err != nil {
					s.Logger.Printf("[request-join] 结束陈旧会话失败: %v", err)
				}
			}
		}
	}

	// 房主身份恢复：房主刷新页面后 sessionStorage 标记丢失，会走观众流程；
	// 这里按 owner 直接恢复成房主，否则房主刷新一次就变观众、房间里没人能控播。
	userID := int64(0)
	if uid != nil {
		userID = *uid
	}
	isOwner := room.OwnerUserID != nil && *room.OwnerUserID == userID
	isOrphan := room.OwnerUserID == nil && role != RoleGuest
	if uid != nil && role != RoleGuest && (isOwner || isOrphan) {
		hostResult, err := s.RegisterHost(ctx, sc.ID, payload.RoomID, userID)
		if err != nil {
			s.Logger.Printf("[request-join] 恢复房主失败: %v", err)
		} else if hostResult != nil {
			sc.Join(payload.RoomID)
			if err := s.BroadcastMovieList(ctx, payload.RoomID); err != nil {
				s.Logger.Printf("[request-join] 广播影片列表失败: %v", err)
			}
			sc.To(payload.RoomID).Emit("sharer-ready", map[string]any{"roomId": payload.RoomID})
			ackOKMsg(ack, "已恢复房主身份", map[string]any{
				"mode":        hostResult.Mode,
				"shareMethod": hostResult.ShareMethod,
				"streamKey":   hostResult.StreamKey,
				"isHost":      true,
			})
			return
		}
	}

	// 密码校验：root 直接放行（管理员救场），其余走 bcrypt。
	if role != RoleRoot && room.HasPassword && room.Password != nil {
		if err := bcrypt.CompareHashAndPassword([]byte(*room.Password), []byte(payload.Password)); err != nil {
			ackFail(ack, "密码错误")
			return
		}
	}

	// 已经在这个房间里（重复 request-join）：直接成功，不新建会话。
	if own, err := s.ActiveSession(ctx, sc.ID); err == nil && own != nil && own.RoomID == payload.RoomID {
		ackOKMsg(ack, "已加入房间", map[string]any{"mode": room.Mode, "shareMethod": room.ShareMethod})
		return
	}

	count, err := s.ViewerCount(ctx, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[request-join] 统计观众失败: %v", err)
		ackFail(ack, "加入房间失败")
		return
	}
	if count >= room.MaxViewers {
		ackFail(ack, "房间观看人数已达上限")
		return
	}

	// 房主在线判定：需审批的房间必须有人在审批，免审批的允许房主
	// 短暂离线（hostJoinGrace 内）。
	var sharer *store.Session
	if room.RequireApproval {
		sharer, err = s.Sharer(ctx, payload.RoomID)
	} else {
		sharer, err = s.RecentSharer(ctx, payload.RoomID, hostJoinGrace)
	}
	if err != nil {
		s.Logger.Printf("[request-join] 查询房主失败: %v", err)
		ackFail(ack, "加入房间失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "分享端不在线")
		return
	}

	if !room.RequireApproval {
		s.finishJoin(ctx, sc, room, uid, false, ack)
		return
	}

	// 需审批：已批准过的用户（持久化白名单）直接进，不必再等房主点一次。
	if uid != nil && *uid > 0 && approvedContains(room.ApprovedViewers, *uid) {
		s.finishJoin(ctx, sc, room, uid, true, ack)
		return
	}

	sc.Data["pendingRoomId"] = payload.RoomID
	if s.Hub != nil {
		s.Hub.EmitTo(sharer.SocketID, "join-request", map[string]any{"viewerSocketId": sc.ID})
	}
	ackOKMsg(ack, "等待分享端确认", map[string]any{
		"mode":        room.Mode,
		"shareMethod": room.ShareMethod,
		"streamKey":   room.StreamKey,
	})
}

// finishJoin 执行「免审批 / 命中白名单」两条加入路径共用的收尾动作。
//
// 两条路径在 Node 侧是逐行重复的（join-approved → movie-list → current-movie
// → 字幕补发 → viewer-joined → 补发在线观众 → [房管列表]），合并后
// 少一处「改了一边忘了另一边」的机会。
//
// withModerators：白名单路径额外下发房管列表（权限 UI 初始化），
// 免审批路径不下发——差异是 Node 侧的既有行为，别顺手统一。
func (s *Service) finishJoin(ctx context.Context, sc *sio.Socket, room *store.Room, uid *int64, withModerators bool, ack func(...any)) {
	roomID := room.RoomID
	if _, err := s.AdmitViewer(ctx, sc.ID, roomID, uid, socketGuestID(sc)); err != nil {
		// Node 的 admitViewer 抛出的具体错误（房间已关闭 / 观看者已断开 /
		// 人数已达上限）同样被 request-join 的 catch 吞成这一句，这里保持一致。
		s.Logger.Printf("[request-join] 准入失败 %s: %v", roomID, err)
		ackFail(ack, "加入房间失败")
		return
	}
	sc.Join(roomID)

	approved := map[string]any{
		"roomId":      roomID,
		"mode":        room.Mode,
		"shareMethod": room.ShareMethod,
		"name":        room.Name,
	}
	if withModerators {
		approved["streamKey"] = room.StreamKey
	}
	if s.Hub != nil {
		s.Hub.EmitTo(sc.ID, "join-approved", approved)
		s.Hub.EmitTo(sc.ID, "movie-list", map[string]any{"movies": s.Movies(roomID)})
		s.Hub.EmitTo(sc.ID, "current-movie", map[string]any{"movieId": s.CurrentMovieID(roomID)})
		// 补发房主当前字幕：subtitle-update 只在房主变更时实时转发，
		// 中途加入的观众否则永远收不到加入前已加载的字幕。
		if sub := s.Subtitle(roomID); sub != nil {
			s.Hub.EmitTo(sc.ID, "subtitle-update", sub)
		}
	}

	joined := map[string]any{
		"viewerSocketId": sc.ID,
		"userId":         anyOrNil(uid),
		"username":       usernameOr(sc, "未知用户"),
		"role":           "viewer",
	}
	if s.Hub != nil {
		s.Hub.EmitRoom(roomID, "viewer-joined", joined)
		s.sendExistingViewers(ctx, sc, roomID)
		if withModerators {
			s.sendModerators(ctx, sc, roomID)
		}
	}

	ackOKMsg(ack, "已加入房间", map[string]any{
		"mode":        room.Mode,
		"shareMethod": room.ShareMethod,
		"streamKey":   room.StreamKey,
	})
}

// sendExistingViewers 给新观众补发已在线的其他观众。
//
// 新观众只能通过别人的 viewer-joined 感知后续加入者，看不到之前的，
// 在线人数就会一直是 1。
func (s *Service) sendExistingViewers(ctx context.Context, sc *sio.Socket, roomID string) {
	viewers, err := s.Viewers(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[request-join] 读取在线观众失败: %v", err)
		return
	}
	for _, sess := range viewers {
		if sess.SocketID == sc.ID {
			continue
		}
		data := s.Hub.SocketData(sess.SocketID)
		role := "viewer"
		if r, ok := data["role"].(string); ok && r != "" {
			role = r
		}
		s.Hub.EmitTo(sc.ID, "viewer-joined", map[string]any{
			"viewerSocketId": sess.SocketID,
			"userId":         anyOrNil(userIDFromData(data)),
			"username":       usernameFromData(data),
			"role":           role,
		})
	}
}

func (s *Service) sendModerators(ctx context.Context, sc *sio.Socket, roomID string) {
	s.Hub.EmitTo(sc.ID, "moderators-changed", map[string]any{
		"roomId":     roomID,
		"moderators": s.Moderators(ctx, roomID),
	})
}

// Moderators 读取房间房管列表（解析失败按空列表，与 Node 的 try/catch 一致）。
func (s *Service) Moderators(ctx context.Context, roomID string) []int64 {
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil || room == nil {
		return []int64{}
	}
	var ids []int64
	if room.Moderators != "" {
		if err := json.Unmarshal([]byte(room.Moderators), &ids); err != nil {
			return []int64{}
		}
	}
	if ids == nil {
		return []int64{}
	}
	return ids
}

func anyOrNil(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

func usernameOr(sc *sio.Socket, fallback string) string {
	if u := socketUsername(sc); u != nil {
		return *u
	}
	return fallback
}

func usernameFromData(data map[string]any) string {
	if u, ok := data["username"].(string); ok && u != "" {
		return u
	}
	return "未知用户"
}

func userIDFromData(data map[string]any) *int64 {
	switch n := data["userId"].(type) {
	case int64:
		return &n
	case float64:
		i := int64(n)
		return &i
	case int:
		i := int64(n)
		return &i
	}
	return nil
}

func approvedContains(raw string, userID int64) bool {
	if raw == "" {
		return false
	}
	var ids []int64
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return false
	}
	for _, id := range ids {
		if id == userID {
			return true
		}
	}
	return false
}

// ---------- 断线 ----------

func (s *Service) bindDisconnect(sc *sio.Socket) {
	sc.OnDisconnect(func(reason string) {
		// 断线回调在传输读协程里触发，DB 往返会拖住收尾流程（连 close 帧都要等），
		// 因此另起协程处理。Node 侧同样是 fire-and-forget 的 async IIFE。
		go s.handleDisconnect(sc.ID, reason)
	})
}

func (s *Service) handleDisconnect(socketID, reason string) {
	ctx, cancel := handlerCtx()
	defer cancel()

	sess, err := s.EndSession(ctx, socketID)
	if err != nil {
		s.Logger.Printf("[disconnect] 结束会话失败 %s: %v", socketID, err)
		return
	}
	if sess == nil {
		// 没进过房间的连接（只连了一下就断）没有会话要收尾。
		return
	}

	if sess.Role == store.SessionRoleSharer {
		// 房主断开：清 hostSocketId 但**保留播放状态**，服务器继续推算进度
		// 广播给观众——观众不该因为房主关了浏览器就黑屏。
		if err := s.Playback.UpdateHostSocket(ctx, sess.RoomID, nil); err != nil {
			s.Logger.Printf("[disconnect] 清空房主 socket 失败 %s: %v", sess.RoomID, err)
		}
		if s.Hub != nil {
			s.Hub.EmitRoom(sess.RoomID, "host-disconnected", map[string]any{"roomId": sess.RoomID})
		}
		roomID := sess.RoomID
		settings := s.Settings
		s.StartReconnectTimer(roomID, func() {
			closeCtx, closeCancel := handlerCtx()
			defer closeCancel()
			s.CloseAfterHostGrace(closeCtx, settings, roomID, socketID)
		})
		return
	}

	if s.Hub != nil {
		// viewer-left 统一用 viewerSocketId 字段（历史上前端两种字段名都读过，
		// 混用会让「在线人数」偶发不减少）。
		s.Hub.EmitRoom(sess.RoomID, "viewer-left", map[string]any{"viewerSocketId": socketID})
	}
	_ = reason
}

func validRoomMode(mode string) bool {
	switch mode {
	case "screen-share", "watch-together", "listen-together":
		return true
	}
	return false
}

// uniqueRoomID 生成未占用的 8 位房间号。
func (s *Service) uniqueRoomID(ctx context.Context) (string, error) {
	for i := 0; i < 20; i++ {
		id, err := randomRoomID()
		if err != nil {
			return "", err
		}
		exists, err := s.Rooms.Exists(ctx, id)
		if err != nil {
			return "", err
		}
		if !exists {
			return id, nil
		}
	}
	return "", errRoomIDExhausted
}

func randomRoomID() (string, error) {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	out := make([]byte, 8)
	for i, b := range buf {
		out[i] = roomIDAlphabet[int(b)%len(roomIDAlphabet)]
	}
	return string(out), nil
}
