package bilibili

import "testing"

func TestExtractBvid(t *testing.T) {
	cases := []struct{ input, want string }{
		{"https://www.bilibili.com/video/BV1GJ411x7h7", "BV1GJ411x7h7"},
		{"https://www.bilibili.com/video/BV1GJ411x7h7?p=3", "BV1GJ411x7h7"},
		{"BV1GJ411x7h7", "BV1GJ411x7h7"},
		{"https://www.bilibili.com/video/av170001", "170001"},
		{"av170001", "170001"},
		{"https://www.bilibili.com/bangumi/play/ep123456", ""},
		{"随便一段文本", ""},
	}
	for _, tc := range cases {
		if got := ExtractBvid(tc.input); got != tc.want {
			t.Errorf("ExtractBvid(%q) = %q, 期望 %q", tc.input, got, tc.want)
		}
	}
}

// TestExtractBangumiID 覆盖识别顺序：BV/av 优先，避免标题里带 ep1 的普通视频
// 被当成番剧去解析。
func TestExtractBangumiID(t *testing.T) {
	cases := []struct {
		input    string
		wantEp   int64
		wantSsid int64
		wantNil  bool
	}{
		{input: "https://www.bilibili.com/bangumi/play/ep829609", wantEp: 829609},
		{input: "https://www.bilibili.com/bangumi/play/ss45612", wantSsid: 45612},
		{input: "ep829609", wantEp: 829609},
		{input: "ss45612", wantSsid: 45612},
		// BV 优先：即使串里带 ep123，也归 UGC
		{input: "https://www.bilibili.com/video/BV1GJ411x7h7?ep123", wantNil: true},
		// 前接字母数字不算：step1 / sleep2 不应被误认
		{input: "https://example.com/step1", wantNil: true},
		{input: "https://example.com/sleep2", wantNil: true},
		{input: "https://www.bilibili.com/video/BV1GJ411x7h7", wantNil: true},
	}
	for _, tc := range cases {
		got := ExtractBangumiID(tc.input)
		if tc.wantNil {
			if got != nil {
				t.Errorf("ExtractBangumiID(%q) 期望 nil，实际 %+v", tc.input, got)
			}
			continue
		}
		if got == nil {
			t.Errorf("ExtractBangumiID(%q) 返回 nil", tc.input)
			continue
		}
		if got.EpID != tc.wantEp || got.SeasonID != tc.wantSsid {
			t.Errorf("ExtractBangumiID(%q) = %+v, 期望 ep=%d ss=%d", tc.input, got, tc.wantEp, tc.wantSsid)
		}
	}
}

// TestCurrentPageDuration 覆盖「多 P 视频必须用当前分集时长」这条：
// 用总时长会让 MPD 的 mediaPresentationDuration 远超实际文件，
// dash.js seek 到超范围位置永远拿不到 segment。
func TestCurrentPageDuration(t *testing.T) {
	info := &VideoInfo{
		Cid:      300,
		Duration: 1133, // 全部 P 的总时长
		Pages: []VideoPage{
			{Cid: 100, Page: 1, Duration: 176},
			{Cid: 200, Page: 2, Duration: 240},
			{Cid: 300, Page: 3, Duration: 300},
		},
	}
	if got := currentPageDuration(info, 200); got != 240 {
		t.Fatalf("currentPageDuration = %d, 期望 240", got)
	}
	// 不传 cid 时用 info.cid（第 3 P）
	if got := currentPageDuration(info, 0); got != 300 {
		t.Fatalf("currentPageDuration(0) = %d, 期望 300", got)
	}
	// cid 不在 pages 里（异常数据）时回退第一 P
	if got := currentPageDuration(info, 999); got != 176 {
		t.Fatalf("未知 cid 应回退第一 P，实际 %d", got)
	}
	// 单 P 视频直接用 info.duration
	single := &VideoInfo{Cid: 1, Duration: 500}
	if got := currentPageDuration(single, 1); got != 500 {
		t.Fatalf("单 P 视频时长错误: %d", got)
	}
}

func TestNarrowAcceptQualityForMP4(t *testing.T) {
	list := []Quality{
		{ID: 120, Label: "4K 超清"},
		{ID: 80, Label: "1080P"},
		{ID: 64, Label: "720P"},
		{ID: 32, Label: "480P"},
	}
	narrowed := narrowAcceptQualityForMP4(list)
	if len(narrowed) != 2 || narrowed[0].ID != 64 || narrowed[1].ID != 32 {
		t.Fatalf("MP4 收窄失败: %+v", narrowed)
	}
	// 全被滤掉时给 480P/360P 兜底，前端至少要有选项
	empty := narrowAcceptQualityForMP4([]Quality{{ID: 120, Label: "4K 超清"}})
	if len(empty) != 2 || empty[0].ID != 32 || empty[1].ID != 16 {
		t.Fatalf("MP4 兜底失败: %+v", empty)
	}
}

func TestFilterQualitiesByVip(t *testing.T) {
	list := []Quality{
		{ID: 127, Label: "8K"},
		{ID: 120, Label: "4K"},
		{ID: 80, Label: "1080P"},
		{ID: 64, Label: "720P"},
		{ID: 32, Label: "480P"},
	}

	// 会员：全留
	if got := FilterQualitiesByVip(list, true, true); len(got) != 5 {
		t.Fatalf("会员应保留全部，实际 %d", len(got))
	}
	// 已登录非会员：剔除会员专属档
	nonVip := FilterQualitiesByVip(list, false, true)
	if len(nonVip) != 3 || nonVip[0].ID != 80 {
		t.Fatalf("非会员过滤失败: %+v", nonVip)
	}
	// 未登录：只留 ≤480P
	anonymous := FilterQualitiesByVip(list, false, false)
	if len(anonymous) != 1 || anonymous[0].ID != 32 {
		t.Fatalf("未登录过滤失败: %+v", anonymous)
	}
	// 未登录且列表里没有低清晰度 → 兜底 480P/360P
	fallback := FilterQualitiesByVip([]Quality{{ID: 80, Label: "1080P"}}, false, false)
	if len(fallback) != 2 || fallback[0].ID != 32 {
		t.Fatalf("未登录兜底失败: %+v", fallback)
	}
}

func TestComputeFnval(t *testing.T) {
	// 非会员只有 DASH
	if got := ComputeFnval(false, 80, "", false); got != fnvalDASH {
		t.Fatalf("非会员 fnval = %d, 期望 %d", got, fnvalDASH)
	}
	// 会员：DASH | HDR | 4K
	if got := ComputeFnval(true, 80, "", false); got != fnvalDASH|fnvalHDR|fnval4K {
		t.Fatalf("会员 fnval = %d", got)
	}
	// 8K 档额外开 8K 位
	if got := ComputeFnval(true, Qn8K, "", false); got&fnval8K == 0 {
		t.Fatalf("8K 位未开启: %d", got)
	}
	// 杜比视界默认关闭（浏览器无法解码，暴露即黑屏）
	if got := ComputeFnval(true, QnDolbyVision, "", false); got&fnvalDolbyVision != 0 {
		t.Fatalf("杜比视界位默认不应开启: %d", got)
	}
	if got := ComputeFnval(true, QnDolbyVision, "", true); got&fnvalDolbyVision == 0 {
		t.Fatalf("显式允许时杜比视界位应开启: %d", got)
	}
	// AV1 偏好开 AV1 位
	if got := ComputeFnval(true, 80, "av1", false); got&fnvalAV1 == 0 {
		t.Fatalf("AV1 位未开启: %d", got)
	}
}

func TestGetDefaultQn(t *testing.T) {
	if got := GetDefaultQn(true, true); got != VipDefaultQn {
		t.Fatalf("会员默认 qn = %d, 期望 %d", got, VipDefaultQn)
	}
	if got := GetDefaultQn(false, true); got != DefaultQn {
		t.Fatalf("非会员默认 qn = %d, 期望 %d", got, DefaultQn)
	}
	if got := GetDefaultQn(true, false); got != AnonymousMaxQn {
		t.Fatalf("未登录默认 qn = %d, 期望 %d", got, AnonymousMaxQn)
	}
}

// TestMp4TargetQn 覆盖 MP4 直链的 qn 取值。
//
// 回归点：匿名默认值曾经沿用 GetDefaultQn（480P），而 MP4 对未登录也能给 720P，
// 结果是「MP4 模式只能 480P / 偶尔 360P」。匿名未指定时必须顶到 MP4MaxQn。
func TestMp4TargetQn(t *testing.T) {
	cases := []struct {
		name             string
		requested        int
		isVip, hasCookie bool
		want             int
	}{
		{"匿名未指定 → 顶到 720P", 0, false, false, MP4MaxQn},
		{"匿名显式 480P → 尊重用户选择", 32, false, false, 32},
		{"匿名超出上限 → 截到 720P", 80, false, false, MP4MaxQn},
		{"登录非会员未指定 → 1080P 截到 720P", 0, false, true, MP4MaxQn},
		{"会员未指定 → 4K 截到 720P", 0, true, true, MP4MaxQn},
		{"会员显式 1080P60 → 截到 720P", 116, true, true, MP4MaxQn},
		{"登录非会员显式 720P → 原样", 64, false, true, 64},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Mp4TargetQn(tc.requested, tc.isVip, tc.hasCookie); got != tc.want {
				t.Errorf("Mp4TargetQn(%d, vip=%t, cookie=%t) = %d, 期望 %d",
					tc.requested, tc.isVip, tc.hasCookie, got, tc.want)
			}
		})
	}
}
