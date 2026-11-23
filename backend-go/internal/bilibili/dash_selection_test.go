package bilibili

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// TestSelectDashSourcesCarriesBackups 验证 DASH 选取结果把候选表一起带出来。
//
// 这张表最终会经 NDJSON 下发到前端、再登记给 CLI。/proxy 换节点全靠它，
// 少带一次就是「502 无节点可换」。
func TestSelectDashSourcesCarriesBackups(t *testing.T) {
	playURL := &PlayURLResult{
		BestVideo: &DashMediaTrack{
			BaseURL: "http://a.mcdn.bilivideo.cn/v.m4s",
			BackupURL: []string{
				"http://upos-sz-mirrorcos.bilivideo.com/v.m4s",
				"http://upos-sz-mirrorali.bilivideo.com/v.m4s",
			},
		},
		BestAudio: &DashMediaTrack{
			BaseURL: "http://upos-sz-mirrorcos.bilivideo.com/a.m4s",
		},
	}

	// skipCdnCheck：房主直链路径，不探测但按「非 mcdn 优先」挑主地址。
	sel := selectDashSources(context.Background(), playURL, true)
	if sel.VideoURL != "https://upos-sz-mirrorcos.bilivideo.com/v.m4s" {
		t.Fatalf("视频主地址 = %q，期望非 mcdn 的 upos 节点", sel.VideoURL)
	}
	if len(sel.VideoBackups) != 3 {
		t.Fatalf("视频候选 = %v，期望含 mcdn 在内的 3 条", sel.VideoBackups)
	}
	if sel.VideoBackups[len(sel.VideoBackups)-1] != "http://a.mcdn.bilivideo.cn/v.m4s" {
		t.Fatalf("mcdn 应排在最后，实际顺序 %v", sel.VideoBackups)
	}
	if len(sel.AudioBackups) != 1 || sel.AudioBackups[0] != "https://upos-sz-mirrorcos.bilivideo.com/a.m4s" {
		t.Fatalf("音频候选 = %v，期望只有主地址一条", sel.AudioBackups)
	}
}

// TestResolveResultBackupJSONKeys 钉住下发给前端的字段名。
//
// 前端按 videoBackupUrls / audioBackupUrls 取值，字段名一旦改动就是静默失效：
// 解析正常、播放正常，只是没有回退候选——线上很难发现。
func TestResolveResultBackupJSONKeys(t *testing.T) {
	payload, err := json.Marshal(ResolveResult{
		VideoURL:        "https://a.example/v.m4s",
		VideoBackupUrls: []string{"https://a.example/v.m4s", "https://b.example/v.m4s"},
		AudioBackupUrls: []string{"https://a.example/a.m4s"},
	})
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	text := string(payload)
	for _, want := range []string{
		`"videoBackupUrls":["https://a.example/v.m4s","https://b.example/v.m4s"]`,
		`"audioBackupUrls":["https://a.example/a.m4s"]`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("缺少字段 %s，实际 %s", want, text)
		}
	}

	// 空候选不应出现空数组（omitempty），否则前端会多走一次无意义的登记。
	empty, err := json.Marshal(ResolveResult{VideoURL: "https://a.example/v.m4s"})
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if strings.Contains(string(empty), "BackupUrls") {
		t.Fatalf("空候选不该出现在 JSON 里: %s", string(empty))
	}
}
