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
	env.svc.Live2DUpdateState("ROOM_A", "s1", live2dStateUpdate{X: 0.4, Y: 0.6, AR: 1.7}, time.Now())
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
// 这一条守的是产品语义——服务端模型库里的模型如果不让观众选，这个功能对他们
// 就等于不存在；反过来如果不校验存在性，随便填 id 会让全房间加载失败。
func TestLive2DRoomModelSelectableByViewer(t *testing.T) {
	env := newTestEnv(t)
	l2dSession(t, env, "ROOM_R", "s-viewer", store.SessionRoleViewer)
	// 模型库是服务端公共的：checker 只认 modelId，与房间号无关。
	env.svc.SetLive2DModelChecker(func(modelID string) bool {
		return modelID == "hiyori-abc123"
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
	if out.SID != "s1" || out.E == nil || *out.E != 2 {
		t.Fatalf("广播内容不对：%+v", out)
	}
	if out.G != "" || out.I != nil {
		t.Fatalf("表情帧不该带动作组：%+v", out)
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

// 8) 面部姿态：带 m/e 才更新，不带就保持原值（动捕关掉后不能突然闭嘴）；越界钳制。
func TestLive2DFaceStickyAndClamped(t *testing.T) {
	env := newTestEnv(t)
	env.svc.Live2DSet("ROOM_F", live2dMember{
		SocketID: "s1", Name: "Alice", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})

	env.svc.handleLive2DState(&sio.Socket{ID: "s1"},
		l2dArgs(t, `{"roomId":"ROOM_F","x":0.5,"y":0.5,"a":1.7,"m":0.6,"e":0.2}`))
	m := env.svc.Live2DSnapshot("ROOM_F")[0]
	if m.Mouth != 0.6 || m.Eyes != 0.2 {
		t.Fatalf("面部姿态未写入：mouth=%v eyes=%v", m.Mouth, m.Eyes)
	}

	// 只指针、不带面部：必须保持，不能被当成「闭嘴全睁」
	base := time.Now().Add(time.Second)
	env.svc.Live2DUpdateState("ROOM_F", "s1", live2dStateUpdate{X: 0.2, Y: 0.3, AR: 1.6}, base)
	m = env.svc.Live2DSnapshot("ROOM_F")[0]
	if m.X != 0.2 {
		t.Fatalf("指针应已更新，实际 x=%v", m.X)
	}
	if m.Mouth != 0.6 || m.Eyes != 0.2 {
		t.Fatalf("不带面部数据时不应改动面部姿态：mouth=%v eyes=%v", m.Mouth, m.Eyes)
	}

	// 越界：钳到 0~1
	badMouth, badEyes := 5.0, -3.0
	env.svc.Live2DUpdateState("ROOM_F", "s1", live2dStateUpdate{
		X: 0.2, Y: 0.3, AR: 1.6, Mouth: &badMouth, Eyes: &badEyes,
	}, base.Add(time.Second))
	m = env.svc.Live2DSnapshot("ROOM_F")[0]
	if m.Mouth != 1 || m.Eyes != 0 {
		t.Fatalf("面部姿态未钳制：mouth=%v eyes=%v", m.Mouth, m.Eyes)
	}
}

// 9) 动作同步：g/i 原样广播；组名不在白名单、下标越界、缺字段一律丢弃。
func TestLive2DMotionBroadcast(t *testing.T) {
	env := newTestEnv(t)
	env.svc.Live2DSet("ROOM_M", live2dMember{
		SocketID: "s1", Name: "Alice", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})

	env.svc.handleLive2DAction(&sio.Socket{ID: "s1"}, l2dArgs(t, `{"roomId":"ROOM_M","g":"Idle","i":1}`))
	if len(env.hub.rooms) != 1 || env.hub.rooms[0] != "ROOM_M|live2d-action" {
		t.Fatalf("应广播一条 live2d-action，实际 %v", env.hub.rooms)
	}
	out, _ := env.hub.payloads["ROOM_M|live2d-action"][0].(live2dActionOut)
	if out.SID != "s1" || out.G != "Idle" || out.I == nil || *out.I != 1 {
		t.Fatalf("动作广播内容不对：%+v", out)
	}
	if out.E != nil {
		t.Fatalf("动作帧不该带表情下标：%+v", out)
	}

	// 换一条连接测非法输入（s1 的门限已经被上面那条用掉了）
	env.svc.Live2DSet("ROOM_M", live2dMember{
		SocketID: "s2", Name: "Bob", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})
	bad := []string{
		`{"roomId":"ROOM_M","g":"Idle 1","i":0}`,
		`{"roomId":"ROOM_M","g":"Idle;drop","i":0}`,
		`{"roomId":"ROOM_M","g":"` + strings.Repeat("A", 33) + `","i":0}`,
		`{"roomId":"ROOM_M","g":"Idle","i":-1}`,
		`{"roomId":"ROOM_M","g":"Idle","i":64}`,
		`{"roomId":"ROOM_M","g":"Idle"}`,
		`{"roomId":"ROOM_M","i":0}`,
	}
	for _, raw := range bad {
		env.svc.handleLive2DAction(&sio.Socket{ID: "s2"}, l2dArgs(t, raw))
	}
	if len(env.hub.rooms) != 1 {
		t.Fatalf("非法动作不应广播，实际 %v", env.hub.rooms)
	}
}

// 10) 合并下行：不在动捕时 u 行只有 4 项；动捕中才追加 m/e。
//
// 这一条守的是「整个房间都不再眨眼」那个坑：客户端只凭"有没有面部字段"
// 判断该不该接管模型的眼睛，所以服务端绝不能无条件补 0/1。
func TestLive2DStateRowFaceOptional(t *testing.T) {
	env := newTestEnv(t)
	env.hub.members["ROOM_U"] = []string{"s1"}
	env.svc.Live2DSet("ROOM_U", live2dMember{
		SocketID: "s1", Name: "Alice", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})
	env.svc.FlushLive2D() // 排掉 add

	lastUpd := func() [][]any {
		t.Helper()
		list := env.hub.payloads["ROOM_U|live2d-patch"]
		if len(list) == 0 {
			t.Fatal("没有下发 patch")
		}
		patch, ok := list[len(list)-1].(live2dPatchOut)
		if !ok {
			t.Fatalf("payload 类型不对：%T", list[len(list)-1])
		}
		return patch.Upd
	}

	env.svc.Live2DUpdateState("ROOM_U", "s1", live2dStateUpdate{X: 0.3, Y: 0.4, AR: 1.7}, time.Now())
	env.svc.FlushLive2D()
	upd := lastUpd()
	if len(upd) != 1 || len(upd[0]) != 4 {
		t.Fatalf("不在动捕时 u 行应为 4 项，实际 %v", upd)
	}

	mouth, eyes := 0.5, 0.3
	env.svc.Live2DUpdateState("ROOM_U", "s1", live2dStateUpdate{
		X: 0.31, Y: 0.41, AR: 1.7, Mouth: &mouth, Eyes: &eyes,
	}, time.Now().Add(time.Second))
	env.svc.FlushLive2D()
	upd = lastUpd()
	// 动捕中：m/e 后面固定跟三项姿态（嘴形/眉毛/歪头），共 9 项。
	// 没上报 pose 时是中性值 0.5，而不是 0——0 是「撇嘴 + 皱眉 + 歪到底」。
	if len(upd) != 1 || len(upd[0]) != 9 {
		t.Fatalf("动捕中 u 行应带 m/e 与三项姿态（9 项），实际 %v", upd)
	}
	if got := upd[0][4]; got != 0.5 {
		t.Fatalf("m 值不对：%v", got)
	}
	if got := upd[0][5]; got != 0.3 {
		t.Fatalf("e 值不对：%v", got)
	}
	for i := 6; i < 9; i++ {
		if got := upd[0][i]; got != live2dDefaultPose {
			t.Fatalf("第 %d 项应为中性 %v，实际 %v", i, live2dDefaultPose, got)
		}
	}
}

// 10b) 表情细节/歪头：长度不对整条忽略；越界钳制；与 m/e 共享 faceAt 时效。
func TestLive2DPoseClampedAndLengthChecked(t *testing.T) {
	env := newTestEnv(t)
	env.hub.members["ROOM_P"] = []string{"s1"}
	env.svc.Live2DSet("ROOM_P", live2dMember{
		SocketID: "s1", Name: "Alice", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})
	env.svc.FlushLive2D() // 排掉 add 行

	mouth, eyes := 0.4, 0.8
	base := time.Now()

	// 长度 2：整条姿态忽略，m/e 仍生效
	env.svc.Live2DUpdateState("ROOM_P", "s1", live2dStateUpdate{
		X: 0.5, Y: 0.5, AR: 1.7, Mouth: &mouth, Eyes: &eyes,
		Pose: []float64{0.9, 0.1},
	}, base)
	m := env.svc.Live2DSnapshot("ROOM_P")[0]
	if m.Mouth != 0.4 {
		t.Fatalf("m 应生效：%v", m.Mouth)
	}
	if m.Form != live2dDefaultPose || m.Brow != live2dDefaultPose {
		t.Fatalf("长度不对时姿态不应被写入：form=%v brow=%v", m.Form, m.Brow)
	}

	// 正常三项，其中一项越界：逐项钳制
	env.svc.Live2DUpdateState("ROOM_P", "s1", live2dStateUpdate{
		X: 0.5, Y: 0.5, AR: 1.7,
		Pose: []float64{1.7, -0.4, 0.25},
	}, base.Add(time.Second))
	m = env.svc.Live2DSnapshot("ROOM_P")[0]
	if m.Form != 1 || m.Brow != 0 || m.Roll != 0.25 {
		t.Fatalf("姿态未钳制：form=%v brow=%v roll=%v", m.Form, m.Brow, m.Roll)
	}

	// 只有姿态、没有 m/e：同样算一帧面部数据，u 行照样带满 9 项
	env.svc.Live2DUpdateState("ROOM_P", "s1", live2dStateUpdate{
		X: 0.5, Y: 0.5, AR: 1.7, Pose: []float64{0.5, 0.5, 0.7},
	}, base.Add(2*time.Second))
	env.svc.FlushLive2D()
	list := env.hub.payloads["ROOM_P|live2d-patch"]
	if len(list) == 0 {
		t.Fatal("没有下发 patch")
	}
	patch := list[len(list)-1].(live2dPatchOut)
	if len(patch.Upd) != 1 || len(patch.Upd[0]) != 9 {
		t.Fatalf("带姿态的 u 行应为 9 项，实际 %v", patch.Upd)
	}
	if got := patch.Upd[0][8]; got != 0.7 {
		t.Fatalf("歪头未下发：%v", got)
	}
}

// 11) 房间角色策略：只有房主能改；只带一个字段时其余保持不动。
func TestLive2DPolicyHostOnlyAndMerge(t *testing.T) {
	env := newTestEnv(t)
	l2dSession(t, env, "ROOM_P", "s-host", store.SessionRoleSharer)
	l2dSession(t, env, "ROOM_P", "s-viewer", store.SessionRoleViewer)

	emit := func(socketID, raw string) AckResponse {
		t.Helper()
		var ack AckResponse
		env.svc.handleLive2DPolicySet(&sio.Socket{ID: socketID}, l2dArgs(t, raw),
			func(v ...any) {
				if len(v) > 0 {
					ack, _ = v[0].(AckResponse)
				}
			})
		return ack
	}

	if ack := emit("s-viewer", `{"roomId":"ROOM_P","allowFace":false}`); ack.Success {
		t.Fatal("观众不应能改房间角色策略")
	}
	if p := env.svc.Live2DPolicy("ROOM_P"); !p.AllowFace || !p.ShowToViewers {
		t.Fatalf("被拒绝的请求不应改动策略：%+v", p)
	}

	if ack := emit("s-host", `{"roomId":"ROOM_P","allowFace":false}`); !ack.Success {
		t.Fatalf("房主应能改策略：%+v", ack)
	}
	p := env.svc.Live2DPolicy("ROOM_P")
	if p.AllowFace {
		t.Fatal("allowFace 应已关闭")
	}
	if !p.ShowToViewers || p.Unified {
		t.Fatalf("没提到的字段应保持默认：%+v", p)
	}
	if !env.hub.hasRoomEvent("ROOM_P", "live2d-policy") {
		t.Fatal("策略变更应广播给全房间")
	}
}

// 12) 统一角色：没选模型不放行；模型库里的模型必须真的存在；切换后进房快照也带着策略。
func TestLive2DPolicyUnifiedModel(t *testing.T) {
	env := newTestEnv(t)
	l2dSession(t, env, "ROOM_U2", "s-host", store.SessionRoleSharer)
	env.svc.SetLive2DModelChecker(func(modelID string) bool {
		return modelID == "m-ok"
	})

	emit := func(raw string) AckResponse {
		t.Helper()
		var ack AckResponse
		env.svc.handleLive2DPolicySet(&sio.Socket{ID: "s-host"}, l2dArgs(t, raw),
			func(v ...any) {
				if len(v) > 0 {
					ack, _ = v[0].(AckResponse)
				}
			})
		return ack
	}

	if ack := emit(`{"roomId":"ROOM_U2","unified":true}`); ack.Success {
		t.Fatal("打开统一角色但没选模型应被拒")
	}
	if ack := emit(`{"roomId":"ROOM_U2","unified":true,"unifiedKind":"room","unifiedId":"nope"}`); ack.Success {
		t.Fatal("不存在的房间模型应被拒")
	}
	if ack := emit(`{"roomId":"ROOM_U2","unified":true,"unifiedKind":"room","unifiedId":"m-ok"}`); !ack.Success {
		t.Fatalf("合法的统一模型应放行：%+v", ack)
	}
	p := env.svc.Live2DPolicy("ROOM_U2")
	if !p.Unified || p.UnifiedKind != "room" || p.UnifiedID != "m-ok" {
		t.Fatalf("统一模型没写进去：%+v", p)
	}

	// 进房快照必须带着策略（否则新人看到的还是各显示各的）
	env.svc.handleLive2DRequest(&sio.Socket{ID: "s-host"}, l2dArgs(t, `{"roomId":"ROOM_U2"}`))
	var snap live2dSnapshotOut
	for _, item := range env.hub.payloads["s-host|live2d-snapshot"] {
		if v, ok := item.(live2dSnapshotOut); ok {
			snap = v
		}
	}
	if !snap.Policy.Unified || snap.Policy.UnifiedID != "m-ok" {
		t.Fatalf("快照没带策略：%+v", snap.Policy)
	}
}

// 13) 拖拽偏移：本人可写、越界钳制、走独立的 d 行，快照里也带着。
//
// 这一条守两件事：一是「拖动位置必须同步给全房间」（否则别人看到的还是
// 槽位原位，两个人对同一幕的认知就对不上了）；二是 d 行不能挤进 u 行——
// u 行已经靠「有没有第 5 项」判断要不要接管模型的嘴和眼。
func TestLive2DDragSync(t *testing.T) {
	env := newTestEnv(t)
	env.hub.members["ROOM_DRAG"] = []string{"s1", "s2"}
	for _, sid := range []string{"s1", "s2"} {
		env.svc.Live2DSet("ROOM_DRAG", live2dMember{
			SocketID: sid, Name: sid, Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
		})
	}
	env.svc.FlushLive2D() // 排掉 add

	lastPatch := func() live2dPatchOut {
		t.Helper()
		list := env.hub.payloads["ROOM_DRAG|live2d-patch"]
		if len(list) == 0 {
			t.Fatal("没有下发 patch")
		}
		patch, ok := list[len(list)-1].(live2dPatchOut)
		if !ok {
			t.Fatalf("payload 类型不对：%T", list[len(list)-1])
		}
		return patch
	}

	// 没声明过模型的连接写不进偏移（否则能凭空改一个不存在成员的位置）
	env.svc.handleLive2DDrag(&sio.Socket{ID: "s-intruder"},
		l2dArgs(t, `{"roomId":"ROOM_DRAG","x":0.2,"y":-0.2}`))
	env.svc.FlushLive2D()
	if rows := lastPatch(); len(rows.Drag) != 0 {
		t.Fatalf("未声明的连接不应写着偏移：%v", rows.Drag)
	}

	// 本人拖动：只出 d 行，u 行保持干净
	env.svc.handleLive2DDrag(&sio.Socket{ID: "s1"},
		l2dArgs(t, `{"roomId":"ROOM_DRAG","x":0.2,"y":-0.3}`))
	env.svc.FlushLive2D()
	patch := lastPatch()
	if len(patch.Drag) != 1 || len(patch.Drag[0]) != 3 {
		t.Fatalf("应有一条三元的 d 行，实际 %v", patch.Drag)
	}
	if patch.Drag[0][0] != "s1" || patch.Drag[0][1] != 0.2 || patch.Drag[0][2] != -0.3 {
		t.Fatalf("d 行内容不对：%v", patch.Drag[0])
	}
	if len(patch.Upd) != 0 {
		t.Fatalf("只拖位置不该发 u 行：%v", patch.Upd)
	}

	// 越界钳制 + 40ms 频控：直接调 store，时间自己给，避免测试里 sleep
	st := env.svc.live2d
	base := time.Now().Add(2 * time.Second)
	if !st.SetDrag("ROOM_DRAG", "s1", 1.0, -2.0, base) {
		t.Fatal("第一次拖拽应写入")
	}
	if st.SetDrag("ROOM_DRAG", "s1", 0.1, 0.0, base.Add(10*time.Millisecond)) {
		t.Fatal("40ms 内的重复上报应被丢弃")
	}
	env.svc.FlushLive2D()
	patch = lastPatch()
	if len(patch.Drag) != 1 {
		t.Fatalf("应只有一条 d 行，实际 %v", patch.Drag)
	}
	// x 越界到 0.45、y 越界到 -0.55（向下只留 0.10 的余量，这里挤到最小值）
	if patch.Drag[0][1] != live2dDragXLimit || patch.Drag[0][2] != live2dDragYMin {
		t.Fatalf("越界没有钳制：%v", patch.Drag[0])
	}

	// 快照必须带着偏移（新进房的人要看到别人已经挪过的位置）
	snap := env.svc.Live2DSnapshot("ROOM_DRAG")
	for _, m := range snap {
		if m.SocketID != "s1" {
			continue
		}
		row := live2dRow(m)
		if len(row) != 16 {
			t.Fatalf("整行应为 16 项（含拖拽偏移与三项姿态），实际 %d 项", len(row))
		}
		if row[11] != live2dDragXLimit || row[12] != live2dDragYMin {
			t.Fatalf("整行第 11/12 项应是拖拽偏移，实际 %v", row[11:13])
		}
		if row[13] != live2dDefaultPose || row[14] != live2dDefaultPose || row[15] != live2dDefaultPose {
			t.Fatalf("整行末尾应是中性姿态，实际 %v", row[13:])
		}
	}
}

// 10c) 隐藏再显示应回到原来的排位。
//
// 排位决定画面里的站位。如果"隐藏→显示"把人推到队尾，用户看到的是"我的角色
// 跑到最右边去了"；人一多还会掉出前 N 个渲染名额（前端只画 ord 最小的若干
// 个），于是"我明明有角色却看不见自己"——没有任何提示，最难自查的一类故障。
func TestLive2DReappearKeepsSlot(t *testing.T) {
	env := newTestEnv(t)
	const room = "ROOM_ORD"
	for _, id := range []string{"s1", "s2", "s3"} {
		if !env.svc.Live2DSet(room, live2dMember{
			SocketID: id, Name: id, Kind: "builtin", ModelID: "hiyori", Scale: 1,
		}) {
			t.Fatalf("声明 %s 失败", id)
		}
	}
	before := map[string]int64{}
	for _, m := range env.svc.Live2DSnapshot(room) {
		before[m.SocketID] = m.Ord
	}

	// s2 隐藏（服务端就是移除名册条目）
	if !env.svc.Live2DRemove(room, "s2") {
		t.Fatal("移除 s2 失败")
	}
	// 再显示
	if !env.svc.Live2DSet(room, live2dMember{
		SocketID: "s2", Name: "s2", Kind: "builtin", ModelID: "hiyori", Scale: 1,
	}) {
		t.Fatal("重新声明 s2 失败")
	}

	var got int64
	for _, m := range env.svc.Live2DSnapshot(room) {
		if m.SocketID == "s2" {
			got = m.Ord
		}
	}
	if got != before["s2"] {
		t.Fatalf("重新显示后应回到原排位 %d，实际 %d", before["s2"], got)
	}
}

// 10d) 中间空出来的排位要被下一个人复用。
//
// 否则长期运行的房间里 ord 只增不减：先是数字膨胀，更要紧的是"第 40 号"这种
// 排位一旦超过渲染名额，本人就永远排不上。
func TestLive2DOrdReusesGap(t *testing.T) {
	env := newTestEnv(t)
	const room = "ROOM_ORD2"
	for _, id := range []string{"s1", "s2", "s3"} {
		env.svc.Live2DSet(room, live2dMember{
			SocketID: id, Name: id, Kind: "builtin", ModelID: "hiyori", Scale: 1,
		})
	}
	// 腾出中间那一格
	env.svc.Live2DRemove(room, "s2")
	env.svc.Live2DSet(room, live2dMember{
		SocketID: "s4", Name: "s4", Kind: "builtin", ModelID: "hiyori", Scale: 1,
	})

	var ord int64
	for _, m := range env.svc.Live2DSnapshot(room) {
		if m.SocketID == "s4" {
			ord = m.Ord
		}
	}
	if ord != 2 {
		t.Fatalf("新人应填进空出来的 2 号位，实际 %d", ord)
	}
}

// 11) 一个用户只能有一个角色。
//
// 名册按 socket 组织，所以「同一用户的两个连接」会变成两个角色：重连窗口里
// （旧连接还没被服务端判死、新连接已经声明）画面上就是"我自己站在两个位置"，
// 而观众各有各的一份名册，谁也说不清哪个才是真的。
//
// 归并按 Identity（登录用户 userId / 游客 guestId），**新连接顶替旧记录并
// 接住旧排位**，旧 socket 以 rem 行下发。
func TestLive2DOneModelPerUser(t *testing.T) {
	env := newTestEnv(t)
	const room = "ROOM_ONE_PER_USER"
	env.hub.members[room] = []string{"s-old", "s-new"}

	env.svc.Live2DSet(room, live2dMember{
		SocketID: "s-old", Identity: "u:7", Name: "Alice",
		Kind: "builtin", ModelID: "hiyori", Scale: 1,
	})
	env.svc.Live2DSet(room, live2dMember{
		SocketID: "s-new", Identity: "u:7", Name: "Alice",
		Kind: "builtin", ModelID: "hiyori", Scale: 1,
	})

	snap := env.svc.Live2DSnapshot(room)
	if len(snap) != 1 {
		t.Fatalf("同一用户只应有一个角色，实际 %d 个：%+v", len(snap), snap)
	}
	if snap[0].SocketID != "s-new" {
		t.Fatalf("应保留最新的连接，实际 %s", snap[0].SocketID)
	}
	if snap[0].Ord != 1 {
		t.Fatalf("顶替后应接住旧排位 1，实际 %d", snap[0].Ord)
	}

	env.svc.FlushLive2D()
	patches := env.hub.payloads[room+"|live2d-patch"]
	if len(patches) == 0 {
		t.Fatal("顶替后应下发一条 patch")
	}
	patch, ok := patches[len(patches)-1].(live2dPatchOut)
	if !ok {
		t.Fatalf("patch 类型意外：%T", patches[len(patches)-1])
	}
	if len(patch.Rem) != 1 || patch.Rem[0] != "s-old" {
		t.Fatalf("被顶替的旧 socket 应以 rem 行下发，实际 %v", patch.Rem)
	}
}

// 12) 不同用户、以及无法识别身份的连接之间不得互相顶替。
//
// 这是上一条的边界：游客共享 userId=0，若按它归并，全房间游客会一个接一个
// 把对方挤掉；同理两个没有 guestId 的连接必须各占一格。
func TestLive2DIdentityDoesNotMergeStrangers(t *testing.T) {
	env := newTestEnv(t)
	const room = "ROOM_IDENT_SPLIT"

	for _, m := range []live2dMember{
		{SocketID: "a", Identity: "u:1", Kind: "builtin", ModelID: "hiyori", Scale: 1},
		{SocketID: "b", Identity: "u:2", Kind: "builtin", ModelID: "hiyori", Scale: 1},
		{SocketID: "c", Identity: "", Kind: "builtin", ModelID: "hiyori", Scale: 1},
		{SocketID: "d", Identity: "", Kind: "builtin", ModelID: "hiyori", Scale: 1},
	} {
		if !env.svc.Live2DSet(room, m) {
			t.Fatalf("声明 %s 失败", m.SocketID)
		}
	}

	if n := env.svc.Live2DCount(room); n != 4 {
		t.Fatalf("不同身份不应互相顶替，实际只剩 %d 个", n)
	}
}

// 13) 身份标识：登录用户按 userId，游客按 guestId，都没有才放弃归并。
//
// 游客共享 userId=0，若按它归并，房间里所有游客会一个接一个把对方挤掉——
// 这是「一个用户一个角色」最容易写错的一处。
func TestLive2DIdentityKey(t *testing.T) {
	cases := []struct {
		name string
		data map[string]any
		want string
	}{
		{"登录用户", map[string]any{"userId": int64(7), "guestId": "g1"}, "u:7"},
		// float64 是 JSON 解码后的常见形态，必须一视同仁
		{"登录用户（float 形态）", map[string]any{"userId": float64(7)}, "u:7"},
		{"游客共享 userId=0", map[string]any{"userId": int64(0), "guestId": "g1"}, "g:g1"},
		{"只有 guestId", map[string]any{"guestId": "g2"}, "g:g2"},
		{"空身份不归并", map[string]any{"userId": int64(0)}, ""},
		{"无任何身份", map[string]any{}, ""},
	}
	for _, tc := range cases {
		if got := live2dIdentity(&sio.Socket{Data: tc.data}); got != tc.want {
			t.Fatalf("%s: 期望 %q，实际 %q", tc.name, tc.want, got)
		}
	}
}

// 20) 公共库模型被删：正在用它的人要被摘掉并收到原因，统一角色指向它要关掉。
//
// 场景是跨房间的：删模型的人可能根本不在用它的房间里（库是全服的），
// 所以清理只能由服务端扫全量名册完成——客户端没有这个视野。
func TestLive2DModelRemoved(t *testing.T) {
	env := newTestEnv(t)
	env.hub.members["ROOM_M1"] = []string{"s-user", "s-other"}
	env.hub.members["ROOM_M2"] = []string{"s-far"}

	// 两个房间、三个成员：两个用被删的那套、一个用别的
	env.svc.Live2DSet("ROOM_M1", live2dMember{
		SocketID: "s-user", Name: "user", Kind: "room", ModelID: "m-gone", Scale: 1, AR: 1.7,
	})
	env.svc.Live2DSet("ROOM_M1", live2dMember{
		SocketID: "s-other", Name: "other", Kind: "builtin", ModelID: "hiyori", Scale: 1, AR: 1.7,
	})
	env.svc.Live2DSet("ROOM_M2", live2dMember{
		SocketID: "s-far", Name: "far", Kind: "room", ModelID: "m-gone", Scale: 1, AR: 1.7,
	})
	// 另一个房间的统一角色也指着它
	env.svc.setLive2DPolicy("ROOM_M2", live2dPolicy{
		AllowFace: true, ShowToViewers: true,
		Unified: true, UnifiedKind: "room", UnifiedID: "m-gone",
	})

	env.svc.Live2DModelRemoved("m-gone")

	if n := env.svc.Live2DCount("ROOM_M1"); n != 1 {
		t.Fatalf("只应摘掉用被删模型的成员，ROOM_M1 剩 %d 个", n)
	}
	if n := env.svc.Live2DCount("ROOM_M2"); n != 0 {
		t.Fatalf("ROOM_M2 的成员应被摘掉，剩 %d 个", n)
	}
	if !env.svc.Live2DHas("ROOM_M1", "s-other") {
		t.Fatal("用别的模型的人不该被牵连")
	}

	// rem 行必须带被摘掉的 sid，客户端据此把画面删掉
	remSeen := false
	for _, item := range env.hub.payloads["ROOM_M1|live2d-patch"] {
		if patch, ok := item.(live2dPatchOut); ok {
			for _, sid := range patch.Rem {
				if sid == "s-user" {
					remSeen = true
				}
			}
		}
	}
	if !remSeen {
		t.Fatal("被摘掉的成员应以 rem 行下发")
	}

	// 只发 rem 的话用户只会看到角色凭空消失，必须同时说清原因
	var notice live2dModelRemovedOut
	for _, item := range env.hub.payloads["ROOM_M1|live2d-model-removed"] {
		if v, ok := item.(live2dModelRemovedOut); ok {
			notice = v
		}
	}
	if notice.ModelID != "m-gone" || notice.RoomID != "ROOM_M1" {
		t.Fatalf("缺少「模型已删除」通知：%+v", notice)
	}
	if !env.hub.hasRoomEvent("ROOM_M2", "live2d-model-removed") {
		t.Fatal("另一个使用中的房间也要收到通知")
	}

	// 统一角色指向死模型：必须关掉并广播，否则全房间一直声明一个不存在的模型
	p := env.svc.Live2DPolicy("ROOM_M2")
	if p.Unified || p.UnifiedID != "" || p.UnifiedKind != "" {
		t.Fatalf("统一角色应被关闭并清空模型：%+v", p)
	}
	if !env.hub.hasRoomEvent("ROOM_M2", "live2d-policy") {
		t.Fatal("关闭统一角色要广播给房间")
	}
}
