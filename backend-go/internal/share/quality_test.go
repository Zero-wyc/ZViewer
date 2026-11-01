package share

import (
	"fmt"
	"testing"
	"time"
)

// qualityFrame 拼一帧观众侧质量证据。
func qualityFrame(revision int, connectionID string, window string) string {
	return fmt.Sprintf(
		`{"t":"share.quality","roomId":"r1","revision":%d,"connectionId":%q,"window":%s}`,
		revision, connectionID, window)
}

// 冻结成灾的窗口：2 秒里冻了 800ms。
const degradedWindow = `{"windowMs":2000,"framesPerSecond":12,"freezeCount":3,"freezeDurationMs":800,"packetLossRate":0.01,"jitterMs":20}`

// 健康窗口。
const healthyWindow = `{"windowMs":2000,"framesPerSecond":30,"freezeCount":0,"freezeDurationMs":0,"packetLossRate":0.001,"jitterMs":8}`

// reportQuality 让某位观众按它当前那条边上报一个窗口。
func reportQuality(t *testing.T, service *Service, session *Session, viewer, window string) {
	t.Helper()
	route := treeRoute(t, session, viewer)
	send(t, service, newConn(viewer, "r1"),
		qualityFrame(int(session.Revision()), route.ConnectionID, window))
}

// 连续两个降级窗口 → 换到一个可用的上游（这里是有画面的 viewer-1）。
func TestQualitySwitchesParentAfterPersistentDegradation(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	before := treeRoute(t, session, "viewer-2")
	if before.ParentPeerID != "host-1" {
		t.Fatalf("viewer-2 开局应在房主上，实际 %q", before.ParentPeerID)
	}

	// 第一个窗口只记账：单个窗口抖动就换父会让每次网络抽动都重连一次。
	reportQuality(t, service, session, "viewer-2", degradedWindow)
	if got := treeRoute(t, session, "viewer-2"); got.ParentPeerID != "host-1" {
		t.Fatalf("单个降级窗口不该换父，实际 %q", got.ParentPeerID)
	}

	reportQuality(t, service, session, "viewer-2", degradedWindow)
	after := treeRoute(t, session, "viewer-2")
	if after.ParentPeerID != "viewer-1" {
		t.Fatalf("持续降级应换到 viewer-1，实际 %q", after.ParentPeerID)
	}
	if after.ConnectionID == before.ConnectionID {
		t.Fatal("换父必须换 connectionId（换了对端就是另一条 PC）")
	}
	if after.Phase != PhasePrepare {
		t.Fatalf("换父后应回到 prepare，实际 %q", after.Phase)
	}
	// 换父后旧画面还在（不能把这位观众判成没源），只是要重连一次。
	if state, reason, switches := session.QualityReport("viewer-2"); switches != 1 {
		t.Fatalf("应记录 1 次质量换父，实际 %d（state=%s reason=%s）", switches, state, reason)
	}
}

// 健康窗口会把累计清零：一次抖动之后恢复，不该越攒越容易触发。
func TestQualityHealthyWindowResetsCounter(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	reportQuality(t, service, session, "viewer-2", degradedWindow)
	reportQuality(t, service, session, "viewer-2", healthyWindow)
	reportQuality(t, service, session, "viewer-2", degradedWindow)
	if got := treeRoute(t, session, "viewer-2"); got.ParentPeerID != "host-1" {
		t.Fatalf("中间的恢复窗口应清零累计，实际换到了 %q", got.ParentPeerID)
	}
}

// 观众自己解不动（解码耗时高、网络干净）→ 换上游没用，不该动。
func TestQualityViewerLimitedDoesNotSwitch(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"),
		`{"t":"share.start","roomId":"r1","qualitySettings":{"resolutionPreset":"1080p","frameRate":30,"maxBitrateMbps":8}}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	// 帧率 6fps、解码 45ms/帧，但没冻结、没丢包、抖动很低 → 本地 CPU 的问题。
	limited := `{"windowMs":2000,"framesPerSecond":6,"freezeCount":0,"freezeDurationMs":0,"packetLossRate":0.001,"jitterMs":5,"decodeMsPerFrame":45}`
	for attempt := 0; attempt < 4; attempt++ {
		reportQuality(t, service, session, "viewer-2", limited)
	}
	if got := treeRoute(t, session, "viewer-2"); got.ParentPeerID != "host-1" {
		t.Fatalf("观众自己解不动时不该换父，实际 %q", got.ParentPeerID)
	}
	state, reason, switches := session.QualityReport("viewer-2")
	if state != QualityViewerLimited || reason != "decode" || switches != 0 {
		t.Fatalf("应判成 viewer-limited/decode，实际 %s/%s switches=%d", state, reason, switches)
	}
}

// 冷却期内不连续换父：换完之后几个窗口内再报降级也不动。
func TestQualitySwitchCooldown(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	reportQuality(t, service, session, "viewer-2", degradedWindow)
	reportQuality(t, service, session, "viewer-2", degradedWindow)
	// 换到 viewer-1 之后先提交，边才回到可判定的状态。
	commitRoute(t, service, session, "viewer-2")
	switched := treeRoute(t, session, "viewer-2").ConnectionID

	for attempt := 0; attempt < 3; attempt++ {
		reportQuality(t, service, session, "viewer-2", degradedWindow)
	}
	if got := treeRoute(t, session, "viewer-2").ConnectionID; got != switched {
		t.Fatal("冷却期内不该再次换父")
	}
	if _, _, switches := session.QualityReport("viewer-2"); switches != 1 {
		t.Fatalf("应只有 1 次换父，实际 %d", switches)
	}
}

// 换父次数上限：反复变差也不会无限重连。
func TestQualitySwitchLimit(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	for round := 0; round < 4; round++ {
		// 把冷却时间戳往前拨，专测次数上限（否则第二轮就被冷却挡住）。
		session.mu.Lock()
		if report, ok := session.qualityReports["viewer-2"]; ok {
			report.lastSwitchAt = time.Now().Add(-2 * qualitySwitchCooldown)
		}
		session.mu.Unlock()
		reportQuality(t, service, session, "viewer-2", degradedWindow)
		reportQuality(t, service, session, "viewer-2", degradedWindow)
		if session.RoutePhase("viewer-2") == PhasePrepare {
			commitRoute(t, service, session, "viewer-2")
		}
	}
	if _, _, switches := session.QualityReport("viewer-2"); switches != qualityMaxSwitches {
		t.Fatalf("换父次数应封顶在 %d，实际 %d", qualityMaxSwitches, switches)
	}
}

// 被投诉过的上游在选父时靠后：它不排除，但只在没有别的选择时才用。
func TestQualityPenalizesComplainedParent(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	// viewer-2 在房主身上连续两次降级 → 房主被标记。
	reportQuality(t, service, session, "viewer-2", degradedWindow)
	reportQuality(t, service, session, "viewer-2", degradedWindow)

	// 后来者：房主深度更小（0 vs 1），正常排序会选房主；房主被投诉过，选 viewer-1。
	joinRoom(t, service, "viewer-3")
	if parent := treeRoute(t, session, "viewer-3").ParentPeerID; parent != "viewer-1" {
		t.Fatalf("应避开被投诉的房主，实际 %q", parent)
	}
}

// 版本对不上、连接身份对不上、边还没提交：一律忽略，且不留下累计。
func TestQualityRejectsStaleEvidence(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")

	route := treeRoute(t, session, "viewer-2")
	// 边还是 prepare：没有画面，谈不上质量。
	send(t, service, newConn("viewer-2", "r1"),
		qualityFrame(int(session.Revision()), route.ConnectionID, degradedWindow))
	if _, _, switches := session.QualityReport("viewer-2"); switches != 0 {
		t.Fatal("prepare 阶段的边不该被判定")
	}

	commitRoute(t, service, session, "viewer-2")
	// 过期版本。
	send(t, service, newConn("viewer-2", "r1"),
		qualityFrame(int(session.Revision()+7), treeRoute(t, session, "viewer-2").ConnectionID, degradedWindow))
	// 别人的连接身份。
	send(t, service, newConn("viewer-2", "r1"),
		qualityFrame(int(session.Revision()), treeRoute(t, session, "viewer-1").ConnectionID, degradedWindow))
	if got := treeRoute(t, session, "viewer-2"); got.ParentPeerID != "host-1" {
		t.Fatalf("过期证据不该换父，实际 %q", got.ParentPeerID)
	}
}

// 没有别的上游可选时，质量再差也留在原地（换父换不成就别断流）。
func TestQualityKeepsParentWhenNoAlternative(t *testing.T) {
	service, _ := newTreeService(TreePolicy{MaxDepth: 1})
	joinRoom(t, service, "host-1")
	joinRoom(t, service, "viewer-1")
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")

	before := treeRoute(t, session, "viewer-1").ConnectionID
	for attempt := 0; attempt < 4; attempt++ {
		reportQuality(t, service, session, "viewer-1", degradedWindow)
	}
	if got := treeRoute(t, session, "viewer-1"); got.ParentPeerID != "host-1" || got.ConnectionID != before {
		t.Fatal("没有别的上游时不该换父")
	}
	// 但账还是要记：这位观众确实在这条边上不好。
	if state, reason, _ := session.QualityReport("viewer-1"); state != QualityDegraded || reason != "freeze" {
		t.Fatalf("应记为 degraded/freeze，实际 %s/%s", state, reason)
	}
}

// 判据本身：窗口范围、缺字段、丢包、停滞归因。
func TestClassifyQualityWindow(t *testing.T) {
	num := func(value float64) *float64 { return &value }
	count := func(value int) *int { return &value }

	cases := []struct {
		name   string
		window QualityWindow
		fps    int
		state  QualityState
		reason string
	}{
		{
			name:   "窗口过短不判",
			window: QualityWindow{WindowMs: 400, FreezeCount: count(0), FreezeDurationMs: num(0)},
			fps:    30,
			state:  QualityUnknown,
			reason: "window",
		},
		{
			name:   "没有冻结统计就不下结论",
			window: QualityWindow{WindowMs: 2000},
			fps:    30,
			state:  QualityUnknown,
			reason: "no-freeze-stats",
		},
		{
			name:   "冻结占比过半",
			window: QualityWindow{WindowMs: 2000, FreezeCount: count(1), FreezeDurationMs: num(1200)},
			fps:    30,
			state:  QualityDegraded,
			reason: "freeze",
		},
		{
			name:   "丢包超阈值",
			window: QualityWindow{WindowMs: 2000, FreezeCount: count(0), FreezeDurationMs: num(0), PacketLossRate: num(0.2)},
			fps:    30,
			state:  QualityDegraded,
			reason: "loss",
		},
		{
			name:   "帧率低 + 抖动高 → 边的问题",
			window: QualityWindow{WindowMs: 2000, FreezeCount: count(0), FreezeDurationMs: num(0), FramesPerSecond: num(8), JitterMs: num(150)},
			fps:    30,
			state:  QualityDegraded,
			reason: "stall",
		},
		{
			name:   "帧率低但没有网络证据 → 源端问题，不换父",
			window: QualityWindow{WindowMs: 2000, FreezeCount: count(0), FreezeDurationMs: num(0), FramesPerSecond: num(8), JitterMs: num(10)},
			fps:    30,
			state:  QualityUnknown,
			reason: "source",
		},
		{
			name:   "一切正常",
			window: QualityWindow{WindowMs: 2000, FreezeCount: count(0), FreezeDurationMs: num(0), FramesPerSecond: num(29), PacketLossRate: num(0.01)},
			fps:    30,
			state:  QualityHealthy,
		},
	}
	for _, testCase := range cases {
		state, reason := classifyQualityWindow(testCase.window, testCase.fps)
		if state != testCase.state || reason != testCase.reason {
			t.Fatalf("%s: 期望 %s/%s，实际 %s/%s",
				testCase.name, testCase.state, testCase.reason, state, reason)
		}
	}
}

// 线上格式：缺 window、窗口超范围、未知字段一律拒。
func TestDecodeQualityMessage(t *testing.T) {
	message, err := DecodeClient([]byte(
		`{"t":"share.quality","roomId":"r1","revision":3,"connectionId":"route_x","window":{"windowMs":2000,"freezeCount":1}}`))
	if err != nil {
		t.Fatalf("合法证据应能解码：%v", err)
	}
	quality, ok := message.(QualityMessage)
	if !ok {
		t.Fatalf("应解码成 QualityMessage，实际 %T", message)
	}
	if quality.Revision != 3 || quality.Window.WindowMs != 2000 || quality.Window.FreezeCount == nil {
		t.Fatalf("字段没解全：%+v", quality)
	}

	bad := []string{
		`{"t":"share.quality","roomId":"r1","revision":3,"connectionId":"route_x"}`,
		`{"t":"share.quality","roomId":"r1","revision":3,"connectionId":"route_x","window":{"windowMs":10}}`,
		`{"t":"share.quality","roomId":"r1","revision":3,"connectionId":"route_x","window":{"windowMs":2000,"nope":1}}`,
	}
	for _, frame := range bad {
		if _, err := DecodeClient([]byte(frame)); err == nil {
			t.Fatalf("应拒绝：%s", frame)
		}
	}
}

// 中继模式下不换父：观众订的是 SFU 的发布，P2P 上游在下发时已被抹掉。
func TestQualityIgnoresRelaySessions(t *testing.T) {
	service, _ := newTreeService(TreePolicy{ViewerChildren: 2, MaxDepth: 3})
	joinRoom(t, service, "host-1")
	for _, viewer := range []string{"viewer-1", "viewer-2"} {
		joinRoom(t, service, viewer)
	}
	send(t, service, newConn("host-1", "r1"), `{"t":"share.start","roomId":"r1"}`)
	session := service.Session("r1")
	commitRoute(t, service, session, "viewer-1")
	commitRoute(t, service, session, "viewer-2")
	session.SetRelay(true)

	before := treeRoute(t, session, "viewer-2").ConnectionID
	for attempt := 0; attempt < 3; attempt++ {
		reportQuality(t, service, session, "viewer-2", degradedWindow)
	}
	if got := treeRoute(t, session, "viewer-2").ConnectionID; got != before {
		t.Fatal("中继模式不该因质量换父")
	}
	if _, _, switches := session.QualityReport("viewer-2"); switches != 0 {
		t.Fatalf("中继模式不该记录换父，实际 %d", switches)
	}
}
