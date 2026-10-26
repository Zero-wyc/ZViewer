package room

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"zviewer/backend/internal/nms"
	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// maxModerators 是单房间房管人数上限（对应 Node 的 MAX_MODERATORS）。
const maxModerators = 10

// pendingRoomIDKey 是「等待房主审批」时写进连接 data 的键名。
const pendingRoomIDKey = "pendingRoomId"

// ==================== 事件注册 ====================

// bindViewerManagement 注册观众管理类事件（房主/房管的成员操作）。
//
// 对应 Node 的 ViewerManagementHandler，注册位置在 ViewerJoinHandler 之后。
func (s *Service) bindViewerManagement(sc *sio.Socket) {
	sc.On("approve-join", func(args []json.RawMessage, ack func(...any)) {
		s.handleApproveJoin(sc, args, ack)
	})
	sc.On("reject-join", func(args []json.RawMessage, ack func(...any)) {
		s.handleRejectJoin(sc, args, ack)
	})
	sc.On("kick-viewer", func(args []json.RawMessage, ack func(...any)) {
		s.handleKickViewer(sc, args, ack)
	})
	sc.On("mute-viewer", func(args []json.RawMessage, ack func(...any)) {
		s.handleMuteViewer(sc, args, ack, true)
	})
	sc.On("unmute-viewer", func(args []json.RawMessage, ack func(...any)) {
		s.handleMuteViewer(sc, args, ack, false)
	})
	sc.On("transfer-host", func(args []json.RawMessage, ack func(...any)) {
		s.handleTransferHost(sc, args, ack)
	})
	sc.On("appoint-moderator", func(args []json.RawMessage, ack func(...any)) {
		s.handleAppointModerator(sc, args, ack)
	})
	sc.On("dismiss-moderator", func(args []json.RawMessage, ack func(...any)) {
		s.handleDismissModerator(sc, args, ack)
	})
}

// ==================== approve-join / reject-join ====================

type viewerSocketPayload struct {
	ViewerSocketID string `json:"viewerSocketId"`
}

// handleApproveJoin 批准观众加入：仅房主。
//
// 与 request-join 的白名单路径共用 admitViewer，但**事件顺序不同**
// （这里先给房管列表再给影片列表，Node 侧就是这样），所以不能直接调 finishJoin。
func (s *Service) handleApproveJoin(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[viewerSocketPayload](args)
	sharer, err := s.SharerBySocketID(ctx, sc.ID)
	if err != nil {
		s.Logger.Printf("[approve-join] 校验房主失败: %v", err)
		ackFail(ack, "确认失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "无权限确认")
		return
	}

	if s.Hub == nil || !s.Hub.Connected(payload.ViewerSocketID) {
		ackFail(ack, "观看者已断开连接")
		return
	}
	viewerData := s.Hub.SocketData(payload.ViewerSocketID)
	pending, _ := viewerData[pendingRoomIDKey].(string)

	room, err := s.Rooms.FindByRoomID(ctx, sharer.RoomID)
	if errors.Is(err, store.ErrRoomNotFound) || (err == nil && room == nil) || pending != sharer.RoomID {
		ackFail(ack, "没有该房间的待审批申请")
		return
	}
	if err != nil {
		s.Logger.Printf("[approve-join] 读取房间失败: %v", err)
		ackFail(ack, "确认失败")
		return
	}

	uid := userIDFromData(viewerData)
	guestID := guestIDFromData(viewerData)
	if _, err := s.AdmitViewer(ctx, payload.ViewerSocketID, sharer.RoomID, uid, guestID); err != nil {
		s.Logger.Printf("[approve-join] 准入失败 %s: %v", payload.ViewerSocketID, err)
		ackFail(ack, "确认失败")
		return
	}
	s.Hub.Join(payload.ViewerSocketID, sharer.RoomID)

	s.Hub.EmitTo(payload.ViewerSocketID, "join-approved", map[string]any{
		"roomId":      sharer.RoomID,
		"mode":        room.Mode,
		"shareMethod": room.ShareMethod,
		"name":        room.Name,
	})

	// 房管列表先于影片列表下发（权限 UI 初始化）。
	s.Hub.EmitTo(payload.ViewerSocketID, "moderators-changed", map[string]any{
		"roomId":     sharer.RoomID,
		"moderators": s.Moderators(ctx, sharer.RoomID),
	})
	s.Hub.EmitTo(payload.ViewerSocketID, "movie-list", map[string]any{"movies": s.Movies(sharer.RoomID)})
	s.Hub.EmitTo(payload.ViewerSocketID, "current-movie", map[string]any{"movieId": s.CurrentMovieID(sharer.RoomID)})
	if sub := s.Subtitle(sharer.RoomID); sub != nil {
		s.Hub.EmitTo(payload.ViewerSocketID, "subtitle-update", sub)
	}

	s.Hub.EmitRoom(sharer.RoomID, "viewer-joined", map[string]any{
		"viewerSocketId": payload.ViewerSocketID,
		"userId":         anyOrNil(uid),
		"username":       usernameFromData(viewerData),
		"role":           "viewer",
	})

	// 批准的观众写入持久化白名单：刷新页面 / 切模式回来不必再等房主点一次。
	if uid != nil && *uid > 0 {
		if approved := appendID(room.ApprovedViewers, *uid); approved != nil {
			if err := s.Rooms.SetApprovedViewers(ctx, sharer.RoomID, approved); err != nil {
				// 白名单写失败不该把已经成功的准入回滚，只记日志。
				s.Logger.Printf("[approve-join] 写入审批白名单失败 %s: %v", sharer.RoomID, err)
			}
		}
	}

	s.sendExistingViewersByID(ctx, payload.ViewerSocketID, sharer.RoomID)
	ackOK(ack, nil)
}

// handleRejectJoin 拒绝观众加入：仅房主。
func (s *Service) handleRejectJoin(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[viewerSocketPayload](args)
	sharer, err := s.SharerBySocketID(ctx, sc.ID)
	if err != nil {
		s.Logger.Printf("[reject-join] 校验房主失败: %v", err)
		ackFail(ack, "拒绝失败")
		return
	}
	if sharer == nil {
		ackFail(ack, "无权限拒绝")
		return
	}

	if s.Hub != nil {
		data := s.Hub.SocketData(payload.ViewerSocketID)
		if pending, _ := data[pendingRoomIDKey].(string); pending != sharer.RoomID {
			ackFail(ack, "没有待审批申请")
			return
		}
		s.Hub.DeleteSocketData(payload.ViewerSocketID, pendingRoomIDKey)
		s.Hub.EmitTo(payload.ViewerSocketID, "join-rejected", map[string]any{"roomId": sharer.RoomID})
	}
	ackOK(ack, nil)
}

// ==================== kick-viewer ====================

type kickViewerPayload struct {
	RoomID         string `json:"roomId"`
	ViewerSocketID string `json:"viewerSocketId"`
}

// handleKickViewer 踢出观众：房主或房管（房管受防篡权约束）。
func (s *Service) handleKickViewer(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[kickViewerPayload](args)
	allowed, err := s.CanViewerPerform(ctx, sc.ID, socketRole(sc), payload.RoomID, "kickViewer")
	if err != nil {
		s.Logger.Printf("[kick-viewer] 权限判定失败: %v", err)
		ackFail(ack, "踢人失败")
		return
	}
	if !allowed {
		ackFail(ack, "无权限：没有踢人权限")
		return
	}

	if denial := s.moderatorDenial(ctx, sc, payload.RoomID, payload.ViewerSocketID); denial != "" {
		ackFail(ack, denial)
		return
	}

	ok, err := s.kickViewer(ctx, payload.RoomID, payload.ViewerSocketID)
	if err != nil {
		s.Logger.Printf("[kick-viewer] 踢出失败: %v", err)
		ackFail(ack, "踢人失败")
		return
	}
	if !ok {
		ackFail(ack, "观众已不在房间")
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "viewer-left", map[string]any{
			"viewerSocketId": payload.ViewerSocketID,
		})
	}
	ackOK(ack, nil)
}

// kickViewer 通知并断开目标观众，结束其会话。
//
// 顺序与 Node 一致：先发 viewer-kicked（让被踢方弹出提示），再结束会话，
// 最后 leave + disconnect。反过来被踢方收不到提示，看起来像"自己掉线"。
func (s *Service) kickViewer(ctx context.Context, roomID, viewerSocketID string) (bool, error) {
	if s.Hub == nil || !s.Hub.Connected(viewerSocketID) {
		return false, nil
	}
	target, err := s.Sessions.FindActiveByRoomSocket(ctx, roomID, viewerSocketID)
	if err != nil {
		return false, err
	}
	if target == nil || target.Role != store.SessionRoleViewer {
		return false, nil
	}
	s.Hub.EmitTo(viewerSocketID, "viewer-kicked", map[string]any{
		"reason": "房主已将您移出房间",
	})
	if err := s.Sessions.EndByID(ctx, target.ID); err != nil {
		return false, err
	}
	s.perm.invalidate(viewerSocketID, roomID)
	s.Hub.Leave(viewerSocketID, roomID)
	s.Hub.Disconnect(viewerSocketID)
	return true, nil
}

// ==================== mute-viewer / unmute-viewer ====================

type muteViewerPayload struct {
	RoomID string `json:"roomId"`
	UserID int64  `json:"userId"`
}

// handleMuteViewer 禁言 / 解禁：房主或房管。
//
// mute 与 unmute 走同一个函数，但两条路径的校验**不对称**（Node 侧就是如此）：
// 禁言要查防篡权、还挡游客（游客共享 userId=0，禁一个等于禁全体），
// 解禁则直接放行。
func (s *Service) handleMuteViewer(sc *sio.Socket, args []json.RawMessage, ack func(...any), mute bool) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[muteViewerPayload](args)
	allowed, err := s.CanViewerPerform(ctx, sc.ID, socketRole(sc), payload.RoomID, "muteViewer")
	if err != nil {
		s.Logger.Printf("[mute-viewer] 权限判定失败: %v", err)
		ackFail(ack, failMessage(mute))
		return
	}
	if !allowed {
		if mute {
			ackFail(ack, "无权限：没有禁言权限")
		} else {
			ackFail(ack, "无权限：没有解禁权限")
		}
		return
	}

	if mute {
		if payload.UserID <= 0 {
			ackFail(ack, "游客无法单独禁言，请使用踢出")
			return
		}
		host, hostErr := s.IsRoomHost(ctx, sc.ID, payload.RoomID)
		if hostErr != nil {
			s.Logger.Printf("[mute-viewer] 校验房主失败: %v", hostErr)
			ackFail(ack, "禁言失败")
			return
		}
		if !host {
			uid := payload.UserID
			denial, denialErr := s.CanModeratorActOn(ctx, payload.RoomID, &uid, "")
			if denialErr != nil {
				s.Logger.Printf("[mute-viewer] 防篡权校验失败: %v", denialErr)
				ackFail(ack, "禁言失败")
				return
			}
			if denial != "" {
				ackFail(ack, denial)
				return
			}
		}
	}

	if err := s.setMuted(ctx, payload.RoomID, payload.UserID, mute); err != nil {
		s.Logger.Printf("[mute-viewer] 写入禁言名单失败: %v", err)
		ackFail(ack, failMessage(mute))
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "viewer-muted", map[string]any{
			"userId": payload.UserID,
			"muted":  mute,
		})
	}
	ackOK(ack, nil)
}

func failMessage(mute bool) string {
	if mute {
		return "禁言失败"
	}
	return "解禁失败"
}

// setMuted 把 userId 加入 / 移出房间禁言名单。
func (s *Service) setMuted(ctx context.Context, roomID string, userID int64, muted bool) error {
	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if errors.Is(err, store.ErrRoomNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	list := parseIDList(room.MutedViewers)
	if muted {
		if !containsID(list, userID) {
			list = append(list, userID)
		}
	} else {
		filtered := make([]int64, 0, len(list))
		for _, id := range list {
			if id != userID {
				filtered = append(filtered, id)
			}
		}
		list = filtered
	}
	return s.Rooms.SetMutedViewers(ctx, roomID, list)
}

// ==================== transfer-host ====================

type transferHostPayload struct {
	RoomID         string `json:"roomId"`
	ViewerSocketID string `json:"viewerSocketId"`
}

// handleTransferHost 转交房主：仅房主。
func (s *Service) handleTransferHost(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[transferHostPayload](args)
	host, err := s.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[transfer-host] 校验房主失败: %v", err)
		ackFail(ack, "转交房主失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可转交")
		return
	}

	if s.Hub == nil || !s.Hub.Connected(payload.ViewerSocketID) {
		ackFail(ack, "目标观众已断开")
		return
	}
	targetData := s.Hub.SocketData(payload.ViewerSocketID)
	targetRole, _ := targetData["role"].(string)
	if targetRole == RoleGuest {
		ackFail(ack, "不能转交给游客账户")
		return
	}
	newOwnerUID := userIDFromData(targetData)
	if newOwnerUID == nil {
		ackFail(ack, "目标观众身份无效")
		return
	}

	nextModerators, err := s.transferHost(ctx, payload.RoomID, payload.ViewerSocketID, sc.ID, *newOwnerUID)
	if err != nil {
		s.Logger.Printf("[transfer-host] 转交失败: %v", err)
		ackFail(ack, "转交房主失败")
		return
	}

	s.Hub.EmitRoom(payload.RoomID, "host-transferred", map[string]any{
		"newHostSocketId": payload.ViewerSocketID,
		"oldHostSocketId": sc.ID,
		"newOwnerUserId":  *newOwnerUID,
	})
	if room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID); err == nil {
		s.Hub.EmitTo(payload.ViewerSocketID, "share-method-changed", map[string]any{"roomId": payload.RoomID, "shareMethod": room.ShareMethod, "streamKey": room.StreamKey})
		s.Hub.EmitTo(sc.ID, "share-method-changed", map[string]any{"roomId": payload.RoomID, "shareMethod": room.ShareMethod, "streamKey": nil})
	}

	if nextModerators != nil {
		s.Hub.EmitRoom(payload.RoomID, "moderators-changed", map[string]any{
			"roomId":     payload.RoomID,
			"moderators": nextModerators,
		})
	}
	ackOK(ack, nil)
}

// transferHost 在事务里完成角色互换与 owner 迁移。
//
// 返回清理后的房管名单；无变化时返回 nil（调用方据此决定是否广播）。
// 新房主若原本是房管，必须从名单里移除：房主天然拥有全部权限，
// 留着这条会让前端给房主多打一个「房管」徽标，也是脏数据。
func (s *Service) transferHost(ctx context.Context, roomID, newSocketID, oldSocketID string, newOwnerUID int64) ([]int64, error) {
	if newSocketID == oldSocketID || newOwnerUID <= 0 {
		return nil, ErrNoPermission
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var moderators string
	err = tx.QueryRowContext(ctx,
		`SELECT "moderators" FROM "room" WHERE "roomId" = ? AND "status" = 'active' LIMIT 1`, roomID).
		Scan(&moderators)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrRoomClosed
	}
	if err != nil {
		return nil, fmt.Errorf("读取房间失败: %w", err)
	}
	// Constrain both updates to live sessions in this room. The old queries also
	// promoted viewers in unrelated rooms and rewrote ended session history.
	result, err := tx.ExecContext(ctx,
		`UPDATE "session" SET "role" = ? WHERE "roomId" = ? AND "socketId" = ? AND "role" = ? AND "userId" = ? AND "endedAt" IS NULL`,
		store.SessionRoleSharer, roomID, newSocketID, store.SessionRoleViewer, newOwnerUID)
	if err != nil {
		return nil, fmt.Errorf("升级新房主失败: %w", err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return nil, ErrViewerGone
	}
	result, err = tx.ExecContext(ctx,
		`UPDATE "session" SET "role" = ? WHERE "roomId" = ? AND "socketId" = ? AND "role" = ? AND "endedAt" IS NULL`,
		store.SessionRoleViewer, roomID, oldSocketID, store.SessionRoleSharer)
	if err != nil {
		return nil, fmt.Errorf("降级原房主失败: %w", err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		return nil, ErrNotHost
	}

	var nextModerators []int64
	if err == nil {
		current := parseIDList(moderators)
		encodedMods := moderators
		if containsID(current, newOwnerUID) {
			filtered := make([]int64, 0, len(current))
			for _, id := range current {
				if id != newOwnerUID {
					filtered = append(filtered, id)
				}
			}
			nextModerators = filtered
			encodedMods = encodeIDList(nextModerators)
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE "room" SET "ownerUserId" = ?, "moderators" = ?, "streamKey" = CASE WHEN "streamKey" IS NULL THEN NULL ELSE ? END, "updatedAt" = ?
			WHERE "roomId" = ?
		`, newOwnerUID, encodedMods, nms.GenerateStreamKey(), store.FormatSQLiteTime(time.Now()), roomID); err != nil {
			return nil, fmt.Errorf("更新房间归属失败: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	// 新旧房主的权限缓存必须立刻失效：旧的还是 sharer 结果，新的还不是。
	s.perm.invalidate(oldSocketID, roomID)
	s.perm.invalidate(newSocketID, roomID)
	return nextModerators, nil
}

// ==================== appoint / dismiss moderator ====================

type moderatorPayload struct {
	RoomID string `json:"roomId"`
	UserID int64  `json:"userId"`
}

// handleAppointModerator 任命房管：仅房主。
func (s *Service) handleAppointModerator(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[moderatorPayload](args)
	host, err := s.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[appoint-moderator] 校验房主失败: %v", err)
		ackFail(ack, "任命房管失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可任命房管")
		return
	}
	if payload.UserID <= 0 {
		ackFail(ack, "不能任命游客为房管")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if err != nil && !errors.Is(err, store.ErrRoomNotFound) {
		s.Logger.Printf("[appoint-moderator] 读取房间失败: %v", err)
		ackFail(ack, "任命房管失败")
		return
	}
	if room != nil && room.OwnerUserID != nil && *room.OwnerUserID == payload.UserID {
		ackFail(ack, "房主无需任命")
		return
	}

	moderators := []int64{}
	if room != nil {
		moderators = s.Moderators(ctx, payload.RoomID)
	}
	if containsID(moderators, payload.UserID) {
		// 已在名单里：幂等成功，但**不带 data**（Node 侧就是这个形状）。
		ackOK(ack, nil)
		return
	}

	inRoom, err := s.Sessions.FindActiveByRoomUser(ctx, payload.RoomID, payload.UserID)
	if err != nil {
		s.Logger.Printf("[appoint-moderator] 查询目标会话失败: %v", err)
		ackFail(ack, "任命房管失败")
		return
	}
	if inRoom == nil {
		ackFail(ack, "目标用户不在房间内")
		return
	}

	if len(moderators) >= maxModerators {
		ackFail(ack, fmt.Sprintf("房管人数已达上限（%d）", maxModerators))
		return
	}

	moderators = append(moderators, payload.UserID)
	if err := s.SetModerators(ctx, payload.RoomID, moderators); err != nil {
		s.Logger.Printf("[appoint-moderator] 写入房管名单失败: %v", err)
		ackFail(ack, "任命房管失败")
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "moderators-changed", map[string]any{
			"roomId":     payload.RoomID,
			"moderators": moderators,
		})
	}
	ackOK(ack, map[string]any{"moderators": moderators})
}

// handleDismissModerator 撤销房管：仅房主。
func (s *Service) handleDismissModerator(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[moderatorPayload](args)
	host, err := s.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[dismiss-moderator] 校验房主失败: %v", err)
		ackFail(ack, "撤销房管失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可撤销房管")
		return
	}

	moderators := s.Moderators(ctx, payload.RoomID)
	if !containsID(moderators, payload.UserID) {
		ackOK(ack, nil)
		return
	}
	next := make([]int64, 0, len(moderators))
	for _, id := range moderators {
		if id != payload.UserID {
			next = append(next, id)
		}
	}
	if err := s.SetModerators(ctx, payload.RoomID, next); err != nil {
		s.Logger.Printf("[dismiss-moderator] 写入房管名单失败: %v", err)
		ackFail(ack, "撤销房管失败")
		return
	}

	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "moderators-changed", map[string]any{
			"roomId":     payload.RoomID,
			"moderators": next,
		})
	}
	ackOK(ack, map[string]any{"moderators": next})
}

// ==================== 辅助 ====================

// moderatorDenial 是「房管对目标动手」前的防篡权判定（房主不受限）。
//
// 返回空串表示放行；否则是拒绝原因，直接作为 ack 的 message 下发。
func (s *Service) moderatorDenial(ctx context.Context, sc *sio.Socket, roomID, targetSocketID string) string {
	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil || host {
		return ""
	}
	data := map[string]any{}
	if s.Hub != nil {
		data = s.Hub.SocketData(targetSocketID)
	}
	role, _ := data["role"].(string)
	denial, err := s.CanModeratorActOn(ctx, roomID, userIDFromData(data), role)
	if err != nil {
		s.Logger.Printf("[viewer-management] 防篡权校验失败: %v", err)
		return ""
	}
	return denial
}

// sendExistingViewersByID 给指定连接补发已在线的其他观众。
//
// 与 sendExistingViewers 的差别只是入参是 socketId 而不是 *sio.Socket
// （审批路径上手里只有观众那侧的 ID）。
func (s *Service) sendExistingViewersByID(ctx context.Context, socketID, roomID string) {
	if s.Hub == nil {
		return
	}
	viewers, err := s.Viewers(ctx, roomID)
	if err != nil {
		s.Logger.Printf("[approve-join] 读取在线观众失败: %v", err)
		return
	}
	for _, sess := range viewers {
		if sess.SocketID == socketID {
			continue
		}
		data := s.Hub.SocketData(sess.SocketID)
		role := "viewer"
		if r, ok := data["role"].(string); ok && r != "" {
			role = r
		}
		s.Hub.EmitTo(socketID, "viewer-joined", map[string]any{
			"viewerSocketId": sess.SocketID,
			"userId":         anyOrNil(userIDFromData(data)),
			"username":       usernameFromData(data),
			"role":           role,
		})
	}
}

func guestIDFromData(data map[string]any) *string {
	if v, ok := data["guestId"].(string); ok && v != "" {
		return &v
	}
	return nil
}

// parseIDList 解析 JSON 数组列（失败按空列表）。
func parseIDList(raw string) []int64 {
	if raw == "" {
		return []int64{}
	}
	var ids []int64
	if err := json.Unmarshal([]byte(raw), &ids); err != nil {
		return []int64{}
	}
	if ids == nil {
		return []int64{}
	}
	return ids
}

// appendID 在不存在时追加并返回新列表；已存在返回 nil（调用方据此跳过写库）。
func appendID(raw string, userID int64) []int64 {
	list := parseIDList(raw)
	if containsID(list, userID) {
		return nil
	}
	return append(list, userID)
}

func encodeIDList(ids []int64) string {
	if ids == nil {
		ids = []int64{}
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}
