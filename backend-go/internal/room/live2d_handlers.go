package room

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
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
	// Drag 是拖拽偏移行 [sid, dx, dy]。
	//
	// 单开一类而不是塞进 u 行：u 行已经是变长的（末尾可选 m/e），再挂两个
	// 可选字段就解析不出「第 5 项到底是 m 还是 dx」了。
	Drag [][]any `json:"d,omitempty"`
}

type live2dSnapshotOut struct {
	RoomID string  `json:"roomId"`
	Models [][]any `json:"models"`
	// Policy 跟着快照一起下发：新进房的人一次往返就能拿到「谁在场 + 房间规矩」，
	// 不必再为策略单开一次请求。
	Policy live2dPolicy `json:"policy"`
}

// live2dModelRemovedOut 是「你正在用的公共库模型被删了」的通知。
//
// 只带 modelId：客户端自己比对「是不是我在用的那个」，不猜别人的状态——
// 被摘掉的成员已经由同一批的 rem 行从名册里移除，画面先消失、原因随后到。
type live2dModelRemovedOut struct {
	RoomID  string `json:"roomId"`
	ModelID string `json:"modelId"`
}

type live2dConfigPayload struct {
	RoomID  string   `json:"roomId"`
	Action  string   `json:"action"`
	Kind    string   `json:"kind"`
	ModelID string   `json:"modelId"`
	Scale   *float64 `json:"scale"`
}

// live2dActionOut 是一次「瞬时动作」的下行：谁做了什么事。
//
// 有两种，靠字段区分（两者互斥）：
//   - 表情：E = 表情下标；
//   - 动作：G/I = 动作组名与组内下标。
//
// 都只带下标不带名字：同一份 model3.json 在各端解析出的顺序相同，
// 而表情名在导出时经常是空串或重名（官方素材也这样），不可靠。
type live2dActionOut struct {
	RoomID string `json:"roomId"`
	SID    string `json:"sid"`
	E      *int   `json:"e,omitempty"`
	G      string `json:"g,omitempty"`
	I      *int   `json:"i,omitempty"`
}

type live2dActionPayload struct {
	RoomID string `json:"roomId"`
	// E 是指针：缺省与 0 必须区分开（0 是合法的第一个表情）。
	E *int `json:"e"`
	// G/I 是动作（motion）组名与下标，动捕开着时由本人的客户端广播。
	G string `json:"g"`
	I *int   `json:"i"`
}

type live2dStatePayload struct {
	RoomID string   `json:"roomId"`
	X      *float64 `json:"x"`
	Y      *float64 `json:"y"`
	AR     *float64 `json:"a"`
	// Mouth/Eyes 是摄像头动捕的面部姿态，只在动捕开着时出现（见 live2dStateUpdate）。
	Mouth *float64 `json:"m"`
	Eyes  *float64 `json:"e"`
	// Pose 是 [嘴形, 眉毛, 歪头]，0~1 编码。与 m/e 同时出现、同时缺席。
	Pose []float64 `json:"p"`
}

// live2dDragPayload 是拖拽偏移上报：dx/dy 是相对视口宽/高的比例（正数向右/向下）。
//
// 用指针而不是 float64：0 是合法值（拖回原位），缺字段与 0 必须能区分开。
type live2dDragPayload struct {
	RoomID string   `json:"roomId"`
	X      *float64 `json:"x"`
	Y      *float64 `json:"y"`
}

// live2dIdentity 返回「这个人是谁」的稳定标识，用于「一个用户只能有一个角色」。
//
//   - 登录用户用 userId（游客共享 userId=0，不能按其判定，否则全房间游客
//     会互相顶替）；
//   - 游客用 guestId（同一浏览器的多个标签共享它，正好符合"一个用户一个角色"）；
//   - 两者都没有时返回空串，表示无法识别——宁可他多占一格，也不能把两个
//     陌生人合并成一个。
func live2dIdentity(sc *sio.Socket) string {
	if uid := socketUserID(sc); uid != nil && *uid > 0 {
		return "u:" + strconv.FormatInt(*uid, 10)
	}
	if gid := socketGuestID(sc); gid != nil {
		return "g:" + *gid
	}
	return ""
}

// Live2DModelChecker 判断某个模型是否存在（由 api 层注入，避免 room 包碰磁盘）。
//
// 只看 modelId：模型库是**服务端公共**的，与房间号无关——同一套模型任何
// 房间都能选。
type Live2DModelChecker func(modelID string) bool

// SetLive2DModelChecker 注入房间模型库查询（api.New 里挂上）。
func (s *Service) SetLive2DModelChecker(fn Live2DModelChecker) { s.live2dModelExists = fn }

var (
	live2dBuiltinIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,32}$`)
	live2dRoomIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	// live2dMotionGroupPattern 是动作组名的白名单。组名来自 model3.json 的
	// motions 键，实际只会是 Idle/tap_body 这类标识符；限制字符集是为了不让
	// 任何人把任意字符串广播给全房间。
	live2dMotionGroupPattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,32}$`)
)

// live2dRow 把成员压成一行：
// [sid, name, kind, modelId, scale, ord, x, y, ar, mouth, eyes, dragX, dragY,
// form, brow, roll]。
// 快照的 models 与 patch 的 add 共用这个形状，前端只需要一个解析函数。
//
// 末尾两位是拖拽偏移（相对槽位基准的比例），再往后是动捕的表情细节与歪头
// （0~1，0.5 = 中性）。追加在最后是为了让旧客户端只读前面几项也不出错。
func live2dRow(m live2dMember) []any {
	return []any{
		m.SocketID, m.Name, m.Kind, m.ModelID,
		roundTo(m.Scale, 2), m.Ord,
		roundTo(m.X, 3), roundTo(m.Y, 3), roundTo(m.AR, 2),
		roundTo(m.Mouth, 2), roundTo(m.Eyes, 2),
		roundTo(m.DragX, 3), roundTo(m.DragY, 3),
		roundTo(m.Form, 2), roundTo(m.Brow, 2), roundTo(m.Roll, 2),
	}
}

func live2dRows(list []live2dMember) [][]any {
	out := make([][]any, 0, len(list))
	for _, m := range list {
		out = append(out, live2dRow(m))
	}
	return out
}

// live2dStateRow 是合并下行的**紧凑**行：[sid, x, y, ar]，
// 只有对方当前正在动捕时才追加 [m, e, p0, p1, p2]。
//
// 可变长度是刻意的：客户端收到 m/e/p 就会接管模型的嘴、眼、表情与歪头，
// 所以「没有面部数据」必须能和「嘴闭着、眼全睁、中性表情」区分开——否则
// 整个房间的角色都不再眨眼、也不再有自己的小表情。
//
// 三项姿态（嘴形/眉毛/歪头）跟在 m/e 后面而不是新开一类行：它们与 m/e 同源
// （同一帧检测结果）、同频率、同寿命，拆成两行只会多一条可能的乱序路径。
func live2dStateRow(m live2dMember, now time.Time) []any {
	row := []any{m.SocketID, roundTo(m.X, 3), roundTo(m.Y, 3), roundTo(m.AR, 2)}
	if !m.faceAt.IsZero() && now.Sub(m.faceAt) < live2dFaceTTL {
		row = append(row,
			roundTo(m.Mouth, 2), roundTo(m.Eyes, 2),
			roundTo(m.Form, 2), roundTo(m.Brow, 2), roundTo(m.Roll, 2),
		)
	}
	return row
}

// live2dDragRow 是拖拽偏移行：[sid, dx, dy]（相对视口宽/高的比例）。
func live2dDragRow(m live2dMember) []any {
	return []any{m.SocketID, roundTo(m.DragX, 3), roundTo(m.DragY, 3)}
}

func (s *Service) bindLive2D(sc *sio.Socket) {
	sc.On("live2d-config", func(args []json.RawMessage, ack func(...any)) {
		s.handleLive2DConfig(sc, args, ack)
	})
	sc.On("live2d-state", func(args []json.RawMessage, _ func(...any)) {
		s.handleLive2DState(sc, args)
	})
	sc.On("live2d-drag", func(args []json.RawMessage, _ func(...any)) {
		s.handleLive2DDrag(sc, args)
	})
	sc.On("live2d-request", func(args []json.RawMessage, _ func(...any)) {
		s.handleLive2DRequest(sc, args)
	})
	sc.On("live2d-action", func(args []json.RawMessage, _ func(...any)) {
		s.handleLive2DAction(sc, args)
	})
	sc.On("live2d-policy-set", func(args []json.RawMessage, ack func(...any)) {
		s.handleLive2DPolicySet(sc, args, ack)
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

	// 外链模型只开给房主：它会让房间里每个人的浏览器去拉第三方资源，
	// 这个决定不该由普通成员做（kind 的其余校验走共用函数）。
	if kind == "url" {
		if !s.requireHost(ctx, ack, sc, payload.RoomID, "只有房主可以设置自定义模型") {
			return
		}
	}
	if problem := s.validateLive2DModelRef(kind, modelID); problem != "" {
		ackFail(ack, problem)
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
		Identity: live2dIdentity(sc),
		Name:     name,
		Kind:     kind,
		ModelID:  modelID,
		Scale:    scale,
		X:        0.5,
		Y:        0.5,
		AR:       live2dDefaultAR,
		Eyes:     live2dDefaultEyes,
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
	s.Live2DUpdateState(payload.RoomID, sc.ID, live2dStateUpdate{
		X: *payload.X, Y: *payload.Y, AR: ar,
		Mouth: payload.Mouth, Eyes: payload.Eyes,
		Pose: payload.Pose,
	}, time.Now())
}

// handleLive2DDrag 处理「我把自己的角色拖到了别处」。
//
// 和指针一样是热路径（拖动时约 16Hz），所以：不 ack、不查库、不碰
// Service.mu，只写内存 + 置脏，由 100ms 的合并下发带到全房间。
//
// 为什么不复用 live2d-state：那是「注视方向」，每帧都在变、且是连续量；
// 拖拽是低频手势结果，混进同一条事件会让 u 行的形状继续膨胀（它已经带
// 可选的 m/e 了）。分开也更安全——指针丢了顶多是视线不动，位置丢了则是
// 「我把角色挪走了，别人却看到它还在原位」。
func (s *Service) handleLive2DDrag(sc *sio.Socket, args []json.RawMessage) {
	if len(args) == 0 || len(args[0]) > 128 {
		return
	}
	var payload live2dDragPayload
	if err := json.Unmarshal(args[0], &payload); err != nil {
		return
	}
	if payload.RoomID == "" || payload.X == nil || payload.Y == nil {
		return
	}
	// 成员资格来自上一次 live2d-config：没声明过模型的连接不许写偏移，
	// 否则任何人都能凭空改一个不存在成员的"位置"。
	if !s.Live2DHas(payload.RoomID, sc.ID) {
		return
	}
	s.Live2DSetDrag(payload.RoomID, sc.ID, *payload.X, *payload.Y)
}

// handleLive2DAction 处理「我这边触发了表情/动作」，立刻广播给全房间（含自己）。
//
// 为什么不走 live2d-patch 的 100ms 合并：动作是**瞬时事件**，攒 100ms 再发
// 会让表情与点击错开、看起来像卡了一下；而且频率已经被 120ms 门限压住，
// 一人最多 8Hz，直发的量级完全可控。
//
// 只允许操作**自己的**模型：sid 取 socket id，payload 里根本没有 sid 字段。
func (s *Service) handleLive2DAction(sc *sio.Socket, args []json.RawMessage) {
	if len(args) == 0 || len(args[0]) > 256 {
		return
	}
	var payload live2dActionPayload
	if err := json.Unmarshal(args[0], &payload); err != nil {
		return
	}
	if payload.RoomID == "" {
		return
	}

	out := live2dActionOut{RoomID: payload.RoomID, SID: sc.ID}
	switch {
	case payload.E != nil:
		index := *payload.E
		if index < 0 || index > live2dMaxExpressionIndex {
			return
		}
		out.E = &index
	case payload.G != "" && payload.I != nil:
		group := payload.G
		index := *payload.I
		if len(group) > live2dMaxMotionGroupLen || !live2dMotionGroupPattern.MatchString(group) {
			return
		}
		if index < 0 || index > live2dMaxMotionIndex {
			return
		}
		out.G = group
		out.I = &index
	default:
		return
	}

	// 频控 + 成员资格一步完成：没声明模型、或连点太快的都直接丢弃。
	if !s.Live2DAllowAction(payload.RoomID, sc.ID) {
		return
	}
	if s.Hub == nil {
		return
	}
	s.Hub.EmitRoom(payload.RoomID, "live2d-action", out)
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
		Policy: s.Live2DPolicy(payload.RoomID),
	})
}

// validateLive2DModelRef 校验「模型类型 + 标识」是否可用，返回空串表示合法。
//
// 成员声明自己的模型与房主设置「统一角色」共用这一份口径：两处放行的合集
// 必须一致，否则会出现「自己能选、统一时却选不了」这种对不上的情况。
func (s *Service) validateLive2DModelRef(kind, modelID string) string {
	switch kind {
	case "builtin":
		if !live2dBuiltinIDPattern.MatchString(modelID) {
			return "模型标识不合法"
		}
		return ""
	case "url":
		return validateLive2DModelURL(modelID)
	case "room":
		// room = 服务端公共模型库（历史名字，协议里沿用以免老客户端/本地缓存
		// 的 kind 失效）。任何成员都可以选，不构成额外磁盘开销。但必须真的
		// 存在：否则随便填一个 id 就会让房间里所有人加载失败、只剩占位卡。
		if !live2dRoomIDPattern.MatchString(modelID) {
			return "模型标识不合法"
		}
		if s.live2dModelExists != nil && !s.live2dModelExists(modelID) {
			return "该模型已不存在，请重新选择"
		}
		return ""
	default:
		return "不支持的模型类型"
	}
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
