// Package share 实现屏幕共享的控制面：严格信封、共享代际、路由版本与参与者快照。
//
// 结构与常量语义取自 Piik（MIT）的 internal/server/protocol：
//   - 一帧 = 一个 JSON 对象，`t` 字段做判别式；
//   - 未知字段、未知 `t` 一律拒绝，不做「宽容解码」；
//   - 单帧上限 64KiB（Piik protocol/constants.go:20）。
//
// 与 Piik 的两处差异是刻意的：
//  1. 复用现有 socket.io 的单一 `share` 事件，不另开 WebSocket ——
//     internal/sio 不支持命名空间，双连接还要额外解决身份关联。
//  2. 每条消息显式带 `roomId`。ZViewer 的一条连接可能同时属于多个房间
//     （评论独立窗口会 join 额外的房间），无法像 Piik 那样由会话隐含唯一房间。
package share

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
)

// Event 是屏幕共享在 socket.io 上的唯一事件名（上下行共用）。
const Event = "share"

// MaxFrameBytes 是单帧上限，对齐 Piik 的 64KiB。
//
// SDP 与 ICE 都是小对象；超过这个体量基本可以判定是畸形输入或攻击。
const MaxFrameBytes = 64 * 1024

// 客户端 → 服务器的消息类型。
const (
	TypeHello              = "share.hello"
	TypeStart              = "share.start"
	TypeStop               = "share.stop"
	TypePause              = "share.pause"
	TypeRouteReady         = "share.route-ready"
	TypeTransportConnected = "share.transport-connected"
	TypeRouteFailed        = "share.route-failed"
	TypeRestart            = "share.restart"
	TypeSignal             = "share.signal"
	TypeSFUSignal          = "share.sfu-signal"
)

// 服务器 → 客户端的消息类型。
const (
	TypeSnapshot    = "share.snapshot"
	TypeRoute       = "share.route"
	TypeStatus      = "share.status"
	TypeSFUConfig   = "share.sfu-config"
	TypeSignalRelay = "share.signal-relay"
	// TypeError 是本实现新增的唯一消息（Piik 用 error/INVALID_MESSAGE）。
	// 加它是因为 ZViewer 的 `share` 事件是即发即忘，没有 ack 通道回报失败。
	TypeError = "share.error"
)

// 错误码。语义对齐 Piik server.go / session.go 的对应分支。
const (
	CodeInvalidMessage     = "INVALID_MESSAGE"
	CodeNoRoom             = "NO_ROOM"
	CodeForbidden          = "FORBIDDEN"
	CodeGenerationReplaced = "SHARING_GENERATION_REPLACED"
	CodeNotImplemented     = "NOT_IMPLEMENTED"
)

// 路由阶段。只有两个值（Piik types.go:39 的 mediaRoutePhases）。
const (
	PhasePrepare = "prepare"
	PhaseActive  = "active"
)

// 状态组合。只允许两种（Piik server.go:117），不要自创第三种。
const (
	StatusWaiting = "waiting"
	StatusFailed  = "failed"

	ReasonSFUAdmission     = "sfu-admission"
	ReasonRouteExhausted   = "route-exhausted"
	ReasonRelayUnreachable = "relay-unreachable"
	ReasonRelayDisabled    = "relay-disabled"
)

// 信令种类。
const (
	SignalOffer     = "offer"
	SignalAnswer    = "answer"
	SignalCandidate = "candidate"
)

// QualitySettings 是房主侧的采集/编码档位。
//
// P0 只做存储与回显，服务端不据此施加任何约束；P1 起房主用它设置
// encodings，服务端只在快照里原样回传。
type QualitySettings struct {
	ResolutionPreset string  `json:"resolutionPreset"`
	FrameRate        int     `json:"frameRate"`
	MaxBitrateMbps   float64 `json:"maxBitrateMbps"`
}

// Participant 是一个共享参与者。
//
// P0 的 peerId 就是 socketId（Piik 用的是跨重连稳定的 clientId）；
// P1 引入稳定 peerId 后，PeerID 与 SocketID 会分开。
type Participant struct {
	PeerID      string `json:"peerId"`
	SocketID    string `json:"socketId"`
	Role        string `json:"role"` // host | viewer
	DisplayName string `json:"displayName,omitempty"`
	MediaReady  bool   `json:"mediaReady"`
}

// 参与者角色。
const (
	RoleHost   = "host"
	RoleViewer = "viewer"
)

// Candidate 是一条待建立的路由候选。
//
// P0 不产生候选（路由在 P1 才接上），类型先冻结，避免 P1 再改线上格式。
type Candidate struct {
	ChildPeerID  string `json:"childPeerId"`
	ConnectionID string `json:"connectionId"`
	Transport    string `json:"transport"` // direct | relay
}

// Assignment 是已提交的路由分配。
type Assignment struct {
	Revision   int64       `json:"revision"`
	Phase      string      `json:"phase"`
	Candidates []Candidate `json:"candidates"`
}

// ==================== 客户端消息 ====================

// ClientMessage 是客户端消息的公共接口。
type ClientMessage interface {
	// MessageType 返回 `t` 的值。
	MessageType() string
}

// HelloMessage 建立共享会话并取回快照。
//
// ShareGeneration 可选：带上它表示「我知道上一次的代际」，服务端据此决定
// 是延续还是重新开一代。
type HelloMessage struct {
	T               string  `json:"t"`
	RoomID          string  `json:"roomId"`
	ShareGeneration *string `json:"shareGeneration,omitempty"`
}

// MessageType 实现 ClientMessage。
func (m HelloMessage) MessageType() string { return m.T }

// StartMessage 让房主开始共享。
type StartMessage struct {
	T               string           `json:"t"`
	RoomID          string           `json:"roomId"`
	ShareGeneration *string          `json:"shareGeneration,omitempty"`
	Paused          *bool            `json:"paused,omitempty"`
	QualitySettings *QualitySettings `json:"qualitySettings,omitempty"`
}

// MessageType 实现 ClientMessage。
func (m StartMessage) MessageType() string { return m.T }

// StopMessage 结束共享。
type StopMessage struct {
	T               string `json:"t"`
	RoomID          string `json:"roomId"`
	ShareGeneration string `json:"shareGeneration"`
}

// MessageType 实现 ClientMessage。
func (m StopMessage) MessageType() string { return m.T }

// PauseMessage 暂停/恢复共享。Paused 用指针是为了区分「没传」与 false。
type PauseMessage struct {
	T               string `json:"t"`
	RoomID          string `json:"roomId"`
	ShareGeneration string `json:"shareGeneration"`
	Paused          *bool  `json:"paused"`
}

// MessageType 实现 ClientMessage。
func (m PauseMessage) MessageType() string { return m.T }

// RouteReadyMessage 表示客户端认为候选已就绪。
//
// Piik 的 handleRouteReady 只接受 phase=="prepare"（router.go:796-846）；
// transport-connected 只是进度。这个区分不能合并。
type RouteReadyMessage struct {
	T            string `json:"t"`
	RoomID       string `json:"roomId"`
	Revision     int64  `json:"revision"`
	Phase        string `json:"phase"`
	ConnectionID string `json:"connectionId,omitempty"`
}

// MessageType 实现 ClientMessage。
func (m RouteReadyMessage) MessageType() string { return m.T }

// TransportConnectedMessage 只上报「传输层连上了」，不提交路由。
type TransportConnectedMessage struct {
	T            string `json:"t"`
	RoomID       string `json:"roomId"`
	Revision     int64  `json:"revision"`
	ConnectionID string `json:"connectionId"`
}

// MessageType 实现 ClientMessage。
func (m TransportConnectedMessage) MessageType() string { return m.T }

// RouteFailedMessage 上报候选失败，服务端据此换下一个候选。
type RouteFailedMessage struct {
	T            string `json:"t"`
	RoomID       string `json:"roomId"`
	Revision     int64  `json:"revision"`
	Phase        string `json:"phase"`
	ConnectionID string `json:"connectionId"`
}

// MessageType 实现 ClientMessage。
func (m RouteFailedMessage) MessageType() string { return m.T }

// RestartMessage 是观众发起的恢复请求（只有观众能发）。
type RestartMessage struct {
	T            string `json:"t"`
	RoomID       string `json:"roomId"`
	ConnectionID string `json:"connectionId"`
	// Rebuild 为 true 时销毁重建，而不是 ICE restart。
	// Piik 的规则：第 2 次恢复才 rebuild（viewer-peer.ts:518）。
	Rebuild bool `json:"rebuild"`
}

// MessageType 实现 ClientMessage。
func (m RestartMessage) MessageType() string { return m.T }

// SignalMessage 中继一条 SDP 或 ICE。
type SignalMessage struct {
	T            string          `json:"t"`
	RoomID       string          `json:"roomId"`
	ConnectionID string          `json:"connectionId"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
}

// MessageType 实现 ClientMessage。
func (m SignalMessage) MessageType() string { return m.T }

// SFUSignalMessage 是中继侧（publication/subscription）的信令。
type SFUSignalMessage struct {
	T                     string          `json:"t"`
	RoomID                string          `json:"roomId"`
	Revision              int64           `json:"revision"`
	PublicationGeneration string          `json:"publicationGeneration"`
	ConnectionID          string          `json:"connectionId"`
	Kind                  string          `json:"kind"` // description | candidate | media | layers | subscribe
	Payload               json.RawMessage `json:"payload,omitempty"`
	ActiveCount           *int            `json:"activeCount,omitempty"`
}

// MessageType 实现 ClientMessage。
func (m SFUSignalMessage) MessageType() string { return m.T }

// ==================== 服务器消息 ====================

// ServerMessage 是服务器消息的公共接口。
type ServerMessage interface {
	// MessageType 返回 `t` 的值。
	MessageType() string
}

// SnapshotMessage 是一次完整的共享状态快照。客户端收到它即丢弃本地旧态。
type SnapshotMessage struct {
	T               string          `json:"t"`
	RoomID          string          `json:"roomId"`
	ShareGeneration string          `json:"shareGeneration"`
	Revision        int64           `json:"revision"`
	Paused          bool            `json:"paused"`
	Sharing         bool            `json:"sharing"`
	QualitySettings QualitySettings `json:"qualitySettings"`
	Participants    []Participant   `json:"participants"`
	Assignment      *Assignment     `json:"assignment,omitempty"`
}

// MessageType 实现 ServerMessage。
func (m SnapshotMessage) MessageType() string { return m.T }

// RouteMessage 下发路由阶段变化与候选。
type RouteMessage struct {
	T          string     `json:"t"`
	RoomID     string     `json:"roomId"`
	Revision   int64      `json:"revision"`
	Phase      string     `json:"phase"`
	Assignment Assignment `json:"assignment"`
	Candidate  *Candidate `json:"candidate,omitempty"`
}

// MessageType 实现 ServerMessage。
func (m RouteMessage) MessageType() string { return m.T }

// StatusMessage 下发「还在等」或「彻底失败」。只有两种组合。
type StatusMessage struct {
	T        string `json:"t"`
	RoomID   string `json:"roomId"`
	Revision int64  `json:"revision"`
	State    string `json:"state"`
	Reason   string `json:"reason"`
}

// MessageType 实现 ServerMessage。
func (m StatusMessage) MessageType() string { return m.T }

// SFUConfigMessage 通知房主「中继可用，用这个 connectionId 建发布端」。
type SFUConfigMessage struct {
	T                     string `json:"t"`
	RoomID                string `json:"roomId"`
	Revision              int64  `json:"revision"`
	PublicationGeneration string `json:"publicationGeneration"`
	ConnectionID          string `json:"connectionId"`
}

// MessageType 实现 ServerMessage。
func (m SFUConfigMessage) MessageType() string { return m.T }

// SignalRelayMessage 把对端的 SDP/ICE 转发给本端。
type SignalRelayMessage struct {
	T            string          `json:"t"`
	RoomID       string          `json:"roomId"`
	FromPeerID   string          `json:"fromPeerId"`
	ConnectionID string          `json:"connectionId"`
	Kind         string          `json:"kind"`
	Payload      json.RawMessage `json:"payload"`
}

// MessageType 实现 ServerMessage。
func (m SignalRelayMessage) MessageType() string { return m.T }

// ErrorMessage 回报一次失败。ZViewer 的 share 事件没有 ack，只能靠它。
type ErrorMessage struct {
	T       string `json:"t"`
	RoomID  string `json:"roomId,omitempty"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// MessageType 实现 ServerMessage。
func (m ErrorMessage) MessageType() string { return m.T }

// ==================== 严格解码 ====================

// ErrUnknownType 表示 `t` 不在已知集合里。
var ErrUnknownType = errors.New("unknown share message type")

// fields 保存一个 JSON 对象的原始成员，用于区分「缺省」与「null」。
//
// encoding/json 单独做不到这件事：`*T` 的 nil 既可能是缺省也可能是 null。
// 重复键折叠成最后一个，与 JSON.parse 行为一致。
type fields map[string]json.RawMessage

// decodeObject 严格解码一个对象：拒绝未知键，并返回原始成员表。
//
// 与 Piik protocol/codec.go:29-55 一致，包括「先按 json tag 收集已知键，
// 再 DisallowUnknownFields 二次解码」这一步——Go 的 struct 解码还接受
// 大小写折叠的名字，必须提前挡掉，否则 `RoomId` 能绕过 `roomId`。
func decodeObject(data []byte, target any) (fields, error) {
	var raw fields
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	targetType := reflect.TypeOf(target).Elem()
	known := make(map[string]struct{}, targetType.NumField())
	for index := range targetType.NumField() {
		name, _, _ := strings.Cut(targetType.Field(index).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			known[name] = struct{}{}
		}
	}
	for name := range raw {
		if _, ok := known[name]; !ok {
			return nil, fmt.Errorf("unknown field %q", name)
		}
	}
	// 重复键只保留最后一个，与 JSON.parse 一致，也避免前面的值进到严格解码。
	canonical, err := json.Marshal(raw)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(canonical))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return nil, err
	}
	return raw, nil
}

// marshalJSON 编码时不转义 HTML 字符（与 JSON.stringify 一致，昵称可能带 < > &）。
func marshalJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}

func (f fields) has(key string) bool {
	_, ok := f[key]
	return ok
}

func (f fields) isNull(key string) bool {
	raw, ok := f[key]
	return ok && string(bytes.TrimSpace(raw)) == "null"
}

// require 要求键存在且不为 null（对应 zod 的必填字段）。
func (f fields) require(keys ...string) error {
	for _, key := range keys {
		if !f.has(key) {
			return fmt.Errorf("%s is required", key)
		}
		if f.isNull(key) {
			return fmt.Errorf("%s must not be null", key)
		}
	}
	return nil
}

// typeOf 只读判别式，不做严格校验（对应 zod 尝试每个 union 成员）。
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
	if len(data) > MaxFrameBytes {
		return nil, fmt.Errorf("share frame exceeds %d bytes", MaxFrameBytes)
	}
	name, err := typeOf(data)
	if err != nil {
		return nil, err
	}
	switch name {
	case TypeHello:
		var message HelloMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId"); err != nil {
			return nil, err
		}
		return message, nil
	case TypeStart:
		var message StartMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId"); err != nil {
			return nil, err
		}
		return message, nil
	case TypeStop:
		var message StopMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "shareGeneration"); err != nil {
			return nil, err
		}
		return message, nil
	case TypePause:
		var message PauseMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "shareGeneration", "paused"); err != nil {
			return nil, err
		}
		return message, nil
	case TypeRouteReady:
		var message RouteReadyMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "revision", "phase"); err != nil {
			return nil, err
		}
		if message.Phase != PhasePrepare && message.Phase != PhaseActive {
			return nil, fmt.Errorf("invalid phase %q", message.Phase)
		}
		return message, nil
	case TypeTransportConnected:
		var message TransportConnectedMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "revision", "connectionId"); err != nil {
			return nil, err
		}
		return message, nil
	case TypeRouteFailed:
		var message RouteFailedMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "revision", "phase", "connectionId"); err != nil {
			return nil, err
		}
		return message, nil
	case TypeRestart:
		var message RestartMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "connectionId", "rebuild"); err != nil {
			return nil, err
		}
		return message, nil
	case TypeSignal:
		var message SignalMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "connectionId", "kind", "payload"); err != nil {
			return nil, err
		}
		switch message.Kind {
		case SignalOffer, SignalAnswer, SignalCandidate:
		default:
			return nil, fmt.Errorf("invalid signal kind %q", message.Kind)
		}
		return message, nil
	case TypeSFUSignal:
		var message SFUSignalMessage
		raw, err := decodeObject(data, &message)
		if err != nil {
			return nil, err
		}
		if err := raw.require("t", "roomId", "revision", "publicationGeneration", "connectionId", "kind"); err != nil {
			return nil, err
		}
		return message, nil
	default:
		return nil, fmt.Errorf("%w: %q", ErrUnknownType, name)
	}
}

// Encode 把一条服务器消息编码成线上字节。
func Encode(message ServerMessage) ([]byte, error) {
	return marshalJSON(message)
}
