package share

import (
	"context"
	"encoding/json"
	"testing"
)

// emitted 是一条被记录的出站消息。
type emitted struct {
	// Target 是 socketId（单播）或 roomId（广播）。
	Target string
	Event  string
	Frame  []byte
}

// fakeHub 记录所有出站消息，供断言「发没发、发给谁、发了什么」。
type fakeHub struct {
	to   []emitted
	room []emitted
}

func (h *fakeHub) EmitRoom(roomID, event string, payload any) {
	h.room = append(h.room, record(roomID, event, payload))
}

func (h *fakeHub) EmitTo(socketID, event string, payload any) {
	h.to = append(h.to, record(socketID, event, payload))
}

func record(target, event string, payload any) emitted {
	frame, err := json.Marshal(payload)
	if err != nil {
		panic(err)
	}
	return emitted{Target: target, Event: event, Frame: frame}
}

// lastServerMessage 把最后一条出站帧解成通用 map。
func lastServerMessage(t *testing.T, list []emitted) map[string]any {
	t.Helper()
	if len(list) == 0 {
		t.Fatal("没有出站消息")
	}
	return decodeFrame(t, list[len(list)-1].Frame)
}

func decodeFrame(t *testing.T, frame []byte) map[string]any {
	t.Helper()
	var message map[string]any
	if err := json.Unmarshal(frame, &message); err != nil {
		t.Fatalf("出站帧不是 JSON 对象: %v (%s)", err, frame)
	}
	return message
}

// newTestService 构造一个带假 Hub 的服务。hosts 决定哪些 socket 是房主。
func newTestService(hosts ...string) (*Service, *fakeHub) {
	hub := &fakeHub{}
	hostSet := make(map[string]struct{}, len(hosts))
	for _, id := range hosts {
		hostSet[id] = struct{}{}
	}
	service := NewService(Deps{
		Hub: hub,
		IsHost: func(_ context.Context, socketID, _ string) (bool, error) {
			_, ok := hostSet[socketID]
			return ok, nil
		},
		DisplayName: func(socketID string) string { return "名字:" + socketID },
	})
	return service, hub
}

// newConn 构造一条假连接；rooms 决定它在哪些房间里。
func newConn(id string, rooms ...string) Conn {
	set := make(map[string]struct{}, len(rooms))
	for _, room := range rooms {
		set[room] = struct{}{}
	}
	return Conn{
		ID:         id,
		InRoom:     func(roomID string) bool { _, ok := set[roomID]; return ok },
		Disconnect: func(string) {},
	}
}

func send(t *testing.T, service *Service, conn Conn, frame string) {
	t.Helper()
	service.Handle(conn, []json.RawMessage{json.RawMessage(frame)})
}

// 客户端曾经把消息 JSON.stringify 成字符串再 socket.emit，服务端按对象解包
// 只能看到 string，于是整条 share 协议在浏览器里静默失效（客户端一切正常、
// 服务端一条都不认）。现在两种帧都接受：对象优先，字符串里裹着对象也能解。
func TestHandleAcceptsStringifiedFrame(t *testing.T) {
	service, hub := newTestService("host-1")
	frame := `{"t":"share.hello","roomId":"r1"}`
	quoted, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("构造双重编码帧失败: %v", err)
	}
	send(t, service, newConn("host-1", "r1"), string(quoted))

	message := lastServerMessage(t, hub.to)
	if message["t"] != TypeSnapshot {
		t.Fatalf("双重编码帧应被接受并回快照，实际 %v", message)
	}
	if message["roomId"] != "r1" {
		t.Fatalf("快照房间不对: %v", message["roomId"])
	}
}

// 字符串里不是对象（比如一个数字或普通文本）仍然要拒。
func TestHandleRejectsNonObjectStringFrame(t *testing.T) {
	service, hub := newTestService("host-1")
	quoted, err := json.Marshal("hello")
	if err != nil {
		t.Fatalf("构造帧失败: %v", err)
	}
	send(t, service, newConn("host-1", "r1"), string(quoted))

	message := lastServerMessage(t, hub.to)
	if message["code"] != CodeInvalidMessage {
		t.Fatalf("非对象字符串帧应回报 INVALID_MESSAGE，实际 %v", message)
	}
}

func TestHandleHelloReturnsSnapshot(t *testing.T) {
	service, hub := newTestService("host-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)

	message := lastServerMessage(t, hub.to)
	if message["t"] != TypeSnapshot {
		t.Fatalf("期望快照，实际 %v", message["t"])
	}
	if message["roomId"] != "r1" {
		t.Fatalf("roomId 错误: %v", message["roomId"])
	}
	if message["sharing"] != false {
		t.Fatalf("未开始共享时 sharing 应为 false: %v", message["sharing"])
	}
	participants, ok := message["participants"].([]any)
	if !ok || len(participants) != 1 {
		t.Fatalf("参与者列表错误: %v", message["participants"])
	}
	first := participants[0].(map[string]any)
	if first["role"] != RoleHost {
		t.Fatalf("房主角色错误: %v", first["role"])
	}
	if first["displayName"] != "名字:host-1" {
		t.Fatalf("展示名未注入: %v", first["displayName"])
	}
}

func TestHandleHelloRejectsForeignRoom(t *testing.T) {
	service, hub := newTestService()
	send(t, service, newConn("s1", "other"), `{"t":"share.hello","roomId":"r1"}`)

	message := lastServerMessage(t, hub.to)
	if message["t"] != TypeError {
		t.Fatalf("期望错误帧，实际 %v", message["t"])
	}
	if message["code"] != CodeNoRoom {
		t.Fatalf("错误码错误: %v", message["code"])
	}
	if service.Session("r1") != nil {
		t.Fatal("越权请求不应创建会话")
	}
}

func TestHandleStartRequiresHost(t *testing.T) {
	service, hub := newTestService("host-1")
	send(t, service, newConn("viewer-1", "r1"), `{"t":"share.start","roomId":"r1"}`)

	message := lastServerMessage(t, hub.to)
	if message["t"] != TypeError || message["code"] != CodeForbidden {
		t.Fatalf("观众启动共享应被拒: %v", message)
	}
	if session := service.Session("r1"); session != nil && session.Snapshot().Sharing {
		t.Fatal("被拒的启动不应改变共享状态")
	}
}

func TestHandleStartBroadcastsSnapshot(t *testing.T) {
	service, hub := newTestService("host-1")
	send(t, service, newConn("host-1", "r1"),
		`{"t":"share.start","roomId":"r1","qualitySettings":{"resolutionPreset":"1080p","frameRate":30,"maxBitrateMbps":8}}`)

	message := lastServerMessage(t, hub.room)
	if message["t"] != TypeSnapshot || message["sharing"] != true {
		t.Fatalf("start 应广播 sharing=true 的快照: %v", message)
	}
	generation, _ := message["shareGeneration"].(string)
	if generation == "" {
		t.Fatal("快照缺少共享代际")
	}
	quality := message["qualitySettings"].(map[string]any)
	if quality["resolutionPreset"] != "1080p" {
		t.Fatalf("档位未保存: %v", quality)
	}
}

func TestHandleStopWithStaleGenerationDisconnects(t *testing.T) {
	service, hub := newTestService("host-1")
	var disconnected string
	conn := Conn{
		ID:         "host-1",
		InRoom:     func(string) bool { return true },
		Disconnect: func(reason string) { disconnected = reason },
	}
	send(t, service, conn, `{"t":"share.start","roomId":"r1"}`)
	send(t, service, conn, `{"t":"share.stop","roomId":"r1","shareGeneration":"share_stale"}`)

	message := lastServerMessage(t, hub.to)
	if message["t"] != TypeError || message["code"] != CodeGenerationReplaced {
		t.Fatalf("过期代际应回 SHARING_GENERATION_REPLACED: %v", message)
	}
	if disconnected == "" {
		t.Fatal("过期代际应关闭连接（Piik server.go:1382-1390）")
	}
}

func TestHandleStopSucceeds(t *testing.T) {
	service, hub := newTestService("host-1")
	conn := newConn("host-1", "r1")
	send(t, service, conn, `{"t":"share.start","roomId":"r1"}`)
	generation := service.Session("r1").Generation()

	send(t, service, conn, `{"t":"share.stop","roomId":"r1","shareGeneration":"`+generation+`"}`)
	message := lastServerMessage(t, hub.room)
	if message["sharing"] != false {
		t.Fatalf("stop 后 sharing 应为 false: %v", message)
	}
	if message["shareGeneration"] != "" {
		t.Fatalf("stop 后代际应清空: %v", message["shareGeneration"])
	}
}

func TestHandlePauseNeedsPausedField(t *testing.T) {
	service, hub := newTestService("host-1")
	conn := newConn("host-1", "r1")
	send(t, service, conn, `{"t":"share.start","roomId":"r1"}`)
	generation := service.Session("r1").Generation()

	// paused 是必填：缺了是解码失败，不是「默认 false」。
	send(t, service, conn, `{"t":"share.pause","roomId":"r1","shareGeneration":"`+generation+`"}`)
	message := lastServerMessage(t, hub.to)
	if message["t"] != TypeError || message["code"] != CodeInvalidMessage {
		t.Fatalf("缺少 paused 应报 INVALID_MESSAGE: %v", message)
	}
}

func TestHandleUnknownTypeDisconnects(t *testing.T) {
	service, _ := newTestService()
	var disconnected string
	conn := Conn{
		ID:         "s1",
		InRoom:     func(string) bool { return true },
		Disconnect: func(reason string) { disconnected = reason },
	}
	service.Handle(conn, []json.RawMessage{json.RawMessage(`{"t":"share.nope","roomId":"r1"}`)})
	if disconnected == "" {
		t.Fatal("未知 t 应关闭连接")
	}
}

// 未知字段只回报错误，不断连：字段拼错不该踢掉观众的整个会话。
func TestHandleUnknownFieldDoesNotDisconnect(t *testing.T) {
	service, hub := newTestService("host-1")
	var disconnected string
	conn := Conn{
		ID:         "host-1",
		InRoom:     func(string) bool { return true },
		Disconnect: func(reason string) { disconnected = reason },
	}
	service.Handle(conn, []json.RawMessage{json.RawMessage(`{"t":"share.hello","roomId":"r1","oops":1}`)})
	message := lastServerMessage(t, hub.to)
	if message["code"] != CodeInvalidMessage {
		t.Fatalf("未知字段应报 INVALID_MESSAGE: %v", message)
	}
	if disconnected != "" {
		t.Fatal("未知字段不应关闭连接")
	}
}

// P1 只实现了 P2P 路由与信令；SFU 信令必须明确回报「未实现」，
// 不能让客户端等到超时还不知道服务端不支持。
func TestHandleSFUSignalNotImplemented(t *testing.T) {
	service, hub := newTestService("host-1")
	conn := newConn("host-1", "r1")
	frame := `{"t":"share.sfu-signal","roomId":"r1","revision":1,"publicationGeneration":"pub_1","connectionId":"route_1","kind":"description"}`
	send(t, service, conn, frame)
	message := lastServerMessage(t, hub.to)
	if message["code"] != CodeNotImplemented {
		t.Fatalf("应回报 NOT_IMPLEMENTED，实际 %v", message["code"])
	}
	if message["roomId"] != "r1" {
		t.Fatalf("错误帧缺少 roomId: %v", message)
	}
}

// 没有对应路由边时，路由类消息一律静默丢弃——不回报错、不断连。
// 这与 Piik 的版本栅栏一致（router.go:705-708,810-815）：过期消息不是错误。
func TestRouteMessagesWithoutEdgeAreIgnored(t *testing.T) {
	service, hub := newTestService("host-1")
	conn := newConn("host-1", "r1")
	send(t, service, conn, `{"t":"share.hello","roomId":"r1"}`)
	before := len(hub.to) + len(hub.room)
	frames := []string{
		`{"t":"share.route-ready","roomId":"r1","revision":99,"phase":"prepare"}`,
		`{"t":"share.transport-connected","roomId":"r1","revision":99,"connectionId":"route_1"}`,
		`{"t":"share.route-failed","roomId":"r1","revision":99,"phase":"prepare","connectionId":"route_1"}`,
		`{"t":"share.restart","roomId":"r1","connectionId":"route_1","rebuild":false}`,
		`{"t":"share.signal","roomId":"r1","connectionId":"route_1","kind":"offer","payload":{}}`,
	}
	for _, frame := range frames {
		send(t, service, conn, frame)
	}
	if after := len(hub.to) + len(hub.room); after != before {
		t.Fatalf("无路由边时不应产生任何出站消息，多出 %d 条", after-before)
	}
}

func TestDetachRemovesParticipantAndBroadcasts(t *testing.T) {
	service, hub := newTestService("host-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)
	send(t, service, newConn("viewer-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)

	service.Detach("viewer-1")
	message := lastServerMessage(t, hub.room)
	participants := message["participants"].([]any)
	if len(participants) != 1 {
		t.Fatalf("断线后应只剩房主: %v", participants)
	}

	service.Detach("host-1")
	if session := service.Session("r1"); session != nil {
		t.Fatal("最后一人离开后会话应被删除")
	}
}

func TestDetachUnknownSocketIsNoop(t *testing.T) {
	service, hub := newTestService()
	service.Detach("nobody")
	if len(hub.to)+len(hub.room) != 0 {
		t.Fatal("清理未知连接不应产生任何广播")
	}
}

func TestDropRoomBroadcastsEmptySnapshot(t *testing.T) {
	service, hub := newTestService("host-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	service.DropRoom("r1")

	message := lastServerMessage(t, hub.room)
	if message["sharing"] != false {
		t.Fatalf("房间关闭后应广播未共享的空快照: %v", message)
	}
	if session := service.Session("r1"); session != nil {
		t.Fatal("房间关闭后会话应被删除")
	}
}
