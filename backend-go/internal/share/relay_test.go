package share

import (
	"context"
	"testing"

	"zviewer/backend/internal/share/sfu"

	"github.com/pion/webrtc/v4"
)

// newRelayTestService 构造一个开启中继的服务。
//
// 媒体面是真的（端口 0，内核分配）：中继链路的价值全在「真的能建连」，
// 用假 Media 测出来的只是分发逻辑。测试不推流，所以不会真的出画面。
func newRelayTestService(t *testing.T, hosts ...string) (*Service, *fakeHub, *Relay) {
	t.Helper()
	engine, err := sfu.NewEngine(sfu.EngineOptions{
		Port: 0, IncludeLoopback: true, DisableTCP: true,
	})
	if err != nil {
		t.Fatalf("绑定媒体端口失败: %v", err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	hub := &fakeHub{}
	hostSet := make(map[string]struct{}, len(hosts))
	for _, id := range hosts {
		hostSet[id] = struct{}{}
	}
	relay := NewRelay(RelayDeps{
		Settings:  engine.Settings(),
		Admission: sfu.NewAdmission(sfu.AdmissionOptions{IngressCapacity: 1, EgressCapacity: 4}),
		Emit: func(socketID string, message ServerMessage) {
			hub.EmitTo(socketID, Event, message)
		},
	})
	t.Cleanup(func() { _ = relay.Close() })
	service := NewService(Deps{
		Hub: hub,
		IsHost: func(_ context.Context, socketID, _ string) (bool, error) {
			_, ok := hostSet[socketID]
			return ok, nil
		},
		DisplayName: func(socketID string) string { return "名字:" + socketID },
		Relay:       relay,
	})
	relay.SetRouteFailed(service.OnRelayRouteFailed)
	return service, hub, relay
}

// relayConfigOf 取出给房主的 sfu-config。
func relayConfigOf(t *testing.T, hub *fakeHub) map[string]any {
	t.Helper()
	for index := len(hub.to) - 1; index >= 0; index-- {
		message := decodeFrame(t, hub.to[index].Frame)
		if message["t"] == TypeSFUConfig {
			return message
		}
	}
	t.Fatal("房主没有收到 share.sfu-config")
	return nil
}

// routeOf 取出给某个 socket 的最后一条 route。
func routeOf(t *testing.T, hub *fakeHub, socketID string) map[string]any {
	t.Helper()
	for index := len(hub.to) - 1; index >= 0; index-- {
		if hub.to[index].Target != socketID {
			continue
		}
		message := decodeFrame(t, hub.to[index].Frame)
		if message["t"] == TypeRoute {
			return message
		}
	}
	t.Fatalf("%s 没有收到 share.route", socketID)
	return nil
}

// TestRelayConfigAndCandidatesCarryPublication 覆盖「房主拿到发布身份、
// 观众拿到的候选是 relay 且带 publicationGeneration」。
func TestRelayConfigAndCandidatesCarryPublication(t *testing.T) {
	service, hub, _ := newRelayTestService(t, "host-1")
	hostConn := newConn("host-1", "r1")
	// 房主必须先 hello 进会话：候选的规划以「房主在参与者里」为前提。
	send(t, service, hostConn, `{"t":"share.hello","roomId":"r1"}`)
	send(t, service, hostConn, `{"t":"share.start","roomId":"r1"}`)

	config := relayConfigOf(t, hub)
	publication, _ := config["publicationGeneration"].(string)
	if publication == "" {
		t.Fatalf("发布代际为空: %v", config)
	}
	if config["connectionId"] != publication {
		t.Fatalf("connectionId 必须与发布代际同值: %v", config)
	}

	// 观众加入 → 候选必须走 relay，并带上发布代际。
	send(t, service, newConn("viewer-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)
	route := routeOf(t, hub, "viewer-1")
	candidate, ok := route["candidate"].(map[string]any)
	if !ok {
		t.Fatalf("route 没有候选: %v", route)
	}
	if candidate["transport"] != TransportRelay {
		t.Fatalf("中继模式下候选必须是 relay，实际 %v", candidate["transport"])
	}
	if candidate["publicationGeneration"] != publication {
		t.Fatalf("候选缺少发布代际: %v", candidate)
	}
	if route["phase"] != PhasePrepare {
		t.Fatalf("首条 route 必须是 prepare，实际 %v", route["phase"])
	}
}

// TestRelaySignalRequiresOwnRoute 证明身份栅栏：观众拿别人的 connectionId
// 订流不会拿到任何 offer。
func TestRelaySignalRequiresOwnRoute(t *testing.T) {
	service, hub, relay := newRelayTestService(t, "host-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	config := relayConfigOf(t, hub)
	publication, _ := config["publicationGeneration"].(string)

	send(t, service, newConn("viewer-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)
	own := routeOf(t, hub, "viewer-1")
	candidate, _ := own["candidate"].(map[string]any)
	ownConnectionID, _ := candidate["connectionId"].(string)
	if ownConnectionID == "" {
		t.Fatalf("候选缺少 connectionId: %v", candidate)
	}

	before := len(hub.to)
	// 伪造：别人的边 + 自己的边但换了发布代际。
	send(t, service, newConn("viewer-1", "r1"),
		`{"t":"share.sfu-signal","roomId":"r1","revision":1,"publicationGeneration":"`+publication+
			`","connectionId":"route_forged","kind":"subscribe"}`)
	if len(hub.to) != before {
		t.Fatalf("伪造的 connectionId 不应产生任何下行: %v", hub.to[before:])
	}
	// 合法订阅会被接受，但发布端还没推流，所以只会挂起、不会立刻给 offer。
	send(t, service, newConn("viewer-1", "r1"),
		`{"t":"share.sfu-signal","roomId":"r1","revision":1,"publicationGeneration":"`+publication+
			`","connectionId":"`+ownConnectionID+`","kind":"subscribe"}`)

	// 停止共享必须把挂起的订阅一起收掉（否则容量泄漏、goroutine 泄漏）。
	fence, _ := relay.Publication("r1")
	send(t, service, newConn("host-1", "r1"),
		`{"t":"share.stop","roomId":"r1","shareGeneration":"`+fence.ShareGeneration+`"}`)
	if _, ok := relay.Publication("r1"); ok {
		t.Fatal("停止共享后发布应当退役")
	}
}

// TestRelayDisabledReportsNotImplemented 守「直连模式不该假装支持中继」。
func TestRelayDisabledReportsNotImplemented(t *testing.T) {
	service, hub := newTestService("host-1")
	send(t, service, newConn("host-1", "r1"),
		`{"t":"share.sfu-signal","roomId":"r1","revision":1,"publicationGeneration":"pub_x","connectionId":"pub_x","kind":"media"}`)
	message := lastServerMessage(t, hub.to)
	if message["code"] != CodeNotImplemented {
		t.Fatalf("直连模式下应回报 NOT_IMPLEMENTED，实际 %v", message)
	}
}

// TestRelayPublicationIdentityIsSingleUse 证明同一房间重复 start 会退役旧发布。
func TestRelayPublicationIdentityIsSingleUse(t *testing.T) {
	service, hub, relay := newRelayTestService(t, "host-1")
	hostConn := newConn("host-1", "r1")
	// 房主必须先 hello 进会话：候选的规划以「房主在参与者里」为前提。
	send(t, service, hostConn, `{"t":"share.hello","roomId":"r1"}`)
	send(t, service, hostConn, `{"t":"share.start","roomId":"r1"}`)
	first := relayConfigOf(t, hub)
	firstPublication, _ := first["publicationGeneration"].(string)

	fence, _ := relay.Publication("r1")
	// stop 必须带当前代际：不带等于「过期客户端」，服务端按规范拒绝退役。
	send(t, service, hostConn,
		`{"t":"share.stop","roomId":"r1","shareGeneration":"`+fence.ShareGeneration+`"}`)
	send(t, service, hostConn, `{"t":"share.start","roomId":"r1"}`)
	second := relayConfigOf(t, hub)
	secondPublication, _ := second["publicationGeneration"].(string)
	if firstPublication == secondPublication {
		t.Fatal("重新开始共享必须换一个新的发布代际")
	}
	if _, ok := relay.Publication("r1"); !ok {
		t.Fatal("重新开始后应存在发布")
	}
}

// 中继模式下房主不该收到任何观众候选。
//
// 收到会怎样：房主照着建一条发布端 PC，真的给观众发 offer，于是同一条画面
// 既走 SFU 又走 P2P——多一份编码、多一份上行，观众还可能收到重复媒体。
// 而这一切在状态面板上都看不出来（两边都 connected）。
func TestRelayDoesNotPlanRoutesOnHost(t *testing.T) {
	service, hub, _ := newRelayTestService(t, "host-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)

	// 房主开始共享之后才有人进来，才会规划边。
	hub.to = nil
	send(t, service, newConn("viewer-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)

	if frames := routeFramesTo(hub, "viewer-1"); len(frames) == 0 {
		t.Fatal("观众应当收到候选")
	}
	if frames := routeFramesTo(hub, "host-1"); len(frames) != 0 {
		t.Fatalf("房主不该收到观众候选，实际收到 %v", frames)
	}
}

// 发布端（房主）的媒体事件不带 ConnectionID，转发时必须补成发布代际。
//
// 漏了这一步的后果不是「少个字段」：客户端按 connectionId 判定「这是不是我的
// 连接」，补不上就一条候选都收不到，ICE 永远凑不齐配对——画面永远不出，而
// 两侧状态都显示 connected。
func TestRelayPublisherCandidatesCarryPublication(t *testing.T) {
	service, hub, relay := newRelayTestService(t, "host-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.hello","roomId":"r1"}`)
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	fence, ok := relay.Publication("r1")
	if !ok {
		t.Fatal("房主开始共享后应存在发布")
	}

	candidate := webrtc.ICECandidateInit{Candidate: "candidate:1 1 udp 2130706431 10.0.0.1 50000 typ host"}
	// 模拟媒体层：发布端事件不带 ConnectionID。
	relay.OnMediaEvent(sfu.MediaEvent{Fence: fence, Candidate: &candidate})

	message := lastSignalTo(t, hub, "host-1")
	if message["kind"] != "candidate" {
		t.Fatalf("应转发候选，实际 %v", message["kind"])
	}
	if message["connectionId"] != fence.PublicationGeneration {
		t.Fatalf("发布端候选必须带发布代际作为 connectionId，实际 %v", message["connectionId"])
	}
}

// lastSignalTo 取出最后一条发给某条连接的中继信令。
func lastSignalTo(t *testing.T, hub *fakeHub, socketID string) map[string]any {
	t.Helper()
	for index := len(hub.to) - 1; index >= 0; index-- {
		if hub.to[index].Target != socketID {
			continue
		}
		message := decodeFrame(t, hub.to[index].Frame)
		if message["t"] == TypeSFUSignal {
			return message
		}
	}
	t.Fatalf("没有发给 %s 的中继信令", socketID)
	return nil
}

// 确保 webrtc 类型被引用（测试里用到 SettingEngine 的语义）。
var _ = webrtc.Configuration{}
