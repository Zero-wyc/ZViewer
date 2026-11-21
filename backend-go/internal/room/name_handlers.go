package room

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"zviewer/backend/internal/sio"
)

// 房间内显示名（昵称）。
//
// 与登录账号的 username 分开：username 只作为默认值，成员可以在房间内
// 随时改昵称，且游客没有账号名可显示。昵称只挂在当前 socket 上（socket.data），
// 不落库：换房间/重连由前端 localStorage 记住上次的名字并重新上报。
const (
	displayNameKey    = "displayName"
	displayNameMaxLen = 20
)

// normalizeDisplayName 校验并规整昵称：去首尾空白，限制 1~20 个字符。
func normalizeDisplayName(raw string) (string, bool) {
	name := strings.TrimSpace(raw)
	if name == "" {
		return "", false
	}
	if utf8.RuneCountInString(name) > displayNameMaxLen {
		return "", false
	}
	// 昵称会进入评论/成员列表的纯文本渲染，但换行等控制字符仍应剥掉，
	// 避免把 UI 撑出多行。
	name = strings.Join(strings.Fields(name), " ")
	if name == "" {
		return "", false
	}
	return name, true
}

// socketDisplayName 取连接上的显示名。
//
// 优先级：成员自设昵称 → 登录账号名 → 游客兜底「游客xxxx」。
// 游客的 claims.username 固定是 "guest"，直接显示没有辨识度，故按 guestId
// 后缀生成一个稳定昵称（同一连接内不变）。
func socketDisplayName(sc *sio.Socket) *string {
	if sc == nil {
		return nil
	}
	if value, _ := sc.GetData(displayNameKey); value != nil {
		if v, ok := value.(string); ok && v != "" {
			return &v
		}
	}
	if value, _ := sc.GetData("username"); value != nil {
		if v, ok := value.(string); ok && v != "" && v != RoleGuest {
			return &v
		}
	}
	if gid := socketGuestID(sc); gid != nil {
		name := guestDisplayName(*gid)
		return &name
	}
	return nil
}

// displayNameOr 取显示名，缺失时回退 fallback。
func displayNameOr(sc *sio.Socket, fallback string) string {
	if name := socketDisplayName(sc); name != nil {
		return *name
	}
	return fallback
}

// displayNameFromData 从 Hub.SocketData 快照里取显示名（用于给新观众补发列表）。
func displayNameFromData(data map[string]any) string {
	if v, ok := data[displayNameKey].(string); ok && v != "" {
		return v
	}
	if v, ok := data["username"].(string); ok && v != "" && v != RoleGuest {
		return v
	}
	if gid := guestIDFromData(data); gid != nil {
		return guestDisplayName(*gid)
	}
	return "未知用户"
}

// guestDisplayName 由 guestId 生成稳定的游客昵称。
func guestDisplayName(guestID string) string {
	id := strings.TrimSpace(guestID)
	if len(id) > 4 {
		id = id[len(id)-4:]
	}
	id = strings.ToUpper(id)
	if id == "" {
		return "游客"
	}
	return "游客" + id
}

type setDisplayNamePayload struct {
	RoomID string `json:"roomId"`
	Name   string `json:"name"`
}

// bindDisplayName 注册「修改房间内昵称」事件。
func (s *Service) bindDisplayName(sc *sio.Socket) {
	sc.On("set-display-name", func(args []json.RawMessage, ack func(...any)) {
		s.handleSetDisplayName(sc, args, ack)
	})
}

func (s *Service) handleSetDisplayName(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	payload, _ := decodePayload[setDisplayNamePayload](args)
	name, ok := normalizeDisplayName(payload.Name)
	if !ok {
		ackFail(ack, "昵称需为 1~20 个字符")
		return
	}
	sc.SetData(displayNameKey, name)

	// 已在房间里：广播改名，让其他端把成员列表/评论名同步过去。
	if s.Hub != nil {
		ctx, cancel := handlerCtx()
		defer cancel()
		if sess, err := s.ActiveSession(ctx, sc.ID); err == nil && sess != nil {
			if payload.RoomID == "" || payload.RoomID == sess.RoomID {
				s.Hub.EmitRoom(sess.RoomID, "viewer-renamed", map[string]any{
					"viewerSocketId": sc.ID,
					"username":       name,
				})
			}
		}
	}
	ackOK(ack, map[string]any{"name": name})
}
