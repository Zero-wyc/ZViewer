// Package realtime 定义「服务端向房间广播事件」的契约。
//
// Node 版这些事件都由 socket.io 发出（io.to(roomId).emit(...)），而 socket.io
// 那层尚未迁移到 Go。REST 处理器仍然按真实事件名与载荷调用本接口，好处是
// 等实时层落地时只换一个实现，不用回来改每个 handler 的调用点与载荷形状。
//
// 未接入实时层时使用 Noop：事件被丢弃，但接口行为（校验、落库、响应码）
// 与 Node 版完全一致。
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
