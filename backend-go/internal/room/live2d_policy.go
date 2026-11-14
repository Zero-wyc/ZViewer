package room

import (
	"encoding/json"

	"zviewer/backend/internal/sio"
)

// 房间级的角色（Live2D）策略：房主设，全房间生效。
//
// 为什么放内存而不落库：和「谁选了什么模型」一样，它是一幕里的表现层约定。
// 落库要改 schema.sql（结构唯一事实源）并连带写 db:upgrade 迁移，而这个开关
// 重启后回到默认值没有任何实际损失。
//
// 定位：这是**协作约定**，不是安全边界。客户端遵守它（禁用开关 / 统一模型），
// 改客户端的人最多让自己看到的画面不同，影响不到别人。

// live2dPolicy 是一个房间的角色策略。
type live2dPolicy struct {
	// AllowFace 允许成员开启摄像头动捕。
	AllowFace bool `json:"allowFace"`
	// ShowToViewers 对观众显示角色。关掉时观众端整个不渲染，
	// **房主自己仍然看得到**——否则他也就没法右键打开设置再改回来。
	ShowToViewers bool `json:"showToViewers"`
	// Unified 统一角色：全房间都显示房主选的那个模型。
	Unified bool `json:"unified"`
	// UnifiedKind / UnifiedID 是统一后的模型（kind 同 live2dMember.Kind）。
	UnifiedKind string `json:"unifiedKind,omitempty"`
	UnifiedID   string `json:"unifiedId,omitempty"`
}

// defaultLive2DPolicy 是房间还没有策略时的行为：与加这个功能之前完全一致。
func defaultLive2DPolicy() live2dPolicy {
	return live2dPolicy{AllowFace: true, ShowToViewers: true}
}

// live2dPolicyPayload 是 host 下发的增量：只带要改的字段（nil = 不动）。
type live2dPolicyPayload struct {
	RoomID        string `json:"roomId"`
	AllowFace     *bool  `json:"allowFace"`
	ShowToViewers *bool  `json:"showToViewers"`
	Unified       *bool  `json:"unified"`
	UnifiedKind   string `json:"unifiedKind"`
	UnifiedID     string `json:"unifiedId"`
}

// Policy 读取房间策略（没有则返回默认值）。
func (st *live2dStore) Policy(roomID string) live2dPolicy {
	st.mu.Lock()
	defer st.mu.Unlock()
	if p, ok := st.policies[roomID]; ok {
		return p
	}
	return defaultLive2DPolicy()
}

// SetPolicy 写入房间策略。
func (st *live2dStore) SetPolicy(roomID string, p live2dPolicy) {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.policies[roomID] = p
}

// Live2DPolicy 是 Service 侧读取入口。
func (s *Service) Live2DPolicy(roomID string) live2dPolicy {
	if s == nil || s.live2d == nil {
		return defaultLive2DPolicy()
	}
	return s.live2d.Policy(roomID)
}

func (s *Service) setLive2DPolicy(roomID string, p live2dPolicy) {
	if s == nil || s.live2d == nil {
		return
	}
	s.live2d.SetPolicy(roomID, p)
}

// handleLive2DPolicySet 修改房间策略：仅房主。
//
// 一次请求可以只改一个开关（前端点一下开关就发一个字段），也可以顺带改
// 统一模型（换模型时两个字段一起）。
func (s *Service) handleLive2DPolicySet(sc *sio.Socket, args []json.RawMessage, ack func(...any)) {
	ctx, cancel := handlerCtx()
	defer cancel()

	payload, ok := decodePayload[live2dPolicyPayload](args)
	if !ok || payload.RoomID == "" {
		ackFail(ack, "缺少 roomId")
		return
	}
	if !s.requireHost(ctx, ack, sc, payload.RoomID, "只有房主可以修改房间角色设置") {
		return
	}

	next := s.Live2DPolicy(payload.RoomID)
	if payload.AllowFace != nil {
		next.AllowFace = *payload.AllowFace
	}
	if payload.ShowToViewers != nil {
		next.ShowToViewers = *payload.ShowToViewers
	}
	if payload.Unified != nil {
		next.Unified = *payload.Unified
	}
	if payload.UnifiedID != "" || payload.UnifiedKind != "" {
		kind := payload.UnifiedKind
		if kind == "" {
			kind = "builtin"
		}
		modelID := payload.UnifiedID
		if problem := s.validateLive2DModelRef(payload.RoomID, kind, modelID); problem != "" {
			ackFail(ack, problem)
			return
		}
		next.UnifiedKind = kind
		next.UnifiedID = modelID
	}
	// 打开统一角色却没有可用模型：说得明确一点，别让房间里一半人还是各显示各的。
	if next.Unified && next.UnifiedID == "" {
		ackFail(ack, "请先选择统一使用的模型")
		return
	}

	s.setLive2DPolicy(payload.RoomID, next)
	if s.Hub != nil {
		s.Hub.EmitRoom(payload.RoomID, "live2d-policy", live2dPolicyOut{
			RoomID: payload.RoomID,
			Policy: next,
		})
	}
	ackOK(ack, map[string]any{"policy": next})
}

// live2dPolicyOut 是下行信封：带上 roomId，客户端才能丢弃别的房间的广播
// （宿主组件在切房时会短暂同时存在两个 socket）。
type live2dPolicyOut struct {
	RoomID string       `json:"roomId"`
	Policy live2dPolicy `json:"policy"`
}
