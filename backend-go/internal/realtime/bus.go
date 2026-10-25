// Package realtime 定义「服务端向房间广播事件」的契约。
//
// 生产实现是 SocketHub（`siohub.go`，建立在自研的 `internal/sio` 之上）：
// REST 处理器按真实事件名与载荷调用本接口，与 socket 事件走同一条广播路径。
//
// Noop 只在「最小装配」时兜底（单测、或没注入 Hub 的构造）：事件被丢弃，
// 但接口行为（校验、落库、响应码）不受影响。**生产路径上永远不会是 Noop**。
package realtime

// Bus 是房间事件广播器。
type Bus interface {
	// EmitRoom 向 roomID 房间内的所有连接推送一个具名事件。
	EmitRoom(roomID, event string, payload any)
}

// Node 版存在的事件名。集中定义，避免手写字符串出现拼写漂移。
const (
	EventRoomNameUpdated     = "room-name-updated"
	EventDanmakuTracksUpdate = "danmaku-tracks-updated"
	EventDanmakuMetaUpdated  = "danmaku-meta-updated"
)

// Noop 丢弃所有事件。
type Noop struct{}

// EmitRoom 实现 Bus，什么也不做。
func (Noop) EmitRoom(string, string, any) {}
