package voicertc

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"zviewer/backend/internal/share/sfu"
)

// sink 记录所有下发的消息，并提供「等到某类消息」的等待原语。
type sink struct {
	mu       sync.Mutex
	messages []recorded
	wake     chan struct{}
}

type recorded struct {
	target  string
	message ServerMessage
}

func newSink() *sink {
	return &sink{wake: make(chan struct{}, 1)}
}

func (s *sink) emit(socketID string, message ServerMessage) {
	s.mu.Lock()
	s.messages = append(s.messages, recorded{target: socketID, message: message})
	s.mu.Unlock()
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *sink) all() []recorded {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]recorded(nil), s.messages...)
}

// lastState 返回发给某条连接的最后一份 state。
func (s *sink) lastState(t *testing.T, socketID string) StateMessage {
	t.Helper()
	records := s.all()
	for index := len(records) - 1; index >= 0; index-- {
		state, ok := records[index].message.(StateMessage)
		if ok && records[index].target == socketID {
			return state
		}
	}
	t.Fatalf("没有发给 %s 的 state", socketID)
	return StateMessage{}
}

// lastDescription 返回发给某条连接的最后一份 offer。
func (s *sink) lastDescription(t *testing.T, socketID string) sfu.VoiceDescription {
	t.Helper()
	records := s.all()
	for index := len(records) - 1; index >= 0; index-- {
		signal, ok := records[index].message.(SignalOutMessage)
		if !ok || records[index].target != socketID || signal.Kind != "description" {
			continue
		}
		var description sfu.VoiceDescription
		if err := json.Unmarshal(signal.Payload, &description); err != nil {
			t.Fatalf("描述无法解码: %v", err)
		}
		return description
	}
	t.Fatalf("没有发给 %s 的 description", socketID)
	return sfu.VoiceDescription{}
}

// waitFor 轮询直到条件成立（媒体协商在 goroutine 里，不能同步断言）。
func (s *sink) waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s", what)
}

// countErrors 返回发给某条连接的错误数。
func (s *sink) countErrors(socketID string) int {
	total := 0
	for _, record := range s.all() {
		if _, ok := record.message.(ErrorMessage); ok && record.target == socketID {
			total++
		}
	}
	return total
}

// lastError 返回发给某条连接的最后一条错误。
func (s *sink) lastError(t *testing.T, socketID string) ErrorMessage {
	t.Helper()
	records := s.all()
	for index := len(records) - 1; index >= 0; index-- {
		failure, ok := records[index].message.(ErrorMessage)
		if ok && records[index].target == socketID {
			return failure
		}
	}
	t.Fatalf("没有发给 %s 的错误", socketID)
	return ErrorMessage{}
}

// newTestService 构造一个真实媒体面的语音控制面。
//
// 媒体面是真的（端口由内核分配）：语音的价值全在「真的能建连转发」，
// 用假 Media 测出来的只是分发逻辑。测试不真的建连，所以看不到画面/声音。
func newTestService(t *testing.T) (*Service, *sink, *sfu.Media) {
	t.Helper()
	engine, err := sfu.NewEngine(sfu.EngineOptions{
		Port: 0, IncludeLoopback: true, DisableTCP: true,
	})
	if err != nil {
		t.Fatalf("绑定媒体端口失败: %v", err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	recorder := newSink()
	media := sfu.NewMedia(sfu.MediaOptions{Settings: engine.Settings()})
	t.Cleanup(func() { _ = media.Close() })
	service := New(Deps{
		Media: media,
		Emit:  recorder.emit,
		IsHost: func(_ context.Context, socketID, _ string) (bool, error) {
			return socketID == "host", nil
		},
	})
	return service, recorder, media
}

// memberConn 造一条在房间里的连接。
func memberConn(socketID, roomID string) Conn {
	return Conn{ID: socketID, InRoom: func(id string) bool { return id == roomID }}
}

// send 把一帧 JSON 交给控制面。
func send(t *testing.T, service *Service, conn Conn, frame string) {
	t.Helper()
	service.Handle(conn, []json.RawMessage{json.RawMessage(frame)})
}

func TestVoiceJoinPublishesOneConnectionPerMember(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)

	sink.waitFor(t, "房主收到 state", func() bool {
		return sink.lastState(t, "host").Self.ConnectionID != ""
	})
	state := sink.lastState(t, "host")
	if len(state.Members) != 1 || state.Members[0].PeerID != "host" {
		t.Fatalf("成员表不对: %+v", state.Members)
	}
	if state.Self.ConnectionID == "" {
		t.Fatal("自己必须拿到 connectionId，否则没法给信令打标")
	}

	sink.waitFor(t, "房主收到 offer", func() bool {
		for _, record := range sink.all() {
			if signal, ok := record.message.(SignalOutMessage); ok && record.target == "host" && signal.Kind == "description" {
				return true
			}
		}
		return false
	})
	// 单人房间：只有自己那一路 recvonly，没有可订阅的别人。
	if tracks := sink.lastDescription(t, "host").Tracks; len(tracks) != 1 {
		t.Fatalf("单人房间应只有 1 条轨道，实际 %d: %+v", len(tracks), tracks)
	}
}

func TestVoiceSecondMemberSubscribesToTheFirst(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.join","roomId":"r1"}`)

	sink.waitFor(t, "观众收到含两条轨道的 offer", func() bool {
		tracks := 0
		for _, record := range sink.all() {
			signal, ok := record.message.(SignalOutMessage)
			if ok && record.target == "viewer-1" && signal.Kind == "description" {
				var description sfu.VoiceDescription
				if json.Unmarshal(signal.Payload, &description) == nil {
					tracks = len(description.Tracks)
				}
			}
		}
		return tracks == 2
	})

	// 两个人的订阅集合互为对方：offer 里必须包含对方那条发布。
	description := sink.lastDescription(t, "viewer-1")
	ids := make([]string, 0, len(description.Tracks))
	for _, track := range description.Tracks {
		ids = append(ids, track.PublicationID)
	}
	joined := strings.Join(ids, ",")
	if !strings.Contains(joined, "voice_host") || !strings.Contains(joined, "voice_viewer-1") {
		t.Fatalf("两条发布都要出现在 offer 里，实际 %s", joined)
	}

	state := sink.lastState(t, "host")
	if len(state.Members) != 2 {
		t.Fatalf("房主应看到 2 位成员，实际 %+v", state.Members)
	}
	// 别人的 connectionId 不下发。
	for _, member := range state.Members {
		if member.PeerID != "host" && member.ConnectionID != "" {
			t.Fatalf("不该把别人的 connectionId 下发: %+v", member)
		}
	}
}

func TestVoiceLeaveRemovesMemberAndRebuildsPlans(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "两人都在", func() bool { return len(sink.lastState(t, "host").Members) == 2 })

	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.leave","roomId":"r1"}`)
	sink.waitFor(t, "观众已退出", func() bool { return len(sink.lastState(t, "host").Members) == 1 })
	if state := sink.lastState(t, "host"); state.Members[0].PeerID != "host" {
		t.Fatalf("剩下的应是房主: %+v", state.Members)
	}
}

func TestVoiceMuteRequiresHostAndOnlyTargetsOthers(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "两人都在", func() bool { return len(sink.lastState(t, "host").Members) == 2 })

	// 非房主：明确回报，不静默失败——否则前端只会觉得按钮没反应。
	send(t, service, memberConn("viewer-1", "r1"),
		`{"t":"voice.mute","roomId":"r1","peerId":"host","muted":true}`)
	failure := sink.lastError(t, "viewer-1")
	if failure.Code != CodeNotHost {
		t.Fatalf("非房主应收到 %s，实际 %+v", CodeNotHost, failure)
	}

	// 房主静音观众：观众收到 voice.muted，成员表里标成静音。
	before := sink.countErrors("host")
	send(t, service, memberConn("host", "r1"),
		`{"t":"voice.mute","roomId":"r1","peerId":"viewer-1","muted":true}`)
	sink.waitFor(t, "成员表标成静音", func() bool {
		for _, member := range sink.lastState(t, "host").Members {
			if member.PeerID == "viewer-1" {
				return member.Muted
			}
		}
		return false
	})
	if sink.countErrors("host") != before {
		t.Fatal("房主的合法静音不该报错")
	}
	var muted bool
	for _, record := range sink.all() {
		if message, ok := record.message.(MutedMessage); ok && record.target == "viewer-1" && message.Muted {
			muted = true
		}
	}
	if !muted {
		t.Fatal("被静音的人必须收到 voice.muted，否则本地不会静音")
	}
}

func TestVoiceKickRemovesMember(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "两人都在", func() bool { return len(sink.lastState(t, "host").Members) == 2 })

	send(t, service, memberConn("host", "r1"),
		`{"t":"voice.kick","roomId":"r1","peerId":"viewer-1"}`)
	sink.waitFor(t, "成员已被移出", func() bool { return len(sink.lastState(t, "host").Members) == 1 })
	var kicked bool
	for _, record := range sink.all() {
		if _, ok := record.message.(KickedMessage); ok && record.target == "viewer-1" {
			kicked = true
		}
	}
	if !kicked {
		t.Fatal("被移出的人必须收到 voice.kicked")
	}
}

func TestVoiceSignalRequiresOwnConnection(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "拿到 connectionId", func() bool {
		return sink.lastState(t, "host").Self.ConnectionID != ""
	})
	mine := sink.lastState(t, "host").Self.ConnectionID

	before := len(sink.all())
	// 拿别人的 connectionId：静默丢弃，连错误都不回（回了等于告诉对方
	// 「这个 id 存在」，而它本来就不该被猜到）。
	send(t, service, memberConn("host", "r1"),
		`{"t":"voice.signal","roomId":"r1","connectionId":"vc_notmine","kind":"candidate","payload":{"candidate":"x"}}`)
	time.Sleep(200 * time.Millisecond)
	if len(sink.all()) != before {
		t.Fatalf("伪造 connectionId 不该产生任何消息，实际新增 %d 条", len(sink.all())-before)
	}

	// 自己的 connectionId：一次不合法的候选会被媒体层拒绝，但路由是通的
	// （不产生 protocol 层错误）。这里只断言不会报「信令被拒」以外的错误。
	send(t, service, memberConn("host", "r1"),
		`{"t":"voice.signal","roomId":"r1","connectionId":"`+mine+`","kind":"candidate","payload":{"candidate":"garbage"}}`)
	if sink.countErrors("host") != 0 {
		t.Fatalf("合法路由不该产生协议错误: %+v", sink.lastError(t, "host"))
	}
}

func TestVoiceDetachClearsMembership(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "两人都在", func() bool { return len(sink.lastState(t, "host").Members) == 2 })

	service.Detach("viewer-1")
	sink.waitFor(t, "观众已断开", func() bool { return len(sink.lastState(t, "host").Members) == 1 })

	// 重复 Detach 不应有副作用。
	service.Detach("viewer-1")
	if members := sink.lastState(t, "host").Members; len(members) != 1 {
		t.Fatalf("重复清理改变了成员表: %+v", members)
	}
}

func TestVoiceRejectsMalformedFrames(t *testing.T) {
	service, sink, _ := newTestService(t)
	cases := []string{
		`{"t":"voice.join"}`,                             // 缺 roomId
		`{"t":"voice.join","roomId":"r1","extra":1}`,     // 未知字段
		`{"t":"voice.join","roomId":"r1","RoomId":"r2"}`, // 大小写折叠绕过白名单
		`{"t":"voice.nope","roomId":"r1"}`,               // 未知类型
		`{"t":"voice.signal","roomId":"r1","connectionId":"c","kind":"nope","payload":{}}`,
		`not json`,
	}
	for _, frame := range cases {
		send(t, service, memberConn("host", "r1"), frame)
		if failure := sink.lastError(t, "host"); failure.Code != CodeInvalidMessage {
			t.Fatalf("%s 应被拒为 %s，实际 %+v", frame, CodeInvalidMessage, failure)
		}
	}
}

func TestVoiceJoinRequiresRoomMembership(t *testing.T) {
	service, sink, _ := newTestService(t)
	outsider := Conn{ID: "stranger", InRoom: func(string) bool { return false }}
	send(t, service, outsider, `{"t":"voice.join","roomId":"r1"}`)
	if failure := sink.lastError(t, "stranger"); failure.Code != CodeNotInRoom {
		t.Fatalf("不在房间的人应被拒，实际 %+v", failure)
	}
}

func TestVoiceLeaveWithoutJoinIsNoop(t *testing.T) {
	service, sink, _ := newTestService(t)
	before := len(sink.all())
	send(t, service, memberConn("host", "r1"), `{"t":"voice.leave","roomId":"r1"}`)
	time.Sleep(100 * time.Millisecond)
	if len(sink.all()) != before {
		t.Fatal("没加入就退出不该产生任何消息")
	}
}

func TestVoiceDropRoomClosesEverything(t *testing.T) {
	service, sink, _ := newTestService(t)
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	send(t, service, memberConn("viewer-1", "r1"), `{"t":"voice.join","roomId":"r1"}`)
	sink.waitFor(t, "两人都在", func() bool { return len(sink.lastState(t, "host").Members) == 2 })

	service.DropRoom("r1")
	if err := service.media.Close(); err != nil {
		t.Fatalf("媒体面关闭失败: %v", err)
	}
	// 关房后再来一条消息不应 panic（成员表已清空）。
	send(t, service, memberConn("host", "r1"), `{"t":"voice.join","roomId":"r1"}`)
}
