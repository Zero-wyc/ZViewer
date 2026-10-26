package room

import (
	"encoding/json"
	"net"
	"net/url"
	"strings"

	"zviewer/backend/internal/nms"
	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// 本地 CLI 代理、播放预览源与投屏子模式切换（5 个事件）。
//
// 这几个模块原本分属 cli / movie.preview / stream-push 三个处理器，
// 但每个都只有一个事件、逻辑十几行——单独建文件反而是噪声，
// 按「附着在房间上的零散能力」收在一处，事件名与行为仍与 Node 逐一对应。

// cliAgentsRoom 是 CLI 代理的聚合房间（只用于列表查询，不涉及用户房间）。
const cliAgentsRoom = "__cli-agents__"

// cliAgentInfo 是下发到前端 cliAgentStore 的代理信息。
//
// agent / version / user 用指针 + omitempty：Node 里可能是 undefined，
// 下发 null 会让前端「按 user 过滤」的 `agent.user === myName` 判断
// 从「无归属」变成「无归属但键存在」，虽然结果一样，但对拍会看到差异。
type cliAgentInfo struct {
	SocketID string  `json:"socketId"`
	ProxyURL string  `json:"proxyUrl"`
	Agent    *string `json:"agent,omitempty"`
	Version  *string `json:"version,omitempty"`
	User     *string `json:"user,omitempty"`
}

// bindMisc 注册 CLI 代理、预览源、子模式切换与推流可用性查询。
func (s *Service) bindMisc(sc *sio.Socket) {
	sc.On("cli-register", func(args []json.RawMessage, ack func(...any)) {
		s.handleCliRegister(sc, args)
	})
	sc.On("cli-list-agents", func(args []json.RawMessage, ack func(...any)) {
		s.handleCliListAgents(sc, args)
	})
	sc.On("play-preview-source", func(args []json.RawMessage, ack func(...any)) {
		s.handlePlayPreviewSource(sc, args, ack)
	})
	sc.On("update-share-method", func(args []json.RawMessage, ack func(...any)) {
		s.handleUpdateShareMethod(sc, args, ack)
	})
	sc.On("query-stream-push-availability", func(_ []json.RawMessage, ack func(...any)) {
		ackOK(ack, map[string]any{"available": s.NMS.Available()})
	})
	// CLI 代理断开：全局广播下线。必须挂在断线回调里（Node 的 CliHandler
	// 同样监听 disconnect），且要在连接被服务端索引移除之后仍能读到
	// cliAgent——所以走 socket 自己的 GetData，不走 Hub.SocketData。
	sc.OnDisconnect(func(_ string) {
		v, ok := sc.GetData("cliAgent")
		if !ok {
			return
		}
		info, ok := v.(cliAgentInfo)
		if !ok {
			return
		}
		s.Hub.EmitGlobal("cli-agent-unavailable", map[string]any{"socketId": info.SocketID})
		s.Logger.Printf("[CLI] 代理下线: socketId=%s", info.SocketID)
	})
}

// ===========================================================================
// CLI 代理
// ===========================================================================

// normalizeLocalCliProxyURL 把 CLI 上报的 proxyUrl 归一化成 127.0.0.1。
//
// 本地 CLI 的 HTTP 代理始终跑在当前机器上，浏览器应直接请求 127.0.0.1。
// 旧版 CLI 有时会把页面 host 或后端 host 当 proxyUrl 上报，导致前端
// 跨域失败——统一在这里改掉 hostname，保留端口与路径。
func normalizeLocalCliProxyURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	if port := u.Port(); port != "" {
		u.Host = net.JoinHostPort("127.0.0.1", port)
	} else {
		u.Host = "127.0.0.1"
	}
	return u.String()
}

// handleCliRegister 处理 CLI 代理注册（全局注册，不绑定房间）。
//
// 这条事件**没有 ack**：Node 侧 `socket.on('cli-register', (payload) => ...)`
// 就两个参数，失败信息走 cli-error 事件。这里同样不回 ack。
func (s *Service) handleCliRegister(sc *sio.Socket, args []json.RawMessage) {
	// 校验是否为 CLI 代理（由握手鉴权写入 socket.data.isCliAgent）
	if v, ok := sc.GetData("isCliAgent"); !ok || v != true {
		s.Hub.EmitTo(sc.ID, "cli-error", map[string]any{"message": "未授权的 CLI 代理连接"})
		return
	}

	raw := firstObject(args)
	proxyURL, ok := jsonStringField(raw, "proxyUrl")
	if !ok || proxyURL == "" {
		s.Hub.EmitTo(sc.ID, "cli-error", map[string]any{"message": "缺少 proxyUrl"})
		return
	}

	normalized := normalizeLocalCliProxyURL(proxyURL)

	info := cliAgentInfo{SocketID: sc.ID, ProxyURL: normalized}
	if v, ok := jsonStringField(raw, "agent"); ok {
		info.Agent = &v
	}
	if v, ok := jsonStringField(raw, "version"); ok {
		info.Version = &v
	}
	if v, ok := jsonStringField(raw, "user"); ok {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			info.User = &trimmed
		}
	}
	sc.SetData("cliAgent", info)

	// 加入聚合房间（替代旧的按用户房间 join），供 cli-list-agents 遍历。
	sc.Join(cliAgentsRoom)

	s.Hub.EmitTo(sc.ID, "cli-registered", map[string]any{})
	// 全局广播：所有房间的前端都能看到，各自按用户名过滤。
	s.Hub.EmitGlobal("cli-agent-available", info)

	s.Logger.Printf("[CLI] 代理注册: socketId=%s user=%s proxyUrl=%s",
		sc.ID, derefString(info.User), normalized)
}

// handleCliListAgents 返回服务器上所有已注册的 CLI 代理。
//
// 参数**只有当它本身就是字符串**时才回显成 roomId（旧前端传的是
// `emit('cli-list-agents', roomId)`，即一个裸字符串）。传对象或什么都不传
// 时 payload 里没有 roomId 键——Node 侧是 `typeof roomId === 'string'`，
// 传 `{ roomId }` 反而不满足。
func (s *Service) handleCliListAgents(sc *sio.Socket, args []json.RawMessage) {
	agents := make([]cliAgentInfo, 0, 4)
	for _, id := range s.Hub.SocketIDs(cliAgentsRoom) {
		data := s.Hub.SocketData(id)
		if data == nil {
			continue
		}
		switch v := data["cliAgent"].(type) {
		case cliAgentInfo:
			agents = append(agents, v)
		case *cliAgentInfo:
			if v != nil {
				agents = append(agents, *v)
			}
		}
	}

	payload := map[string]any{"agents": agents}
	if len(args) > 0 && !isJSONNull(args[0]) {
		var roomID string
		if err := json.Unmarshal(args[0], &roomID); err == nil && roomID != "" {
			payload["roomId"] = roomID
		}
	}
	s.Hub.EmitTo(sc.ID, "cli-agents", payload)
}

// ===========================================================================
// 播放预览源
// ===========================================================================

// handlePlayPreviewSource 处理房主播放预览源（不写入影片列表）。
//
// 预览只广播播放状态、清空 currentMovieId：预览源不持久化，若不清理，
// 观众端会以为「列表里那部影片在播」，切回正式影片时状态错乱。
func (s *Service) handlePlayPreviewSource(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	if raw == nil {
		// Node 侧 payload 为 null 时读 payload.roomId 抛错 → 「处理失败」
		ackFail(ack, "处理失败")
		return
	}
	roomID, ok := jsonStringField(raw, "roomId")
	if !ok {
		ackFail(ack, "处理失败")
		return
	}

	allowed, err := s.IsRoomHostOrModerator(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[play-preview-source] 权限判定失败: %v", err)
		ackFail(ack, "处理失败")
		return
	}
	if !allowed {
		ackFail(ack, "无权限播放影片")
		return
	}

	s.SetCurrentMovie(roomID, nil)

	payload := map[string]any{}
	if v, ok := raw["source"]; ok && !isJSONNull(v) {
		var src any
		if err := json.Unmarshal(v, &src); err == nil {
			payload["source"] = src
		}
	}
	s.Hub.EmitRoom(roomID, "preview-source", payload)
	ackOK(ack, nil)
}

// ===========================================================================
// 投屏子模式（webrtc ↔ stream-push）
// ===========================================================================
//
// 推流码生成与「NMS 在不在」都收在 internal/nms：REST 的 OBS 配置端点与
// 这里的 socket 事件必须给出同一个答案，各写一份迟早会出现
// 「事件说不可用、接口却给了推流码」的错位。

// handleUpdateShareMethod 处理房主切换投屏子模式。
func (s *Service) handleUpdateShareMethod(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	raw := firstObject(args)
	if raw == nil {
		ackFail(ack, "切换子模式失败")
		return
	}
	roomID, ok := jsonStringField(raw, "roomId")
	if !ok {
		ackFail(ack, "切换子模式失败")
		return
	}

	host, err := s.IsRoomHost(ctx, sc.ID, roomID)
	if err != nil {
		s.Logger.Printf("[update-share-method] 权限判定失败: %v", err)
		ackFail(ack, "切换子模式失败")
		return
	}
	if !host {
		ackFail(ack, "无权限：仅房主可切换子模式")
		return
	}

	room, err := s.Rooms.FindByRoomID(ctx, roomID)
	if err != nil {
		if err == store.ErrRoomNotFound {
			ackFail(ack, "房间不存在")
			return
		}
		s.Logger.Printf("[update-share-method] 读取房间失败: %v", err)
		ackFail(ack, "切换子模式失败")
		return
	}
	if room.Mode != "screen-share" {
		ackFail(ack, "仅投屏模式支持子模式切换")
		return
	}

	shareMethod, ok := jsonStringField(raw, "shareMethod")
	if !ok {
		// 缺失时 Node 会把 undefined 写进 room.shareMethod，数据库 CHECK
		// 约束拒绝 → catch → 「切换子模式失败」。显式归一为同一文案。
		ackFail(ack, "切换子模式失败")
		return
	}

	// 切到 stream-push 前校验 NMS 是否可用（不可用时提示管理员）。
	if shareMethod == "stream-push" && !s.NMS.Available() {
		ackFail(ack, "推流服务不可用，请联系管理员检查 NMS 配置")
		return
	}

	// 切到 stream-push 时补一个推流码（已有则复用，别覆盖 OBS 里填好的值）。
	var newKey *string
	if shareMethod == "stream-push" && (room.StreamKey == nil || *room.StreamKey == "") {
		k := nms.GenerateStreamKey()
		newKey = &k
	}
	if err := s.Rooms.SetShareMethod(ctx, roomID, shareMethod, newKey); err != nil {
		s.Logger.Printf("[update-share-method] 写入失败: %v", err)
		ackFail(ack, "切换子模式失败")
		return
	}

	streamKey := room.StreamKey
	if newKey != nil {
		streamKey = newKey
	}

	s.Hub.EmitRoom(roomID, "share-method-changed", map[string]any{
		"roomId":      roomID,
		"shareMethod": shareMethod,
	})
	ackOK(ack, map[string]any{
		"shareMethod": shareMethod,
		"streamKey":   streamKey,
	})
}

// trimSpace 已由 strings.TrimSpace 覆盖，这里不再自实现。
