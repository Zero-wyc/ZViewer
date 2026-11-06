// Package voicertc 是自建语音聊天的控制面。
//
// 拓扑是**星形**：房间里每个成员各一条到 SFU 的连接，上行是自己的麦克风，
// 下行是其他所有人的麦克风。媒体层（internal/share/sfu 的 voice 部分）负责
// 真正的转发，这里只做身份、成员表、计划计算与信令透传。
//
// 为什么不像 Piik 那样做「成员互助的树」：Piik 的语音树是给桌面端的多路
// 场景准备的，需要客户端把收到的媒体再转发给别人；ZViewer 的房间上限是
// maxViewers 1..100（默认 10），星形在 11 人时是 11 条连接、约 110 条转发
// 路径，服务端上行带宽约 4 Mbps——完全够用，而且不需要浏览器互相中继。
package voicertc

import (
	"encoding/json"
	"errors"
	"fmt"

	"zviewer/backend/internal/strictjson"
)

// Event 是语音在 socket.io 上的唯一事件名（上下行共用）。
const Event = "voice"

// 客户端 → 服务器的消息类型。
const (
	TypeJoin   = "voice.join"
	TypeLeave  = "voice.leave"
	TypeSignal = "voice.signal"
	TypeMute   = "voice.mute"
	TypeKick   = "voice.kick"
)

// 服务器 → 客户端的消息类型。
const (
	TypeState  = "voice.state"
	TypeMuted  = "voice.muted"
	TypeKicked = "voice.kicked"
	TypeError  = "voice.error"
)

// 错误码。
const (
	CodeInvalidMessage = "INVALID_MESSAGE"
	CodeNoRoom         = "NO_ROOM"
	CodeNotInRoom      = "NOT_IN_ROOM"
	CodeNotHost        = "NOT_HOST"
	CodeNotJoined      = "NOT_JOINED"
	CodePeerNotFound   = "PEER_NOT_FOUND"
	CodeUnavailable    = "VOICE_UNAVAILABLE"
)

// 字段长度上限。房间 id / socket id 都远小于此值，超限即判定为畸形输入。
const (
	maxIDLength    = 128
	maxPayloadSize = 64 * 1024
	maxNameLength  = 64
)

// ErrUnknownType 表示 `t` 不在已知集合里。
var ErrUnknownType = errors.New("unknown voice message type")

// ==================== 客户端消息 ====================

// ClientMessage 是客户端消息的公共接口。
type ClientMessage interface {
	MessageType() string
}

// JoinMessage 加入房间语音。
//
// Name 是展示用的昵称。刻意由客户端自报而不是服务端反查 socket 数据：
// 房间里本来就用客户端自报的 username 展示（viewer-joined 同源），
// 这里保持一致，不额外引入一条只有语音才走的身份解析路径。
type JoinMessage struct {
	T      string `json:"t"`
	RoomID string `json:"roomId"`
	Name   string `json:"name"`
}

func (m JoinMessage) MessageType() string { return m.T }

// LeaveMessage 退出房间语音（不断开 socket）。
type LeaveMessage struct {
	T      string `json:"t"`
	RoomID string `json:"roomId"`
}

func (m LeaveMessage) MessageType() string { return m.T }

// SignalMessage 透传 SFU 的 SDP / ICE。`kind` 只允许 description | candidate。
type SignalMessage struct {
	T            string          `json:"t"`
	RoomID       string          `json:"roomId"`
	ConnectionID string          `json:"connectionId"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
}

func (m SignalMessage) MessageType() string { return m.T }

// MuteMessage 是房主对某个成员的强制静音。
type MuteMessage struct {
	T      string `json:"t"`
	RoomID string `json:"roomId"`
	PeerID string `json:"peerId"`
	Muted  bool   `json:"muted"`
}

func (m MuteMessage) MessageType() string { return m.T }

// KickMessage 把某个成员移出语音。
type KickMessage struct {
	T      string `json:"t"`
	RoomID string `json:"roomId"`
	PeerID string `json:"peerId"`
}

func (m KickMessage) MessageType() string { return m.T }

// ==================== 服务器消息 ====================

// ServerMessage 是服务器消息的公共接口。
type ServerMessage interface {
	MessageType() string
}

// Member 是成员表的一行。
type Member struct {
	PeerID string `json:"peerId"`
	// Name 是展示昵称（客户端自报，可能为空）。
	Name string `json:"name,omitempty"`
	// ConnectionID 是这条成员在 SFU 上的连接身份（下发给本人，用于给信令打标）。
	ConnectionID string `json:"connectionId,omitempty"`
	// Publishing 表示这位成员正在发布麦克风。
	Publishing bool `json:"publishing"`
	// Muted 是**他人视角**的静音状态（房主强制静音或本人自报）。
	Muted bool `json:"muted"`
}

// SelfState 是「我自己」的那份身份。
type SelfState struct {
	PeerID       string `json:"peerId"`
	ConnectionID string `json:"connectionId"`
	Muted        bool   `json:"muted"`
}

// StateMessage 是一次完整的语音状态快照。客户端收到它即丢弃本地旧态。
type StateMessage struct {
	T        string    `json:"t"`
	RoomID   string    `json:"roomId"`
	Revision int64     `json:"revision"`
	Self     SelfState `json:"self"`
	HostPeer string    `json:"hostPeerId"`
	Members  []Member  `json:"members"`
}

func (m StateMessage) MessageType() string { return m.T }

// SignalOutMessage 把 SFU 的 SDP / ICE 送进某条连接。
type SignalOutMessage struct {
	T            string          `json:"t"`
	RoomID       string          `json:"roomId"`
	ConnectionID string          `json:"connectionId"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
}

func (m SignalOutMessage) MessageType() string { return m.T }

// MutedMessage 广播某个成员的静音状态变化。
type MutedMessage struct {
	T      string `json:"t"`
	RoomID string `json:"roomId"`
	PeerID string `json:"peerId"`
	Muted  bool   `json:"muted"`
}

func (m MutedMessage) MessageType() string { return m.T }

// KickedMessage 通知被移出语音的成员（也广播给其他人）。
type KickedMessage struct {
	T      string `json:"t"`
	RoomID string `json:"roomId"`
	PeerID string `json:"peerId"`
	Reason string `json:"reason"`
}

func (m KickedMessage) MessageType() string { return m.T }

// ErrorMessage 回报一次失败。语音的 `voice` 事件同样是即发即忘，
// 没有 ack 通道，所以失败必须显式下发。
type ErrorMessage struct {
	T       string `json:"t"`
	RoomID  string `json:"roomId"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (m ErrorMessage) MessageType() string { return m.T }

// ==================== 严格解码 ====================

func typeOf(data []byte) (string, error) {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(data, &probe); err != nil {
		return "", err
	}
	raw, ok := probe["t"]
	if !ok {
		return "", ErrUnknownType
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", ErrUnknownType
	}
	return value, nil
}

// DecodeClient 把一帧解码成具体的客户端消息。
//
// 所有失败都是拒绝，不做任何降级：未知 `t`、未知字段、缺必填字段都会返回错误。
func DecodeClient(data []byte) (ClientMessage, error) {
	if len(data) > strictjson.MaxFrameBytes {
		return nil, fmt.Errorf("voice frame exceeds %d bytes", strictjson.MaxFrameBytes)
	}
	name, err := typeOf(data)
	if err != nil {
		return nil, err
	}
	switch name {
	case TypeJoin:
		var message JoinMessage
		raw, err := strictjson.Decode(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.Require("t", "roomId"); err != nil {
			return nil, err
		}
		if message.RoomID == "" || len(message.RoomID) > maxIDLength {
			return nil, errors.New("roomId is invalid")
		}
		if len(message.Name) > maxNameLength {
			return nil, errors.New("name is too long")
		}
		return message, nil
	case TypeLeave:
		var message LeaveMessage
		raw, err := strictjson.Decode(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.Require("t", "roomId"); err != nil {
			return nil, err
		}
		if message.RoomID == "" || len(message.RoomID) > maxIDLength {
			return nil, errors.New("roomId is invalid")
		}
		return message, nil
	case TypeSignal:
		var message SignalMessage
		raw, err := strictjson.Decode(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.Require("t", "roomId", "connectionId", "kind", "payload"); err != nil {
			return nil, err
		}
		if message.Kind != "description" && message.Kind != "candidate" {
			return nil, errors.New("kind is invalid")
		}
		if len(message.ConnectionID) > maxIDLength || len(message.Payload) > maxPayloadSize {
			return nil, errors.New("signal is too large")
		}
		return message, nil
	case TypeMute:
		var message MuteMessage
		raw, err := strictjson.Decode(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.Require("t", "roomId", "peerId", "muted"); err != nil {
			return nil, err
		}
		if message.PeerID == "" || len(message.PeerID) > maxIDLength {
			return nil, errors.New("peerId is invalid")
		}
		return message, nil
	case TypeKick:
		var message KickMessage
		raw, err := strictjson.Decode(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.Require("t", "roomId", "peerId"); err != nil {
			return nil, err
		}
		if message.PeerID == "" || len(message.PeerID) > maxIDLength {
			return nil, errors.New("peerId is invalid")
		}
		return message, nil
	default:
		return nil, ErrUnknownType
	}
}
