package room

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"zviewer/backend/internal/sio"
	"zviewer/backend/internal/store"
)

// Live2D 悬浮层的同步通道：权限、隔离、补拉与钳制。
//
// 这些用例都不起 socket：直接调 handler + store，因为这里要验的是
// 「谁的数据能进、进了之后广播成什么样」，而不是 socket.io 的编解码。

func l2dArgs(t *testing.T, raw string) []json.RawMessage {
	t.Helper()
	return []json.RawMessage{json.RawMessage(raw)}
}

func l2dSession(t *testing.T, env *testEnv, roomID, socketID, role string) {
	t.Helper()
	if err := env.svc.Sessions.Create(context.Background(), &store.Session{
		RoomID: roomID, SocketID: socketID, Role: role, UserID: int64p(1),
	}); err != nil {
		t.Fatalf("创建会话失败: %v", err)
	}
}

// 1) 没声明过模型的连接发指针，必须整条丢弃（否则任何人都能凭空造一个模型）。
func TestLive2DStateDroppedWithoutConfig(t *testing.T) {
	env := newTestEnv(t)
	sc := &sio.Socket{ID: "s-attacker"}

	env.svc.handleLive2DState(sc, l2dArgs(t, `{"roomId":"ROOML2D1","x":0.5,"y":0.5,"a":1.7}`))
	env.svc.FlushLive2D()

	if n := env.svc.Live2DCount("ROOML2D1"); n != 0 {
		t.Fatalf("未声明的连接不应产生模型，实际 %d 个", n)
	}
	if len(env.hub.rooms) != 0 {
		t.Fatalf("未声明的连接不应产生广播，实际 %v", env.hub.rooms)
	}
}

// 2) payload 里带 sid 也无效；越界数值要被钳制。
func TestLive2DClampAndNoSpoof(t *testing.T) {
	env := newTestEnv(t)
	if !env.svc.Live2DSet("ROOML2D2", live2dMember{
		SocketID: "s1", Name: "Alice", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	}) {
		t.Fatal("写入模型失败")
	}

	env.svc.handleLive2DState(&sio.Socket{ID: "s1"},
		l2dArgs(t, `{"roomId":"ROOML2D2","sid":"victim","x":5,"y":-1,"a":99}`))

	snap := env.svc.Live2DSnapshot("ROOML2D2")
	if len(snap) != 1 {
		t.Fatalf("只应有一个模型，实际 %d 个（伪造的 sid 被当成了新成员？）", len(snap))
	}
	m := snap[0]
	if m.SocketID != "s1" {
		t.Fatalf("身份必须取连接 id，实际 %s", m.SocketID)
	}
	if m.X != 1 || m.Y != 0 {
		t.Fatalf("坐标未钳制：x=%v y=%v", m.X, m.Y)
	}
	if m.AR != 6 {
		t.Fatalf("宽高比未钳制：%v", m.AR)
	}
}

// 3) 一个房间的变更不能出现在另一个房间的 patch 里。
func TestLive2DPatchIsolatedByRoom(t *testing.T) {
	env := newTestEnv(t)
	env.hub.members["ROOM_A"] = []string{"s1"}
	env.hub.members["ROOM_B"] = []string{"s2"}

	env.svc.Live2DSet("ROOM_A", live2dMember{SocketID: "s1", Name: "A", Kind: "builtin", ModelID: "hiyori", Scale: 1})
	env.svc.Live2DSet("ROOM_B", live2dMember{SocketID: "s2", Name: "B", Kind: "builtin", ModelID: "hiyori", Scale: 1})
	env.svc.FlushLive2D() // 把两条 add 排掉，下面只看变更

	mark := len(env.hub.rooms)
	env.svc.Live2DUpdateState("ROOM_A", "s1", 0.4, 0.6, 1.7, time.Now())
	env.svc.FlushLive2D()

	for _, e := range env.hub.rooms[mark:] {
		if strings.HasPrefix(e, "ROOM_B|") {
			t.Fatalf("B 房没有变更却收到了广播：%v", env.hub.rooms[mark:])
		}
	}
	if !env.hub.hasRoomEvent("ROOM_A", "live2d-patch") {
		t.Fatal("A 房的变更没有广播")
	}
}

// 4) 补拉只回给发起者，且只含本房间的模型。
func TestLive2DSnapshotOnRequest(t *testing.T) {
	env := newTestEnv(t)
	l2dSession(t, env, "ROOM_S", "s9", store.SessionRoleViewer)

	env.svc.Live2DSet("ROOM_S", live2dMember{SocketID: "s1", Name: "A", Kind: "builtin", ModelID: "hiyori", Scale: 1})
	env.svc.Live2DSet("ROOM_S", live2dMember{SocketID: "s2", Name: "B", Kind: "builtin", ModelID: "haru", Scale: 1})
	env.svc.Live2DSet("ROOM_OTHER", live2dMember{SocketID: "s3", Name: "C", Kind: "builtin", ModelID: "mao", Scale: 1})

	env.svc.handleLive2DRequest(&sio.Socket{ID: "s9"}, l2dArgs(t, `{"roomId":"ROOM_S"}`))

	if !env.hub.hasDirect("s9", "live2d-snapshot") {
		t.Fatal("应向发起者定向回发快照")
	}
	var got live2dSnapshotOut
	for _, p := range env.hub.payloads["s9|live2d-snapshot"] {
		if v, ok := p.(live2dSnapshotOut); ok {
			got = v
		}
	}
	if len(got.Models) != 2 {
		t.Fatalf("快照应含本房间 2 个模型，实际 %d 个", len(got.Models))
	}
	for _, row := range got.Models {
		if sid, _ := row[0].(string); sid == "s3" {
			t.Fatal("快照里混进了别的房间的模型")
		}
	}
}

// 5) 自定义模型只开给房主；观众只能选内置模型。
func TestLive2DURLLimitedToHost(t *testing.T) {
	env := newTestEnv(t)
	l2dSession(t, env, "ROOM_H", "s-viewer", store.SessionRoleViewer)
	l2dSession(t, env, "ROOM_H", "s-host", store.SessionRoleSharer)

	var viewerAck AckResponse
	env.svc.handleLive2DConfig(&sio.Socket{ID: "s-viewer"},
		l2dArgs(t, `{"roomId":"ROOM_H","action":"set","kind":"url","modelId":"https://example.com/a.model3.json"}`),
		func(v ...any) {
			if len(v) > 0 {
				viewerAck, _ = v[0].(AckResponse)
			}
		})
	if viewerAck.Success {
		t.Fatal("观众不应能设置 URL 模型")
	}
	if n := env.svc.Live2DCount("ROOM_H"); n != 0 {
		t.Fatalf("被拒绝的声明不应落库，实际 %d 个", n)
	}

	var hostAck AckResponse
	env.svc.handleLive2DConfig(&sio.Socket{ID: "s-host"},
		l2dArgs(t, `{"roomId":"ROOM_H","action":"set","kind":"url","modelId":"https://example.com/a.model3.json"}`),
		func(v ...any) {
			if len(v) > 0 {
				hostAck, _ = v[0].(AckResponse)
			}
		})
	if !hostAck.Success {
		t.Fatalf("房主应能设置 URL 模型：%+v", hostAck)
	}
	if n := env.svc.Live2DCount("ROOM_H"); n != 1 {
		t.Fatalf("房主的模型应已写入，实际 %d 个", n)
	}

	// 非法 scheme 任何时候都不放行
	if got := validateLive2DModelURL("javascript:alert(1)"); got == "" {
		t.Fatal("javascript: 必须被拒")
	}
	if got := validateLive2DModelURL("/live2d/models/hiyori/hiyori.model3.json"); got != "" {
		t.Fatalf("同源路径应放行，实际：%s", got)
	}
}

// 6) 房间模型库是共享资源：观众也能选，但必须真的存在。
//
// 这一条守的是产品语义——房主上传的模型如果不让观众选，这个功能对他们
// 就等于不存在；反过来如果不校验存在性，随便填 id 会让全房间加载失败。
func TestLive2DRoomModelSelectableByViewer(t *testing.T) {
	env := newTestEnv(t)
	l2dSession(t, env, "ROOM_R", "s-viewer", store.SessionRoleViewer)
	env.svc.SetLive2DModelChecker(func(roomID, modelID string) bool {
		return roomID == "ROOM_R" && modelID == "hiyori-abc123"
	})

	var missingAck AckResponse
	env.svc.handleLive2DConfig(&sio.Socket{ID: "s-viewer"},
		l2dArgs(t, `{"roomId":"ROOM_R","action":"set","kind":"room","modelId":"nope-000000"}`),
		func(v ...any) {
			if len(v) > 0 {
				missingAck, _ = v[0].(AckResponse)
			}
		})
	if missingAck.Success {
		t.Fatal("不存在的房间模型不应放行")
	}

	var okAck AckResponse
	env.svc.handleLive2DConfig(&sio.Socket{ID: "s-viewer"},
		l2dArgs(t, `{"roomId":"ROOM_R","action":"set","kind":"room","modelId":"hiyori-abc123"}`),
		func(v ...any) {
			if len(v) > 0 {
				okAck, _ = v[0].(AckResponse)
			}
		})
	if !okAck.Success {
		t.Fatalf("观众应能选房间模型：%+v", okAck)
	}
	list := env.svc.Live2DSnapshot("ROOM_R")
	if len(list) != 1 || list[0].Kind != "room" {
		t.Fatalf("房间模型应已写入，实际 %+v", list)
	}
}

// 7) 表情：只在「自己是房内成员且声明了模型」时广播，且被 120ms 门限压住。
func TestLive2DActionBroadcast(t *testing.T) {
	env := newTestEnv(t)
	env.svc.Live2DSet("ROOM_E", live2dMember{
		SocketID: "s1", Name: "Alice", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})

	env.svc.handleLive2DAction(&sio.Socket{ID: "s1"}, l2dArgs(t, `{"roomId":"ROOM_E","e":2}`))
	if len(env.hub.rooms) != 1 || env.hub.rooms[0] != "ROOM_E|live2d-action" {
		t.Fatalf("应广播一条 live2d-action，实际 %v", env.hub.rooms)
	}
	out, _ := env.hub.payloads["ROOM_E|live2d-action"][0].(live2dActionOut)
	if out.SID != "s1" || out.E != 2 {
		t.Fatalf("广播内容不对：%+v", out)
	}

	// 连点：120ms 内的第二条必须被丢掉（否则一个人就能刷满整个房间）。
	env.svc.handleLive2DAction(&sio.Socket{ID: "s1"}, l2dArgs(t, `{"roomId":"ROOM_E","e":3}`))
	if len(env.hub.rooms) != 1 {
		t.Fatalf("门限内的第二条不应广播，实际 %v", env.hub.rooms)
	}

	// 没声明模型的连接：整条丢弃。
	env.svc.handleLive2DAction(&sio.Socket{ID: "s-stranger"}, l2dArgs(t, `{"roomId":"ROOM_E","e":1}`))
	if len(env.hub.rooms) != 1 {
		t.Fatalf("非成员不应广播，实际 %v", env.hub.rooms)
	}

	// 越界下标：丢弃（0 是合法值，所以缺省与 0 必须区分）。
	for _, raw := range []string{`{"roomId":"ROOM_E","e":-1}`, `{"roomId":"ROOM_E","e":64}`, `{"roomId":"ROOM_E"}`} {
		env.svc.handleLive2DAction(&sio.Socket{ID: "s1"}, l2dArgs(t, raw))
	}
	if len(env.hub.rooms) != 1 {
		t.Fatalf("越界/缺参不应广播，实际 %v", env.hub.rooms)
	}
}
