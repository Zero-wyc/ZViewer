package bilibili

import "testing"

func TestDurationTolerance(t *testing.T) {
	cases := []struct {
		duration float64
		want     float64
	}{
		// max(10, 时长×8%)：短片段靠 10 秒兜底。
		{30, 10},
		{100, 10},
		{125, 10},
		{200, 16},
		{1488, 119.04},
	}
	for _, c := range cases {
		if got := durationTolerance(c.duration); got != c.want {
			t.Errorf("durationTolerance(%v) = %v，期望 %v", c.duration, got, c.want)
		}
	}
}

func TestPickSubtitleTrack(t *testing.T) {
	tracks := []subtitleTrack{
		{Lan: "en-US", SubtitleURL: "//a/en.json?oid=1"},
		{Lan: "zh-Hans", SubtitleURL: "//a/zh.json?oid=1"},
		{Lan: "ai-zh", SubtitleURL: "//a/aizh.json?oid=1"},
	}
	// AI 中文字幕优先：它才是 B站 自动生成、覆盖面最广的那条。
	if got := pickSubtitleTrack(tracks); got.Lan != "ai-zh" {
		t.Errorf("应优先 ai-zh，实际 %q", got.Lan)
	}

	// 没有 ai-zh 时退到任意 zh*。
	if got := pickSubtitleTrack(tracks[:2]); got.Lan != "zh-Hans" {
		t.Errorf("应退到 zh-Hans，实际 %q", got.Lan)
	}

	// 都没有则取首条。
	if got := pickSubtitleTrack(tracks[:1]); got.Lan != "en-US" {
		t.Errorf("应取首条 en-US，实际 %q", got.Lan)
	}

	if got := pickSubtitleTrack(nil); got.Lan != "" {
		t.Errorf("空列表应返回零值，实际 %+v", got)
	}
}

func TestExtractSubtitleOid(t *testing.T) {
	// 带外校验的输入：oid 就是视频 aid，用来判定这条字幕是不是别人的。
	if oid, ok := extractSubtitleOid("//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json?oid=12345&x=1"); !ok || oid != 12345 {
		t.Errorf("期望 oid=12345，实际 oid=%d ok=%v", oid, ok)
	}
	// 没有 oid 参数：拿不到带外证据，校验必须"跳过"而不是"失败"。
	if _, ok := extractSubtitleOid("https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1.json"); ok {
		t.Error("无 oid 参数时应返回 ok=false")
	}
	// oid 非数字：同样视为拿不到证据。
	if _, ok := extractSubtitleOid("//x/y.json?oid=abc"); ok {
		t.Error("oid 非数字时应返回 ok=false")
	}
}

func TestSubtitleFingerprint(t *testing.T) {
	a := []SubtitleLine{{From: 0, To: 1.5, Content: "第一句"}}
	b := []SubtitleLine{{From: 0, To: 1.5, Content: "第一句"}, {From: 2, To: 3, Content: "第二句"}}

	// 指纹必须把「条数 / 首句 / 末句终点」都带上：
	// 只比条数会把不同视频的等长字幕判成同一份，只比首句会放过续集。
	if subtitleFingerprint(a) == subtitleFingerprint(b) {
		t.Error("不同内容不应得到相同指纹")
	}
	if subtitleFingerprint(a) != subtitleFingerprint(a) {
		t.Error("同一内容应得到稳定指纹")
	}
	if got := subtitleFingerprint(nil); got != "0::0" {
		t.Errorf("空字幕指纹应为 0::0，实际 %q", got)
	}
}
