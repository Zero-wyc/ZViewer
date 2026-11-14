package room

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"time"

	"zviewer/backend/internal/sio"
)

// Live2D 房间悬浮层的三个事件（对应前端 modules/live2d）。
//
// 这一组的形状参照字幕同步（sync_handlers.go）：房主/成员声明自己的模型 →
// 内存缓存 → 广播 → 另有 *-request 供新加入者补拉。差别在于这里是**高频**：
// 指针每 15Hz 上报一次，所以 state 既不 ack、也不落库、更不逐帧广播，
// 而是攒脏由 Broadcaster 每 100ms 合并成一条 patch。
//
// 身份判定一律用 sc.ID（socket id），payload 里即使带了 sid 也忽略——
// 否则任何人伪造一个 sid 就能改别人的模型朝向。

// live2dPatchOut 是合并下行的载荷。
//
// 用元组数组而不是对象数组：8 个人全动时一条 patch 有 8 行，每行省 20~25 字节，
// 一条消息就能省下一条 MTU 的量级。
type live2dPatchOut struct {
	RoomID string   `json:"roomId"`
	Upd    [][]any  `json:"u,omitempty"`
	Rem    []string `json:"r,omitempty"`
	Add    [][]any  `json:"add,omitempty"`
}

type live2dSnapshotOut struct {
	RoomID string  `json:"roomId"`
	Models [][]any `json:"models"`
}

type live2dConfigPayload struct {
	RoomID  string   `json:"roomId"`
	Action  string   `json:"action"`
	Kind    string   `json:"kind"`
	ModelID string   `json:"modelId"`
	Scale   *float64 `json:"scale"`
}

type live2dStatePayload struct {
	RoomID string   `json:"roomId"`
	X      *float64 `json:"x"`
	Y      *float64 `json:"y"`
	AR     *float64 `json:"a"`
}

var (
	live2dBuiltinIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	live2dRoomIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

// live2dRow 把成员压成一行：[sid, name, kind, modelId, scale, ord, x, y, ar]。
// 快照的 models 与 patch 的 add 共用这个形状，前端只需要一个解析函数。
func live2dRow(m live2dMember) []any {
	return []any{
		m.SocketID, m.Name, m.Kind, m.ModelID,
		roundTo(m.Scale, 2), m.Ord,
		roundTo(m.X, 3), roundTo(m.Y, 3), roundTo(m.AR, 2),
	}
}

func live2dRows(list []live2dMember) [][]any {
	out := make([][]any, 0, len(list))
	for _, m := range list {
		out = append(out, live2dRow(m))
	}
	return out
}

func (s *Service) bindLive2D(sc *sio.Socket) {
	sc.On("live2d-config", func(args []json.RawMessage, ack func(...any)) {
		s.handleLive2DConfig(sc, args, ack)
	})
	sc.On("live2d-state", func(args []json.RawMessage, _ func(...any)) {
		s.handleLive2DState(sc, args)
	})
	sc.On("live2d-request", func(args []json.RawMessage, _ func(...any)) {
		s.handleLive2DRequest(sc, args)
	})
}

// handleLive2DConfig 处理「我选了哪个模型」。低频（换模型才发），可以查库判权限。
func (s *Service) handleLive2DConfig(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	if len(args) == 0 || len(args[0]) > 1024 {
		ackFail(ack, "模型参数不合法")
		return
	}
	payload, ok := decodePayload[live2dConfigPayload](args)
	if !ok || payload.RoomID == "" {
		ackFail(ack, "缺少 roomId")
		return
	}
	if !s.requireInRoom(ctx, ack, sc, payload.RoomID, "不在该房间中") {
		return
	}

	if payload.Action == "clear" {
		if s.Live2DRemove(payload.RoomID, sc.ID) && s.Hub != nil {
			// 立即下发而不是等 100ms ticker：模型消失要当场看到
			s.Hub.EmitRoom(payload.RoomID, "live2d-patch", live2dPatchOut{
				RoomID: payload.RoomID, Rem: []string{sc.ID},
			})
		}
		ackOK(ack, map[string]any{"models": live2dRows(s.Live2DSnapshot(payload.RoomID))})
		return
	}

	kind := payload.Kind
	if kind == "" {
		kind = "builtin"
	}
	modelID := strings.TrimSpace(payload.ModelID)

	switch kind {
	case "builtin":
		if !live2dBuiltinIDPattern.MatchString(modelID) {
			ackFail(ack, "模型标识不合法")
			return
		}
	case "url", "room":
		// 自定义模型只开给房主：URL 会让别人的浏览器去拉第三方资源，
		// 房间上传模型则要占服务器磁盘，两者都不该由普通观众决定。
		if !s.requireHost(ctx, ack, sc, payload.RoomID, "只有房主可以设置自定义模型") {
			return
		}
		if kind == "url" {
			if problem := validateLive2DModelURL(modelID); problem != "" {
				ackFail(ack, problem)
				return
			}
		} else if !live2dRoomIDPattern.MatchString(modelID) {
			ackFail(ack, "模型标识不合法")
			return
		}
	default:
		ackFail(ack, "不支持的模型类型")
		return
	}

	scale := 1.0
	if payload.Scale != nil {
		scale = clampFloat(*payload.Scale, live2dMinScale, live2dMaxScale)
	}

	name := "成员"
	if u := socketUsername(sc); u != nil && strings.TrimSpace(*u) != "" {
		name = strings.TrimSpace(*u)
	}
	if r := []rune(name); len(r) > 32 {
		name = string(r[:32])
	}

	member := live2dMember{
		SocketID: sc.ID,
		Name:     name,
		Kind:     kind,
		ModelID:  modelID,
		Scale:    scale,
		X:        0.5,
		Y:        0.5,
		AR:       live2dDefaultAR,
	}
	if !s.Live2DSet(payload.RoomID, member) {
		ackFail(ack, "房间内角色数量已达上限")
		return
	}

	// 直接把应用后的全量快照回给发起者：他刚换模型，本地的名册/排位可能已经
	// 变了，让服务端顺手带回来能省一次 request 往返。
	ackOK(ack, map[string]any{"models": live2dRows(s.Live2DSnapshot(payload.RoomID))})
}

// handleLive2DState 是热路径（每客户端 15Hz），必须极轻：
// 不 ack、不查库、不碰 Service.mu，只做一次 map 查表和数值钳制。
func (s *Service) handleLive2DState(sc *sio.Socket, args []json.RawMessage) {
	if len(args) == 0 || len(args[0]) > 256 {
		return
	}
	var payload live2dStatePayload
	if err := json.Unmarshal(args[0], &payload); err != nil {
		return
	}
	if payload.RoomID == "" || payload.X == nil || payload.Y == nil {
		return
	}
	// 成员资格来自上一次 live2d-config；没声明过模型的连接发这个直接丢弃
	if !s.Live2DHas(payload.RoomID, sc.ID) {
		return
	}
	ar := live2dDefaultAR
	if payload.AR != nil {
		ar = *payload.AR
	}
	s.Live2DUpdateState(payload.RoomID, sc.ID, *payload.X, *payload.Y, ar, time.Now())
}

// handleLive2DRequest 回发本房间的全量快照（无 ack，失败静默）。
//
// 必须留这一条：join 时的推送往往早于前端 effect 挂载而丢失，
// 与字幕 / 影片列表的 *-request 是同一个原因。
func (s *Service) handleLive2DRequest(sc *sio.Socket, args []json.RawMessage) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, ok := decodePayload[roomPayload](args)
	if !ok || payload.RoomID == "" {
		return
	}
	if inRoom, err := s.IsInRoom(ctx, sc.ID, payload.RoomID); err != nil || !inRoom {
		return
	}
	if s.Hub == nil {
		return
	}
	s.Hub.EmitTo(sc.ID, "live2d-snapshot", live2dSnapshotOut{
		RoomID: payload.RoomID,
		Models: live2dRows(s.Live2DSnapshot(payload.RoomID)),
	})
}

// validateLive2DModelURL 校验自定义模型地址，返回空串表示合法。
//
// 只允许 http(s) 与同源绝对路径：Live2D 的 model3.json 会按相对路径再去
// 拉纹理与动作文件，file:/data:/blob: 这类 scheme 在这个场景没有正当用途，
// 而 javascript: 更不能进任何会被当地址使用的地方。
func validateLive2DModelURL(raw string) string {
	if raw == "" {
		return "缺少模型地址"
	}
	if len(raw) > live2dMaxURLLen {
		return "模型地址过长"
	}
	if strings.HasPrefix(raw, "//") {
		return "不支持协议相对地址"
	}
	if strings.HasPrefix(raw, "/") {
		// 同源绝对路径（房主上传的模型就走这个前缀）
		if strings.HasSuffix(strings.ToLower(raw), ".json") {
			return ""
		}
		return "模型地址必须指向 .json"
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "模型地址无效"
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "仅支持 http/https 地址"
	}
	if !strings.HasSuffix(strings.ToLower(u.Path), ".json") {
		return "模型地址必须指向 model3.json"
	}
	return ""
}
