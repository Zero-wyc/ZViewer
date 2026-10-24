package room

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"zviewer/backend/internal/store"
)

// 阶段 13：一起听的单元测试。
//
// 覆盖三块「对拍测不到」的细节：
//   - 校验函数的边界（payload 缺字段 / 非法前缀 / 负数进度），对拍只能证明
//     「两侧对同一输入给出同一结果」，证明不了这个结果是对的；
//   - 外推到歌曲时长后的凝固（需要等真实时间流逝，驱动器里做不了）；
//   - 传输延迟补偿的两端钳位（负延迟不回拨、超 1.5s 截断）。

func TestMusicStateFromPayload(t *testing.T) {
	base := func(overrides map[string]any) map[string]json.RawMessage {
		m := map[string]any{
			"trackSongId": float64(1001),
			"trackKey":    "ncm:1001",
			"isPlaying":   true,
			"positionSec": 12.5,
			"playMode":    "sequence",
			"updatedAt":   float64(1700000000000),
		}
		for k, v := range overrides {
			if v == nil {
				delete(m, k)
				continue
			}
			m[k] = v
		}
		out := make(map[string]json.RawMessage, len(m))
		for k, v := range m {
			b, _ := json.Marshal(v)
			out[k] = b
		}
		return out
	}

	t.Run("完整载荷", func(t *testing.T) {
		st := musicStateFromPayload(base(nil))
		if st == nil {
			t.Fatal("合法载荷不应返回 nil")
		}
		if st.TrackSongID == nil || *st.TrackSongID != 1001 {
			t.Errorf("trackSongId = %v", st.TrackSongID)
		}
		if derefString(st.TrackKey) != "ncm:1001" {
			t.Errorf("trackKey = %q", derefString(st.TrackKey))
		}
		if !st.IsPlaying || st.PositionSec != 12.5 || st.PlayMode != MusicPlaySequence {
			t.Errorf("状态字段不对: %+v", st)
		}
	})

	t.Run("trackSongId 与 trackKey 为 null 时合法（B站 曲目）", func(t *testing.T) {
		st := musicStateFromPayload(base(map[string]any{
			"trackSongId": nil,
			"trackKey":    nil,
		}))
		if st == nil {
			t.Fatal("null 曲目应合法")
		}
		if st.TrackSongID != nil || st.TrackKey != nil {
			t.Errorf("应为 nil: %+v", st)
		}
	})

	t.Run("非法 trackKey 前缀回退 null 但不整条作废", func(t *testing.T) {
		st := musicStateFromPayload(base(map[string]any{"trackKey": "serene:9"}))
		if st == nil {
			t.Fatal("非法前缀不应让整条状态作废（与 Node 一致）")
		}
		if st.TrackKey != nil {
			t.Errorf("trackKey 应回退 nil，得到 %q", *st.TrackKey)
		}
	})

	// 缺任何一个必需字段都整条作废——半截状态写进基线会污染观众进度。
	for _, missing := range []string{"isPlaying", "positionSec", "playMode", "updatedAt"} {
		t.Run("缺 "+missing, func(t *testing.T) {
			if st := musicStateFromPayload(base(map[string]any{missing: nil})); st != nil {
				t.Errorf("缺 %s 应返回 nil，得到 %+v", missing, st)
			}
		})
	}

	for _, mode := range []string{"sequence", "order", "repeat-one", "shuffle"} {
		t.Run("合法模式 "+mode, func(t *testing.T) {
			if st := musicStateFromPayload(base(map[string]any{"playMode": mode})); st == nil {
				t.Errorf("%s 应合法", mode)
			}
		})
	}

	for _, mode := range []string{"nope", "", "SEQUENCE"} {
		t.Run("非法模式 "+mode, func(t *testing.T) {
			if st := musicStateFromPayload(base(map[string]any{"playMode": mode})); st != nil {
				t.Errorf("模式 %q 应被拒绝", mode)
			}
		})
	}

	t.Run("负进度被拒绝", func(t *testing.T) {
		if st := musicStateFromPayload(base(map[string]any{"positionSec": -1.0})); st != nil {
			t.Error("负 positionSec 应被拒绝")
		}
	})

	t.Run("trackSongId=0 被拒绝", func(t *testing.T) {
		if st := musicStateFromPayload(base(map[string]any{"trackSongId": float64(0)})); st != nil {
			t.Error("trackSongId<=0 应被拒绝")
		}
	})
}

func TestMusicUpsertItemValid(t *testing.T) {
	name, artist, album := "歌名", "歌手", "专辑"
	dur := 180000.0
	vip := false
	songID := int64(1001)
	cid := int64(123)
	bvid := "BV1xx411c7mD"

	t.Run("网易云条目合法", func(t *testing.T) {
		it := &musicUpsertItem{Name: &name, Artist: &artist, Album: &album,
			DurationMs: &dur, VIP: &vip, SongID: &songID}
		if !it.valid() {
			t.Error("应合法")
		}
	})

	t.Run("B站 条目靠 bvid+cid 通过（songId=0）", func(t *testing.T) {
		zero := int64(0)
		it := &musicUpsertItem{Name: &name, Artist: &artist, Album: &album,
			DurationMs: &dur, VIP: &vip, SongID: &zero, BiliBvid: &bvid, BiliCid: &cid}
		if !it.valid() {
			t.Error("B站 条目应合法")
		}
	})

	t.Run("B站 bvid 合法但缺 cid 被拒绝", func(t *testing.T) {
		zero := int64(0)
		it := &musicUpsertItem{Name: &name, Artist: &artist, Album: &album,
			DurationMs: &dur, VIP: &vip, SongID: &zero, BiliBvid: &bvid}
		if it.valid() {
			t.Error("缺 biliCid 应被拒绝")
		}
	})

	t.Run("缺 durationMs 被拒绝", func(t *testing.T) {
		it := &musicUpsertItem{Name: &name, Artist: &artist, Album: &album,
			VIP: &vip, SongID: &songID}
		if it.valid() {
			t.Error("缺 durationMs 应被拒绝（Node 要求必须是 number）")
		}
	})

	t.Run("缺 vip 被拒绝", func(t *testing.T) {
		it := &musicUpsertItem{Name: &name, Artist: &artist, Album: &album,
			DurationMs: &dur, SongID: &songID}
		if it.valid() {
			t.Error("缺 vip 应被拒绝")
		}
	})

	t.Run("空名字被拒绝", func(t *testing.T) {
		empty := ""
		it := &musicUpsertItem{Name: &empty, Artist: &artist, Album: &album,
			DurationMs: &dur, VIP: &vip, SongID: &songID}
		if it.valid() {
			t.Error("空 name 应被拒绝")
		}
	})

	t.Run("nil 接收者不 panic", func(t *testing.T) {
		var it *musicUpsertItem
		if it.valid() {
			t.Error("nil 应返回 false")
		}
	})
}

func TestMusicFindCurrentIndex(t *testing.T) {
	items := []*store.MusicQueueItem{
		{ID: 1, SongID: 1001},
		{ID: 2, SongID: 0, Source: "bili", SourceID: strPtr("BV1xx411c7mD:123")},
		{ID: 3, SongID: 1002},
	}

	t.Run("按 trackSongId 定位", func(t *testing.T) {
		sid := int64(1002)
		if got := musicFindCurrentIndex(items, &MusicSyncState{TrackSongID: &sid}); got != 2 {
			t.Errorf("下标 = %d, want 2", got)
		}
	})

	t.Run("trackSongId 缺失时从 ncm: 反解", func(t *testing.T) {
		key := "ncm:1001"
		if got := musicFindCurrentIndex(items, &MusicSyncState{TrackKey: &key}); got != 0 {
			t.Errorf("下标 = %d, want 0", got)
		}
	})

	t.Run("B站 曲目按 sourceId 匹配", func(t *testing.T) {
		key := "bili:BV1xx411c7mD:123"
		if got := musicFindCurrentIndex(items, &MusicSyncState{TrackKey: &key}); got != 1 {
			t.Errorf("下标 = %d, want 1", got)
		}
	})

	t.Run("找不到返回 -1", func(t *testing.T) {
		sid := int64(9999)
		if got := musicFindCurrentIndex(items, &MusicSyncState{TrackSongID: &sid}); got != -1 {
			t.Errorf("下标 = %d, want -1", got)
		}
	})

	t.Run("没有基线返回 -1", func(t *testing.T) {
		if got := musicFindCurrentIndex(items, nil); got != -1 {
			t.Errorf("下标 = %d, want -1", got)
		}
	})
}

func TestSameIDMultiset(t *testing.T) {
	items := []*store.MusicQueueItem{{ID: 1}, {ID: 2}, {ID: 3}}

	if !sameIDMultiset([]int64{3, 1, 2}, items) {
		t.Error("顺序不同但集合相同应通过")
	}
	if sameIDMultiset([]int64{1, 2}, items) {
		t.Error("长度不同应拒绝")
	}
	if sameIDMultiset([]int64{1, 2, 3, 3}, items) {
		t.Error("重复元素应拒绝")
	}
	if sameIDMultiset([]int64{1, 2, 4}, items) {
		t.Error("元素不同应拒绝")
	}
}

func TestSplitBiliSourceID(t *testing.T) {
	cases := []struct{ in, bvid, cid string }{
		{"BV1xx411c7mD:123", "BV1xx411c7mD", "123"},
		{"BV1xx411c7mD", "BV1xx411c7mD", ""},
		{"", "", ""},
	}
	for _, c := range cases {
		bvid, cid := splitBiliSourceID(strPtr(c.in))
		if bvid != c.bvid || cid != c.cid {
			t.Errorf("splitBiliSourceID(%q) = (%q,%q), want (%q,%q)", c.in, bvid, cid, c.bvid, c.cid)
		}
	}
	if bvid, cid := splitBiliSourceID(nil); bvid != "" || cid != "" {
		t.Errorf("nil 应得到空串，得到 (%q,%q)", bvid, cid)
	}
}

func TestNormalizePlayMode(t *testing.T) {
	for _, m := range []string{"sequence", "order", "repeat-one", "shuffle"} {
		if got := normalizePlayMode(m); got != m {
			t.Errorf("normalizePlayMode(%q) = %q", m, got)
		}
	}
	for _, m := range []string{"", "legacy", "SINGLE"} {
		if got := normalizePlayMode(m); got != MusicPlaySequence {
			t.Errorf("normalizePlayMode(%q) = %q, want sequence", m, got)
		}
	}
}

func TestJsNumber(t *testing.T) {
	cases := []struct {
		raw  string
		want float64
		ok   bool
	}{
		{`5`, 5, true},
		{`5.25`, 5.25, true},
		{`"7.5"`, 7.5, true}, // JS 的 Number("7.5")
		{`""`, 0, true},      // Number('') === 0
		{`null`, 0, true},    // Number(null) === 0
		{`true`, 1, true},    // Number(true) === 1
		{`false`, 0, true},   // Number(false) === 0
		{`"abc"`, 0, false},  // NaN
		{`{}`, 0, false},     // NaN
		{`[1]`, 0, false},    // NaN（数组在 JS 里会走 toString，这里刻意不复刻）
		{``, 0, true},        // 参数缺失
	}
	for _, c := range cases {
		got, ok := jsNumber(json.RawMessage(c.raw))
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("jsNumber(%s) = (%v,%v), want (%v,%v)", c.raw, got, ok, c.want, c.ok)
		}
	}
}

func TestNormalizeLocalCliProxyURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://192.168.1.50:9800/cli", "http://127.0.0.1:9800/cli"},
		{"http://example.com:9800", "http://127.0.0.1:9800"},
		{"http://example.com", "http://127.0.0.1"},
		{"https://host:443/api?x=1", "https://127.0.0.1:443/api?x=1"},
	}
	for _, c := range cases {
		if got := normalizeLocalCliProxyURL(c.in); got != c.want {
			t.Errorf("normalizeLocalCliProxyURL(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// 非法 URL 原样返回（不 panic、不返回空串）
	if got := normalizeLocalCliProxyURL("::not a url::"); got != "::not a url::" {
		t.Errorf("非法 URL 应原样返回，得到 %q", got)
	}
}

func TestGenerateStreamKey(t *testing.T) {
	seen := make(map[string]struct{}, 32)
	for i := 0; i < 32; i++ {
		key := generateStreamKey()
		if len(key) != 8 {
			t.Fatalf("长度 = %d, want 8（key=%q）", len(key), key)
		}
		for _, c := range key {
			if !containsRune(streamKeyAlphabet, c) {
				t.Fatalf("出现字符集外的字符 %q（key=%q）", c, key)
			}
		}
		seen[key] = struct{}{}
	}
	// 32 次全撞的可能性极低（55^8），这里只防「返回值恒定」这种低级错误。
	if len(seen) < 30 {
		t.Errorf("32 次只生成 %d 个不同密钥，随机性可疑", len(seen))
	}
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}

// ===========================================================================
// 播放基线：外推、凝固、补偿
// ===========================================================================

func TestMusicMemoryAdvanceClampsAtDuration(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM001", &owner, 10, false)

	// 队列里放一首 10s 的歌，让外推能查到时长。
	if _, err := env.svc.MusicQueue.Insert(ctx, &store.MusicQueueItem{
		RoomID: "ROOMM001", Source: "ncm", SongID: 1001,
		Name: "短歌", Artist: "a", Album: "b", DurationMs: 10000, Order: 1,
	}); err != nil {
		t.Fatalf("插入队列条目失败: %v", err)
	}

	sid := int64(1001)
	key := "ncm:1001"
	// 直接写一份「9.5s 前开始的播放中状态」：外推应超过 10s 并被凝固。
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM001", MusicSyncState{
		TrackSongID: &sid, TrackKey: &key, IsPlaying: true,
		PositionSec: 0, PlayMode: MusicPlaySequence, UpdatedAt: nowMillis(),
	}, "sock-host", 0); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}

	// 把基线时间戳回拨到 9.5s 前（模拟「已经播了一会儿」）。
	env.svc.Music.mu.Lock()
	c := env.svc.Music.cache["ROOMM001"]
	c.state.UpdatedAt = nowMillis() - 9500
	env.svc.Music.mu.Unlock()

	st, err := env.svc.Music.GetAdvancedState(ctx, "ROOMM001")
	if err != nil {
		t.Fatalf("读取推算状态失败: %v", err)
	}
	if st == nil {
		t.Fatal("推算状态不应为 nil")
	}
	if st.PositionSec < 9.4 || st.PositionSec > 10.1 {
		t.Errorf("外推进度 = %v, want ≈9.5", st.PositionSec)
	}
	if !st.IsPlaying {
		t.Error("还没到时长，isPlaying 应保持 true")
	}

	// 再往前拨 2s：越过 10s 上限，必须凝固在时长上并停止。
	env.svc.Music.mu.Lock()
	env.svc.Music.cache["ROOMM001"].state.UpdatedAt = nowMillis() - 12000
	env.svc.Music.mu.Unlock()

	st, err = env.svc.Music.GetAdvancedState(ctx, "ROOMM001")
	if err != nil {
		t.Fatalf("读取推算状态失败: %v", err)
	}
	if st.IsPlaying {
		t.Error("越过时长后 isPlaying 必须为 false")
	}
	if st.PositionSec != 10 {
		t.Errorf("凝固进度 = %v, want 10", st.PositionSec)
	}
}

func TestMusicMemoryPausedDoesNotAdvance(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM002", &owner, 10, false)

	sid := int64(1001)
	key := "ncm:1001"
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM002", MusicSyncState{
		TrackSongID: &sid, TrackKey: &key, IsPlaying: false,
		PositionSec: 42.5, PlayMode: MusicPlaySequence, UpdatedAt: nowMillis(),
	}, "sock-host", 0); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}

	env.svc.Music.mu.Lock()
	env.svc.Music.cache["ROOMM002"].state.UpdatedAt = nowMillis() - 5000
	env.svc.Music.mu.Unlock()

	st, err := env.svc.Music.GetAdvancedState(ctx, "ROOMM002")
	if err != nil {
		t.Fatalf("读取推算状态失败: %v", err)
	}
	if st.PositionSec != 42.5 {
		t.Errorf("暂停态进度 = %v, want 42.5（不能外推）", st.PositionSec)
	}
}

func TestMusicMemorySetPlaybackCompensatesDelay(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM003", &owner, 10, false)

	sid := int64(1001)
	key := "ncm:1001"
	// clientTs 落后 900ms：播放中应补回 ~0.9s。
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM003", MusicSyncState{
		TrackSongID: &sid, TrackKey: &key, IsPlaying: true,
		PositionSec: 60, PlayMode: MusicPlaySequence, UpdatedAt: nowMillis(),
	}, "sock-host", nowMillis()-900); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}

	st, err := env.svc.Music.GetRawState(ctx, "ROOMM003")
	if err != nil {
		t.Fatalf("读取原始基线失败: %v", err)
	}
	if st.PositionSec < 60.7 || st.PositionSec > 61.1 {
		t.Errorf("补偿后进度 = %v, want ≈60.9", st.PositionSec)
	}

	// clientTs 在未来（客户端时钟快）：不回拨，钳为原值。
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM003", MusicSyncState{
		TrackSongID: &sid, TrackKey: &key, IsPlaying: true,
		PositionSec: 70, PlayMode: MusicPlaySequence, UpdatedAt: nowMillis(),
	}, "sock-host", nowMillis()+3000); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}
	st, err = env.svc.Music.GetRawState(ctx, "ROOMM003")
	if err != nil {
		t.Fatalf("读取原始基线失败: %v", err)
	}
	if st.PositionSec != 70 {
		t.Errorf("未来 clientTs 时进度 = %v, want 70（不回拨）", st.PositionSec)
	}

	// 延迟 10s：补偿上限 1.5s。
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM003", MusicSyncState{
		TrackSongID: &sid, TrackKey: &key, IsPlaying: true,
		PositionSec: 80, PlayMode: MusicPlaySequence, UpdatedAt: nowMillis(),
	}, "sock-host", nowMillis()-10000); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}
	st, err = env.svc.Music.GetRawState(ctx, "ROOMM003")
	if st.PositionSec < 81.4 || st.PositionSec > 81.6 {
		t.Errorf("超长延迟补偿后 = %v, want ≈81.5（上限 1.5s）", st.PositionSec)
	}
}

func TestMusicMemoryPersistsAndReloads(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM004", &owner, 10, false)

	sid := int64(1001)
	key := "ncm:1001"
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM004", MusicSyncState{
		TrackSongID: &sid, TrackKey: &key, IsPlaying: false,
		PositionSec: 33, PlayMode: MusicPlayRepeatOne, UpdatedAt: nowMillis(),
	}, "sock-host", 0); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}
	if err := env.svc.Music.FlushToDB(ctx, "ROOMM004"); err != nil {
		t.Fatalf("落盘失败: %v", err)
	}

	// 模拟后端重启：清空内存缓存后应从 DB 恢复。
	env.svc.Music.mu.Lock()
	delete(env.svc.Music.cache, "ROOMM004")
	env.svc.Music.mu.Unlock()

	st, err := env.svc.Music.GetAdvancedState(ctx, "ROOMM004")
	if err != nil {
		t.Fatalf("重启后读取失败: %v", err)
	}
	if st == nil {
		t.Fatal("重启后应能从 DB 恢复基线")
	}
	if st.PositionSec != 33 || st.PlayMode != MusicPlayRepeatOne {
		t.Errorf("恢复的状态不对: %+v", st)
	}

	// 清除后彻底没有（房间关闭路径）。
	env.svc.Music.Clear(ctx, "ROOMM004")
	st, err = env.svc.Music.GetAdvancedState(ctx, "ROOMM004")
	if err != nil {
		t.Fatalf("清除后读取失败: %v", err)
	}
	if st != nil {
		t.Errorf("清除后不应再有基线，得到 %+v", st)
	}
}

func TestMusicQueueOrderCompaction(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM005", &owner, 10, false)

	ids := make([]int64, 0, 3)
	for i, name := range []string{"a", "b", "c"} {
		id, err := env.svc.MusicQueue.Insert(ctx, &store.MusicQueueItem{
			RoomID: "ROOMM005", Source: "ncm", SongID: int64(2000 + i),
			Name: name, Artist: "x", Album: "y", DurationMs: 1000, Order: int64(i + 1),
		})
		if err != nil {
			t.Fatalf("插入失败: %v", err)
		}
		ids = append(ids, id)
	}

	items, err := env.svc.musicLoadQueue(ctx, "ROOMM005")
	if err != nil {
		t.Fatalf("读取队列失败: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("队列长度 = %d, want 3", len(items))
	}

	// 删除中间那条，剩余 order 应压成 1,2。
	if _, err := env.svc.MusicQueue.Delete(ctx, "ROOMM005", ids[1]); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	rest, err := env.svc.musicLoadQueue(ctx, "ROOMM005")
	if err != nil {
		t.Fatalf("读取队列失败: %v", err)
	}
	pairs := make([]store.MusicOrderPair, 0, len(rest))
	for i, it := range rest {
		if it.Order != int64(i+1) {
			pairs = append(pairs, store.MusicOrderPair{ID: it.ID, Order: int64(i + 1)})
		}
	}
	if err := env.svc.MusicQueue.SetOrders(ctx, pairs); err != nil {
		t.Fatalf("压实失败: %v", err)
	}
	final, err := env.svc.musicLoadQueue(ctx, "ROOMM005")
	if err != nil {
		t.Fatalf("读取队列失败: %v", err)
	}
	for i, it := range final {
		if it.Order != int64(i+1) {
			t.Errorf("第 %d 条 order = %d, want %d", i, it.Order, i+1)
		}
	}
}

func TestMusicLoadQueueDropsStaleRows(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM006", &owner, 10, false)

	// 塞壬历史行：songId=0 且 source 不是 bili → 应被删掉且不返回。
	if _, err := env.svc.MusicQueue.Insert(ctx, &store.MusicQueueItem{
		RoomID: "ROOMM006", Source: "ncm", SongID: 0,
		Name: "塞壬歌", Artist: "x", Album: "y", DurationMs: 1000, Order: 1,
	}); err != nil {
		t.Fatalf("插入失败: %v", err)
	}
	// B站 条目：songId=0 但 source=bili → 必须保留。
	if _, err := env.svc.MusicQueue.Insert(ctx, &store.MusicQueueItem{
		RoomID: "ROOMM006", Source: "bili", SongID: 0, SourceID: strPtr("BV1xx411c7mD:1"),
		Name: "B站歌", Artist: "x", Album: "y", DurationMs: 1000, Order: 2,
	}); err != nil {
		t.Fatalf("插入失败: %v", err)
	}

	items, err := env.svc.musicLoadQueue(ctx, "ROOMM006")
	if err != nil {
		t.Fatalf("读取队列失败: %v", err)
	}
	if len(items) != 1 || items[0].Name != "B站歌" {
		t.Fatalf("应只保留 B站 条目，得到 %+v", items)
	}

	// 失效行必须真的从库里删掉，不能只是过滤。
	all, err := env.svc.MusicQueue.ListByRoom(ctx, "ROOMM006")
	if err != nil {
		t.Fatalf("读取队列失败: %v", err)
	}
	if len(all) != 1 {
		t.Errorf("失效行应被删除，库里还剩 %d 条", len(all))
	}
}

// 时间相关的辅助：让测试里的「等一会儿」不至于慢到影响 go test 的整体时长。
func TestMusicCacheCleanupKeepsDirty(t *testing.T) {
	env := newTestEnv(t)
	ctx := context.Background()
	owner := int64(1)
	env.insertRoom(t, "ROOMM007", &owner, 10, false)

	sid := int64(1001)
	if err := env.svc.Music.SetPlayback(ctx, "ROOMM007", MusicSyncState{
		TrackSongID: &sid, IsPlaying: true, PositionSec: 1,
		PlayMode: MusicPlaySequence, UpdatedAt: nowMillis(),
	}, "sock-host", 0); err != nil {
		t.Fatalf("写入基线失败: %v", err)
	}

	// 造一个「很久没动 + 脏」的条目：清理必须跳过它（脏数据丢了就是真丢）。
	env.svc.Music.mu.Lock()
	c := env.svc.Music.cache["ROOMM007"]
	c.state.UpdatedAt = nowMillis() - musicCacheStaleThresholdMS - 1000
	c.dirty = true
	env.svc.Music.mu.Unlock()

	env.svc.Music.CleanupStaleCache()
	if _, ok := env.svc.Music.cache["ROOMM007"]; !ok {
		t.Error("脏条目不应被清理")
	}

	// 落盘转干净后（且房主离线）应被清理。
	env.svc.Music.mu.Lock()
	env.svc.Music.cache["ROOMM007"].dirty = false
	env.svc.Music.mu.Unlock()
	env.svc.Music.CleanupStaleCache()
	if _, ok := env.svc.Music.cache["ROOMM007"]; ok {
		t.Error("干净且陈旧的条目应被清理")
	}
}

func TestNeedsProgressSyncTolerance(t *testing.T) {
	now := time.Now().UnixMilli()

	// isPlaying 不一致：无条件纠偏
	if !NeedsProgressSync(NeedsProgressSyncParams{
		ClientCurrentTime: 10, ClientIsPlaying: true,
		ServerCurrentTime: 10, ServerIsPlaying: false, Now: now,
	}) {
		t.Error("isPlaying 不一致应纠偏")
	}

	// 进度差 5s（小于 10s 容差）：不纠偏
	if NeedsProgressSync(NeedsProgressSyncParams{
		ClientCurrentTime: 10, ClientIsPlaying: true,
		ServerCurrentTime: 15, ServerIsPlaying: true, Now: now,
	}) {
		t.Error("5s 偏差不应纠偏")
	}

	// 进度差 30s：纠偏
	if !NeedsProgressSync(NeedsProgressSyncParams{
		ClientCurrentTime: 10, ClientIsPlaying: true,
		ServerCurrentTime: 40, ServerIsPlaying: true, Now: now,
	}) {
		t.Error("30s 偏差应纠偏")
	}
}

func strPtr(v string) *string { return &v }
