package room

import (
	"context"
	"errors"
	"testing"
)

// ==================== 传输延迟补偿 ====================

func TestCompensateTransportDelay(t *testing.T) {
	const now = int64(1_700_000_000_000)

	cases := []struct {
		name string
		in   TransportDelayParams
		want float64
	}{
		{
			name: "没传 clientTs 原样返回",
			in:   TransportDelayParams{CurrentTime: 100, PlaybackRate: 1, IsPlaying: true, Now: now},
			want: 100,
		},
		{
			name: "暂停态不补偿",
			in:   TransportDelayParams{CurrentTime: 100, ClientTs: now - 500, PlaybackRate: 1, IsPlaying: false, Now: now},
			want: 100,
		},
		{
			name: "倍速非法不补偿",
			in:   TransportDelayParams{CurrentTime: 100, ClientTs: now - 500, PlaybackRate: 0, IsPlaying: true, Now: now},
			want: 100,
		},
		{
			// 客户端时钟快于服务器（clientTs 在 now 之后）：钳为 0，不回拨
			name: "负延迟不回拨",
			in:   TransportDelayParams{CurrentTime: 100, ClientTs: now + 500, PlaybackRate: 1, IsPlaying: true, Now: now},
			want: 100,
		},
		{
			name: "正常补偿 200ms",
			in:   TransportDelayParams{CurrentTime: 100, ClientTs: now - 200, PlaybackRate: 1, IsPlaying: true, Now: now},
			want: 100.2,
		},
		{
			name: "带倍速补偿",
			in:   TransportDelayParams{CurrentTime: 100, ClientTs: now - 200, PlaybackRate: 2, IsPlaying: true, Now: now},
			want: 100.4,
		},
		{
			// 超过上限按 1.5s 算，防止异常钟差造成大跳变
			name: "延迟超上限钳位",
			in:   TransportDelayParams{CurrentTime: 100, ClientTs: now - 30_000, PlaybackRate: 1, IsPlaying: true, Now: now},
			want: 101.5,
		},
	}
	for _, c := range cases {
		got := CompensateTransportDelay(c.in)
		if diff := got - c.want; diff > 1e-9 || diff < -1e-9 {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestNeedsProgressSync(t *testing.T) {
	const now = int64(1_700_000_000_000)
	base := NeedsProgressSyncParams{
		ClientCurrentTime:  100,
		ClientIsPlaying:    true,
		ClientPlaybackRate: 1,
		ServerCurrentTime:  100,
		ServerIsPlaying:    true,
		Now:                now,
	}

	if NeedsProgressSync(base) {
		t.Error("完全一致时不该要求同步")
	}

	// 播放/暂停分歧无条件要求同步（通常意味着控制事件或心跳丢了）
	mismatch := base
	mismatch.ClientIsPlaying = false
	if !NeedsProgressSync(mismatch) {
		t.Error("isPlaying 分歧必须要求同步")
	}

	// 容差内不触发：9s < 10s
	near := base
	near.ClientCurrentTime = 91
	if NeedsProgressSync(near) {
		t.Error("容差内不该要求同步")
	}

	// 超容差触发：12s > 10s
	far := base
	far.ClientCurrentTime = 112
	if !NeedsProgressSync(far) {
		t.Error("超容差必须要求同步")
	}

	// 倍速非法时按 1 补偿，不 panic、不误判
	badRate := base
	badRate.ClientPlaybackRate = 0
	if NeedsProgressSync(badRate) {
		t.Error("倍速非法应按 1 处理，进度一致时不该同步")
	}
}

// ==================== 播放记忆写入与节流 ====================

func TestSetPlaybackWritesThroughThrottle(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMPB01", &owner, 10, false)

	mem := env.svc.Playback
	first := Playback{
		SourceURL:    "https://example.com/a.m3u8",
		SourceType:   "url",
		IsPlaying:    true,
		CurrentTime:  100,
		PlaybackRate: 1,
		Duration:     3600,
	}
	if err := mem.SetPlayback(ctx, "ROOMPB01", first, "sock-host", 0, nil); err != nil {
		t.Fatalf("首次写入失败: %v", err)
	}
	// 首次写入必然落盘（lastDBWriteAt 为 0，超出任何节流窗口）
	if got := dbCurrentTime(t, env, "ROOMPB01"); got != 100 {
		t.Fatalf("首次写入应立刻落盘，DB currentTime=%v", got)
	}

	// 第二次在 2s 窗口内：内存更新，DB 不动
	second := first
	second.CurrentTime = 200
	if err := mem.SetPlayback(ctx, "ROOMPB01", second, "sock-host", 0, nil); err != nil {
		t.Fatalf("二次写入失败: %v", err)
	}
	if got := dbCurrentTime(t, env, "ROOMPB01"); got != 100 {
		t.Fatalf("节流窗口内不该落盘，DB currentTime=%v", got)
	}
	cached, err := mem.Raw(ctx, "ROOMPB01")
	if err != nil {
		t.Fatalf("读缓存失败: %v", err)
	}
	if cached.CurrentTime != 200 {
		t.Fatalf("内存应已更新到 200，实际 %v", cached.CurrentTime)
	}

	// 显式 flush 后落盘
	if err := mem.FlushToDB(ctx, "ROOMPB01"); err != nil {
		t.Fatalf("落盘失败: %v", err)
	}
	if got := dbCurrentTime(t, env, "ROOMPB01"); got != 200 {
		t.Fatalf("flush 后 DB 应为 200，实际 %v", got)
	}
}

func TestSetPlaybackKeepsHostSocketID(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMPB02", &owner, 10, false)

	mem := env.svc.Playback
	state := Playback{SourceURL: "u", SourceType: "url", PlaybackRate: 1}
	if err := mem.SetPlayback(ctx, "ROOMPB02", state, "sock-host", 0, nil); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if got := mem.HostSocketID("ROOMPB02"); got != "sock-host" {
		t.Fatalf("hostSocketId 应为 sock-host，实际 %q", got)
	}

	// 后续整体覆盖 state 时不能再传 hostSocketId，也不能把它清掉：
	// 否则 isHostOnline 会在房主在线时返回 false，服务器心跳与房主广播打架。
	if err := mem.SetPlayback(ctx, "ROOMPB02", state, "", 0, nil); err != nil {
		t.Fatalf("二次写入失败: %v", err)
	}
	if got := mem.HostSocketID("ROOMPB02"); got != "sock-host" {
		t.Fatalf("hostSocketId 应被保留，实际 %q", got)
	}
}

func TestApplyHostHeartbeatSkipsWithoutCache(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMPB03", &owner, 10, false)

	// 没有完整状态时，心跳不能凭空造一条（缺 sourceUrl，观众会拿到空源）
	if err := env.svc.Playback.ApplyHostHeartbeat(ctx, "ROOMPB03", HostHeartbeat{
		CurrentTime: 10, IsPlaying: true, PlaybackRate: 1,
	}, 0); err != nil {
		t.Fatalf("心跳失败: %v", err)
	}
	if env.svc.Playback.HasCache("ROOMPB03") {
		t.Fatal("无既有状态时不该创建缓存")
	}
	if _, err := env.svc.Playback.Raw(ctx, "ROOMPB03"); !errors.Is(err, ErrNoPlayback) {
		t.Fatalf("应报 ErrNoPlayback，实际 %v", err)
	}
}

func TestApplyHostHeartbeatUpdatesMemory(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMPB04", &owner, 10, false)

	mem := env.svc.Playback
	if err := mem.SetPlayback(ctx, "ROOMPB04", Playback{
		SourceURL: "u", SourceType: "url", CurrentTime: 100, PlaybackRate: 1, IsPlaying: false,
	}, "sock-host", 0, nil); err != nil {
		t.Fatalf("写入失败: %v", err)
	}

	if err := mem.ApplyHostHeartbeat(ctx, "ROOMPB04", HostHeartbeat{
		CurrentTime: 500, IsPlaying: true, PlaybackRate: 1.5,
	}, 0); err != nil {
		t.Fatalf("合并心跳失败: %v", err)
	}

	raw, err := mem.Raw(ctx, "ROOMPB04")
	if err != nil {
		t.Fatalf("读原始状态失败: %v", err)
	}
	if raw.CurrentTime != 500 || !raw.IsPlaying || raw.PlaybackRate != 1.5 {
		t.Fatalf("心跳未合并进内存: %+v", raw)
	}
	// 源信息不能被心跳覆盖：心跳只有进度字段
	if raw.SourceURL != "u" || raw.SourceType != "url" {
		t.Fatalf("心跳把源信息覆盖了: %+v", raw)
	}
}

func TestClearRemovesCacheAndRow(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMPB05", &owner, 10, false)

	mem := env.svc.Playback
	if err := mem.SetPlayback(ctx, "ROOMPB05", Playback{
		SourceURL: "u", SourceType: "url", PlaybackRate: 1,
	}, "sock-host", 0, nil); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := mem.Clear(ctx, "ROOMPB05"); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	if mem.HasCache("ROOMPB05") {
		t.Fatal("缓存应已删除")
	}
	var n int
	if err := env.db.QueryRow(`SELECT COUNT(*) FROM "playback_states" WHERE "roomId"='ROOMPB05'`).Scan(&n); err != nil {
		t.Fatalf("计数失败: %v", err)
	}
	if n != 0 {
		t.Fatalf("DB 行应已删除，实际 %d 行", n)
	}
}

func dbCurrentTime(t *testing.T, env *testEnv, roomID string) float64 {
	t.Helper()
	var v float64
	if err := env.db.QueryRow(
		`SELECT "currentTime" FROM "playback_states" WHERE "roomId" = ?`, roomID).Scan(&v); err != nil {
		t.Fatalf("读 playback_states 失败: %v", err)
	}
	return v
}
