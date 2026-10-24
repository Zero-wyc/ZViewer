package room

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 评论 / 弹幕 / 批注的 6 个事件。
//
// 对应 Node 的 modules/comment/handlers/comment.handler.ts。
// 这一组事件的共同点：都不改房间状态，只做「校验 → 落库 → 广播」，
// 因此没有权限矩阵参与，只用了三条判定：
//   - 在房间内（含评论独立窗口的 panelRoomIds 分支）
//   - 未被房主禁言（禁言是房间级的，按 userId 存）
//   - 清空批注要求房主身份
//
// 广播一律用 io.to(roomId)（**发送者自己也收**），与 p2p-mode-change 的
// socket.to 语义相反——评论发出去要立刻在自己界面上屏，不能等回显。

// CommentDTO 是评论的对外形态（字段与 Node 的 CommentDto 一致）。
type CommentDTO struct {
	ID        int64  `json:"id"`
	RoomID    string `json:"roomId"`
	Username  string `json:"username"`
	Content   string `json:"content"`
	IsDanmaku bool   `json:"isDanmaku"`
	CreatedAt string `json:"createdAt"`
}

// danmakuEntry 是实时弹幕日志的一条记录。
//
// Time 用指针 + omitempty：Node 侧 videoTime 不是有限数时整个键不出现
// （`JSON.stringify` 丢掉 undefined），写成 0 会把弹幕钉在第 0 秒。
type danmakuEntry struct {
	ID      string   `json:"id"`
	Content string   `json:"content"`
	Sender  string   `json:"sender"`
	Time    *float64 `json:"time,omitempty"`
}

// danmakuBroadcast 是 send-danmaku 上屏用的载荷。
type danmakuBroadcast struct {
	ID     string `json:"id"`
	Text   string `json:"text"`
	Sender string `json:"sender"`
}

// danmakuMetaPayload 是 danmaku-meta-updated 的载荷。
type danmakuMetaPayload struct {
	RoomID string     `json:"roomId"`
	Meta   danmakuDTO `json:"meta"`
}

// danmakuDTO 对应 Node 的 DanmakuMetaDto（三个字段都是数组）。
//
// 用 json.RawMessage 而不是 []any：库里的文本本来就是数组 JSON，
// 原样透传比「解析成 []any 再序列化」少一层数字精度与 key 序的漂移。
type danmakuDTO struct {
	BlockKeywords json.RawMessage `json:"blockKeywords"`
	DeletedLog    json.RawMessage `json:"deletedLog"`
	RealtimeLog   json.RawMessage `json:"realtimeLog"`
}

// annotationBroadcast 是批注笔画的转发载荷。
//
// Stroke 用 RawMessage：前端画布的数据结构在客户端演进，服务端只负责转发。
// 缺失时整个键消失（Node 的 `{stroke: undefined}` 同理）。
type annotationBroadcast struct {
	Stroke   json.RawMessage `json:"stroke,omitempty"`
	SenderID string          `json:"senderId"`
}

// bindComments 挂载评论 / 弹幕 / 批注事件。
func (s *Service) bindComments(sc *sio.Socket) {
	sc.On("send-comment", func(args []json.RawMessage, ack func(...any)) {
		s.handleSendComment(sc, args, ack)
	})
	sc.On("comment-history", func(args []json.RawMessage, ack func(...any)) {
		s.handleCommentHistory(sc, args, ack)
	})
	sc.On("join-room-panel", func(args []json.RawMessage, ack func(...any)) {
		s.handleJoinRoomPanel(sc, args, ack)
	})
	sc.On("send-danmaku", func(args []json.RawMessage, ack func(...any)) {
		s.handleSendDanmaku(sc, args, ack)
	})
	sc.On("annotation-stroke", func(args []json.RawMessage, ack func(...any)) {
		s.handleAnnotationStroke(sc, args, ack)
	})
	sc.On("clear-annotations", func(args []json.RawMessage, ack func(...any)) {
		s.handleClearAnnotations(sc, args, ack)
	})
}

// ==================== send-comment ====================

type sendCommentPayload struct {
	RoomID    string `json:"roomId"`
	Content   string `json:"content"`
	IsDanmaku *bool  `json:"isDanmaku"`
}

func (s *Service) handleSendComment(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[sendCommentPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}

	content := strings.TrimSpace(payload.Content)
	if content == "" {
		ackFail(ack, "评论内容不能为空")
		return
	}

	if uid := socketUserID(sc); uid != nil {
		muted, err := s.IsMuted(ctx, payload.RoomID, *uid)
		if err != nil {
			s.Logger.Printf("[send-comment] 禁言判定失败: %v", err)
			ackFail(ack, "发送评论失败")
			return
		}
		if muted {
			ackFail(ack, "您已被房主禁言")
			return
		}
	}

	username := s.resolveUsername(ctx, sc)
	isDanmaku := payload.IsDanmaku != nil && *payload.IsDanmaku

	if s.Comments == nil {
		ackFail(ack, "发送评论失败")
		return
	}
	comment, err := s.Comments.Create(ctx, payload.RoomID, username, content, isDanmaku)
	if err != nil {
		s.Logger.Printf("[send-comment] 落库失败: %v", err)
		ackFail(ack, "发送评论失败")
		return
	}

	s.broadcastRoom(payload.RoomID, "new-comment", toCommentDTO(comment))
	ackOK(ack, nil)
}

// ==================== comment-history ====================

type commentHistoryResponse struct {
	Success  bool         `json:"success"`
	Message  string       `json:"message,omitempty"`
	Comments []CommentDTO `json:"comments,omitempty"`
}

// roomOnlyPayload 是只带 roomId 的载荷（history / panel / clear 三个事件共用）。
type roomOnlyPayload struct {
	RoomID string `json:"roomId"`
}

func (s *Service) handleCommentHistory(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[roomOnlyPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}
	if s.Comments == nil {
		ackRaw(ack, commentHistoryResponse{Success: false, Message: "获取评论历史失败"})
		return
	}
	list, err := s.Comments.ListByRoom(ctx, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[comment-history] 读取失败: %v", err)
		ackRaw(ack, commentHistoryResponse{Success: false, Message: "获取评论历史失败"})
		return
	}

	// 空列表必须是 []：nil 切片配 omitempty 会让整个键消失，
	// 前端 `comments.map` 直接抛 TypeError。
	out := make([]CommentDTO, 0, len(list))
	for _, item := range list {
		out = append(out, toCommentDTO(item))
	}
	ackRaw(ack, commentHistoryResponse{Success: true, Comments: out})
}

// ==================== join-room-panel ====================

// handleJoinRoomPanel 让「评论独立窗口」轻量加入房间。
//
// 这里刻意**不走**完整进房流程：不建 sharer/viewer 角色语义、不占人数位、
// 不做审批，只在 socket.data.panelRoomIds 里留个标记 + socket.join。
// 后续 send-comment / comment-history / send-danmaku 的「在房判定」靠这个标记
// （见 IsInRoom 的 panelRoomIds 分支），并回落 canReadRoom 做真实的准入校验。
func (s *Service) handleJoinRoomPanel(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[roomOnlyPayload](args)

	room, err := s.Rooms.FindByRoomID(ctx, payload.RoomID)
	if err != nil {
		if errors.Is(err, store.ErrRoomNotFound) {
			ackFail(ack, "房间不存在")
			return
		}
		s.Logger.Printf("[join-room-panel] 读取房间失败: %v", err)
		ackFail(ack, "加入失败")
		return
	}
	if room.Status != "active" {
		ackFail(ack, "房间已关闭")
		return
	}

	allowed, err := s.canReadRoom(ctx, payload.RoomID, sc.Data)
	if err != nil {
		s.Logger.Printf("[join-room-panel] 准入判定失败: %v", err)
		ackFail(ack, "加入失败")
		return
	}
	if !allowed {
		ackFail(ack, "请先获准进入房间")
		return
	}

	sc.SetData("panelRoomIds", appendPanelRoom(sc.Data["panelRoomIds"], payload.RoomID))
	sc.Join(payload.RoomID)

	// panel 标记会改变「在房判定」的结果，缓存必须立刻失效，
	// 否则同一 socket 前面查过一次 isInRoom=false，5s 内发评论都会被拒。
	s.perm.invalidate(sc.ID, payload.RoomID)
	ackOK(ack, nil)
}

// appendPanelRoom 在保持原有顺序的前提下追加房间 ID（去重）。
func appendPanelRoom(existing any, roomID string) []string {
	out := make([]string, 0, 4)
	seen := make(map[string]bool, 4)
	add := func(id string) {
		if id == "" || seen[id] {
			return
		}
		seen[id] = true
		out = append(out, id)
	}
	switch list := existing.(type) {
	case []string:
		for _, id := range list {
			add(id)
		}
	case []any:
		for _, item := range list {
			if id, ok := item.(string); ok {
				add(id)
			}
		}
	}
	add(roomID)
	return out
}

// ==================== send-danmaku ====================

type sendDanmakuPayload struct {
	RoomID    string   `json:"roomId"`
	Content   string   `json:"content"`
	VideoTime *float64 `json:"videoTime"`
}

func (s *Service) handleSendDanmaku(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[sendDanmakuPayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}

	content := strings.TrimSpace(payload.Content)
	if content == "" {
		ackFail(ack, "弹幕内容不能为空")
		return
	}
	if uid := socketUserID(sc); uid != nil {
		muted, err := s.IsMuted(ctx, payload.RoomID, *uid)
		if err != nil {
			s.Logger.Printf("[send-danmaku] 禁言判定失败: %v", err)
			ackFail(ack, "发送弹幕失败")
			return
		}
		if muted {
			ackFail(ack, "您已被房主禁言")
			return
		}
	}

	username := s.resolveUsername(ctx, sc)
	danmakuID := newDanmakuID()

	// 落库与 danmaku-meta-updated 广播失败**不影响上屏**：
	// 实时弹幕的价值是「此刻看到」，存储是附带能力（Node 同样只记日志）。
	if err := s.appendRealtimeDanmaku(ctx, payload.RoomID, danmakuEntry{
		ID:      danmakuID,
		Content: content,
		Sender:  username,
		Time:    payload.VideoTime,
	}); err != nil {
		s.Logger.Printf("[send-danmaku] 记录实时弹幕失败: %v", err)
	}

	s.broadcastRoom(payload.RoomID, "danmaku", danmakuBroadcast{
		ID:     danmakuID,
		Text:   content,
		Sender: username,
	})
	ackOK(ack, nil)
}

// appendRealtimeDanmaku 追加一条实时弹幕并广播 danmaku-meta-updated。
func (s *Service) appendRealtimeDanmaku(ctx context.Context, roomID string, entry danmakuEntry) error {
	if s.Metas == nil {
		return nil
	}
	raw, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	meta, err := s.Metas.AppendRealtime(ctx, roomID, raw)
	if err != nil {
		return err
	}
	s.broadcastRoom(roomID, "danmaku-meta-updated", danmakuMetaPayload{
		RoomID: roomID,
		Meta:   toDanmakuDTO(meta),
	})
	return nil
}

// ==================== annotation-stroke ====================

type annotationStrokePayload struct {
	RoomID string          `json:"roomId"`
	Stroke json.RawMessage `json:"stroke"`
}

func (s *Service) handleAnnotationStroke(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[annotationStrokePayload](args)

	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}
	s.broadcastRoom(payload.RoomID, "annotation-stroke", annotationBroadcast{
		Stroke:   payload.Stroke,
		SenderID: sc.ID,
	})
	ackOK(ack, nil)
}

// ==================== clear-annotations ====================

func (s *Service) handleClearAnnotations(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, _ := decodePayload[roomOnlyPayload](args)

	host, err := s.IsRoomHost(ctx, sc.ID, payload.RoomID)
	if err != nil {
		s.Logger.Printf("[clear-annotations] 房主判定失败: %v", err)
		ackFail(ack, "清空批注失败")
		return
	}
	if !host {
		ackFail(ack, "无权限清空批注")
		return
	}

	// 零参数事件：`io.to(roomId).emit('clear-annotations')`。
	if s.Hub != nil && payload.RoomID != "" {
		s.Hub.EmitRoomNoArgs(payload.RoomID, "clear-annotations")
	}
	ackOK(ack, nil)
}

// ==================== 工具 ====================

// resolveUsername 取发送者显示名。
//
// 优先用握手时 JWT 带下来的 username，缺失才查库并写回 socket.data
// （Node 的 getUsername 同样会缓存），避免高频发言重复打 user 表。
func (s *Service) resolveUsername(ctx context.Context, sc *sio.Socket) string {
	if name := socketUsername(sc); name != nil {
		return *name
	}
	const unknown = "未知用户"
	uid := socketUserID(sc)
	if uid == nil || *uid <= 0 || s.Users == nil {
		return unknown
	}
	user, err := s.Users.FindByID(ctx, *uid)
	if err != nil || user == nil || user.Username == "" {
		return unknown
	}
	if s.Hub != nil {
		s.Hub.SetSocketData(sc.ID, "username", user.Username)
	}
	return user.Username
}

// broadcastRoom 向房间内所有连接广播（含发送者本身）。
func (s *Service) broadcastRoom(roomID, event string, payload any) {
	if s.Hub == nil || roomID == "" {
		return
	}
	s.Hub.EmitRoom(roomID, event, payload)
}

// toCommentDTO 转成对外形态；createdAt 复刻 JS 的 toISOString（毫秒三位 + Z）。
func toCommentDTO(c *store.Comment) CommentDTO {
	return CommentDTO{
		ID:        c.ID,
		RoomID:    c.RoomID,
		Username:  c.Username,
		Content:   c.Content,
		IsDanmaku: c.IsDanmaku,
		CreatedAt: c.CreatedAt.UTC().Format("2006-01-02T15:04:05.000Z"),
	}
}

// toDanmakuDTO 把三列 JSON 文本还原成数组（坏数据按 [] 处理）。
func toDanmakuDTO(meta *store.DanmakuMeta) danmakuDTO {
	return danmakuDTO{
		BlockKeywords: jsonArrayOrEmpty(meta.BlockKeywords),
		DeletedLog:    jsonArrayOrEmpty(meta.DeletedLog),
		RealtimeLog:   jsonArrayOrEmpty(meta.RealtimeLog),
	}
}

func jsonArrayOrEmpty(text string) json.RawMessage {
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "[") {
		return json.RawMessage(trimmed)
	}
	return json.RawMessage("[]")
}

// newDanmakuID 生成 `<毫秒时间戳>-<6 位 base36>` 形式的弹幕 ID。
//
// 形状与 Node 一致（`${Date.now()}-${Math.random().toString(36).slice(2, 8)}`），
// 前端会按 `-` 切分取时间戳做去重与本地回放。
func newDanmakuID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	var sb strings.Builder
	sb.WriteString(strconv.FormatInt(time.Now().UnixMilli(), 10))
	sb.WriteByte('-')
	for i := 0; i < 6; i++ {
		sb.WriteByte(alphabet[rand.Intn(len(alphabet))])
	}
	return sb.String()
}
