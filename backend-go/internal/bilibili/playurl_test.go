package bilibili

import (
	"errors"
	"testing"
)

// dashVideo 构造一条视频轨。
func dashVideo(id, bandwidth int, codecs string) rawDashMedia {
	return rawDashMedia{
		BaseURL:   "https://cdn.example.com/v" + codecs + ".m4s",
		ID:        id,
		Codecs:    codecs,
		Bandwidth: int64(bandwidth),
		Codecid:   codecID(codecs),
	}
}

func codecID(codecs string) int {
	switch detectCodec(codecs) {
	case "avc":
		return 7
	case "hevc":
		return 12
	case "av1":
		return 13
	}
	return 0
}

func intPtr(v int) *int { return &v }

// TestNormalizeFiltersTracksByQn 覆盖最关键的一条：dash.video 会一次性返回
// 所有清晰度的轨道，不按 qn 过滤就永远选到最高档——用户选了 480P 却在放 1080P。
func TestNormalizeFiltersTracksByQn(t *testing.T) {
	data := &rawPlayURLData{
		Quality:       intPtr(64),
		AcceptQuality: []int{80, 64, 32, 16},
		Dash: &struct {
			Video []rawDashMedia `json:"video"`
			Audio []rawDashMedia `json:"audio"`
			Dolby *struct {
				Type  int            `json:"type"`
				Audio []rawDashMedia `json:"audio"`
			} `json:"dolby"`
			Flac *struct {
				Display bool           `json:"display"`
				Audio   []rawDashMedia `json:"audio"`
			} `json:"flac"`
		}{
			Video: []rawDashMedia{
				dashVideo(80, 2000000, "avc1.640032"),
				dashVideo(64, 1000000, "avc1.640028"),
				dashVideo(32, 400000, "avc1.64001E"),
				dashVideo(16, 200000, "hev1.1.6.L120"),
			},
			Audio: []rawDashMedia{
				{BaseURL: "https://cdn.example.com/a64.m4s", ID: 30280, Codecs: "mp4a.40.2", Bandwidth: 132000},
				{BaseURL: "https://cdn.example.com/a128.m4s", ID: 30232, Codecs: "mp4a.40.2", Bandwidth: 66000},
			},
		},
	}

	result, err := NormalizePlayURLData(data, 32, "")
	if err != nil {
		t.Fatalf("归一化失败: %v", err)
	}
	if result.Format != "dash" {
		t.Fatalf("format = %s, 期望 dash", result.Format)
	}
	// quality=64 由 B站 返回，所以只保留 id=64 的那一条
	if len(result.Video) != 1 || result.Video[0].ID != 64 {
		t.Fatalf("轨道过滤失败: %+v", result.Video)
	}
	if result.CurrentQn != 64 {
		t.Fatalf("currentQn = %d, 期望 64（以 B站 返回的 quality 为准）", result.CurrentQn)
	}
	// 音频按带宽降序
	if len(result.Audio) != 2 || result.Audio[0].Bandwidth != 132000 {
		t.Fatalf("音频排序失败: %+v", result.Audio)
	}
	if result.BestAudio == nil || result.BestAudio.ID != 30280 {
		t.Fatalf("bestAudio 选择失败")
	}
	// accept_quality 保留原始顺序，标签走映射表
	if len(result.AcceptQuality) != 4 || result.AcceptQuality[0].Label != "1080P" {
		t.Fatalf("acceptQuality 构建失败: %+v", result.AcceptQuality)
	}
	if result.AcceptQuality[2].Resolution != "854x480" {
		t.Fatalf("分辨率映射失败: %+v", result.AcceptQuality[2])
	}
}

// TestNormalizeEffectiveQnFallsBackToRealTrack 覆盖低权限场景：
// B站 的 quality 可能高于实际下发的轨道（未登录报 720P 但只给 480P/360P），
// 此时 currentQn 必须跟着实际轨道走，否则前端显示与实际画面不一致。
func TestNormalizeEffectiveQnFallsBackToRealTrack(t *testing.T) {
	data := &rawPlayURLData{
		Quality: intPtr(64), // 声称 720P
		Dash: &struct {
			Video []rawDashMedia `json:"video"`
			Audio []rawDashMedia `json:"audio"`
			Dolby *struct {
				Type  int            `json:"type"`
				Audio []rawDashMedia `json:"audio"`
			} `json:"dolby"`
			Flac *struct {
				Display bool           `json:"display"`
				Audio   []rawDashMedia `json:"audio"`
			} `json:"flac"`
		}{
			Video: []rawDashMedia{
				dashVideo(32, 400000, "avc1.64001E"),
				dashVideo(16, 200000, "avc1.64000D"),
			},
		},
	}
	result, err := NormalizePlayURLData(data, 64, "")
	if err != nil {
		t.Fatalf("归一化失败: %v", err)
	}
	if result.CurrentQn != 32 {
		t.Fatalf("currentQn = %d, 期望 32（应回落到实际最高轨道）", result.CurrentQn)
	}
}

func TestNormalizeCodecPreference(t *testing.T) {
	makeData := func() *rawPlayURLData {
		return &rawPlayURLData{
			Quality: intPtr(80),
			Dash: &struct {
				Video []rawDashMedia `json:"video"`
				Audio []rawDashMedia `json:"audio"`
				Dolby *struct {
					Type  int            `json:"type"`
					Audio []rawDashMedia `json:"audio"`
				} `json:"dolby"`
				Flac *struct {
					Display bool           `json:"display"`
					Audio   []rawDashMedia `json:"audio"`
				} `json:"flac"`
			}{
				Video: []rawDashMedia{
					dashVideo(80, 3000000, "hev1.1.6.L150"), // HEVC 带宽更高
					dashVideo(80, 2000000, "avc1.640032"),
					dashVideo(80, 1000000, "av01.0.08M.08"),
				},
			},
		}
	}

	// auto → 优先 AVC（浏览器兼容性最好），即使带宽更低
	auto, _ := NormalizePlayURLData(makeData(), 80, "")
	if auto.BestVideo == nil || detectCodec(auto.BestVideo.Codecs) != "avc" {
		t.Fatalf("auto 应优先 avc，实际 %+v", auto.BestVideo)
	}
	if auto.VideoCodecid != 7 {
		t.Fatalf("videoCodecid = %d, 期望 7", auto.VideoCodecid)
	}

	hevc, _ := NormalizePlayURLData(makeData(), 80, "hevc")
	if hevc.BestVideo == nil || detectCodec(hevc.BestVideo.Codecs) != "hevc" {
		t.Fatalf("hevc 偏好失效，实际 %+v", hevc.BestVideo)
	}

	av1, _ := NormalizePlayURLData(makeData(), 80, "av1")
	if av1.BestVideo == nil || detectCodec(av1.BestVideo.Codecs) != "av1" {
		t.Fatalf("av1 偏好失效，实际 %+v", av1.BestVideo)
	}
}

func TestNormalizeHdrDetection(t *testing.T) {
	makeData := func(qn int, codecs string) *rawPlayURLData {
		return &rawPlayURLData{
			Quality: intPtr(qn),
			Dash: &struct {
				Video []rawDashMedia `json:"video"`
				Audio []rawDashMedia `json:"audio"`
				Dolby *struct {
					Type  int            `json:"type"`
					Audio []rawDashMedia `json:"audio"`
				} `json:"dolby"`
				Flac *struct {
					Display bool           `json:"display"`
					Audio   []rawDashMedia `json:"audio"`
				} `json:"flac"`
			}{
				Video: []rawDashMedia{dashVideo(qn, 5000000, codecs)},
			},
		}
	}

	// qn=125 → HLG（B站 HDR 真彩统一用 HLG）
	hlg, _ := NormalizePlayURLData(makeData(125, "hev1.2.4.L153"), 125, "")
	if !hlg.IsHDR || hlg.HdrType != HdrHLG {
		t.Fatalf("qn=125 应判为 hlg，实际 isHdr=%t hdrType=%s", hlg.IsHDR, hlg.HdrType)
	}

	// qn=126 → 杜比视界
	dovi, _ := NormalizePlayURLData(makeData(126, "dvh1.08.07"), 126, "")
	if !dovi.IsHDR || dovi.HdrType != HdrDolbyVision {
		t.Fatalf("qn=126 应判为 dolby-vision，实际 isHdr=%t hdrType=%s", dovi.IsHDR, dovi.HdrType)
	}

	// 普通 1080P 不应被误判
	plain, _ := NormalizePlayURLData(makeData(80, "avc1.640032"), 80, "")
	if plain.IsHDR {
		t.Fatalf("qn=80 不应判为 HDR")
	}
}

func TestNormalizeMP4Path(t *testing.T) {
	data := &rawPlayURLData{
		Quality:       intPtr(64),
		AcceptQuality: []int{80, 64, 32},
		Durl: []struct {
			URL    string `json:"url"`
			Size   int64  `json:"size"`
			Length int64  `json:"length"`
		}{
			{URL: "http://upos.example.com/mp4", Size: 123456, Length: 176000},
		},
	}
	result, err := NormalizePlayURLData(data, 64, "")
	if err != nil {
		t.Fatalf("归一化失败: %v", err)
	}
	if result.Format != "mp4" || len(result.Durl) != 1 {
		t.Fatalf("MP4 分支失败: %+v", result)
	}
	if result.CurrentQn != 64 {
		t.Fatalf("currentQn = %d, 期望 64", result.CurrentQn)
	}
	if result.Durl[0].Length != 176000 {
		t.Fatalf("durl.length 丢失（试看时长依赖它）")
	}
}

func TestNormalizeNoStreamMeansNoPermission(t *testing.T) {
	_, err := NormalizePlayURLData(&rawPlayURLData{Quality: intPtr(80)}, 80, "")
	if !errors.Is(err, ErrNoPermission) {
		t.Fatalf("既无 dash 也无 durl 时应返回 ErrNoPermission，实际 %v", err)
	}
}

func TestNormalizeNilData(t *testing.T) {
	result, err := NormalizePlayURLData(nil, 80, "")
	if err != nil || result != nil {
		t.Fatalf("nil 载荷应返回 (nil, nil)，实际 (%+v, %v)", result, err)
	}
}

// TestMcdnPortRewrite 覆盖 8082 端口改写：部分网络封该端口，
// 去掉后走 443 才能连通。
func TestMcdnPortRewrite(t *testing.T) {
	got := rewriteMcdnPort("http://xy1x2x3x4.mcdn.bilivideo.cn:8082/video.m4s?e=1")
	want := "http://xy1x2x3x4.mcdn.bilivideo.cn/video.m4s?e=1"
	if got != want {
		t.Fatalf("mcdn 改写失败:\n  实际 = %s\n  期望 = %s", got, want)
	}
	// 非 mcdn 域名不动
	plain := "https://upos-sz-mirrorcos.bilivideo.com/v.m4s"
	if rewriteMcdnPort(plain) != plain {
		t.Fatalf("非 mcdn 域名被误改")
	}
}

func TestIsPermissionError(t *testing.T) {
	cases := []struct {
		msg  string
		want bool
	}{
		{"B站 API 业务错误 [-403] 大会员专享: url", true},
		{"B站 API 业务错误 [-10403] 地区限制: url", true},
		{"无权限播放，可能需要登录或大会员", true},
		// -101 是「未登录」而不是「无权限」：误判会导致不降级到未签名接口
		{"B站 API 业务错误 [-101] 账号未登录: url", false},
		{"B站 API 请求超时 (10000ms): url", false},
	}
	for _, tc := range cases {
		if got := isPermissionError(errors.New(tc.msg)); got != tc.want {
			t.Errorf("isPermissionError(%q) = %t, 期望 %t", tc.msg, got, tc.want)
		}
	}
}
