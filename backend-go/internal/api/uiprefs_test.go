package api

import (
	"os"
	"path/filepath"
	"testing"
)

// ui-prefs.json 是「不写库」的那几个界面开关的落脚点。这里的重点是两条：
//  1. 写回时**三个字段都要写**——漏一个，用户在设置页保存另一个开关时就会
//     把它悄悄重置回默认（这正是加字段时最容易犯的错）；
//  2. 老文件里没有新键时按默认（开）处理，升级不该让已有部署忽然少个入口。
func TestUIPrefsRoundTrip(t *testing.T) {
	dir := t.TempDir()

	defaults := readUIPrefs(dir)
	if !defaults.ShowVoiceChatButton || !defaults.ShowTrafficPanel || !defaults.Live2DEnabled {
		t.Fatalf("文件缺失时应全部默认开启: %+v", defaults)
	}

	// 只关角色，另外两个必须原样保留
	prefs := readUIPrefs(dir)
	prefs.Live2DEnabled = false
	if err := writeUIPrefs(dir, prefs); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	got := readUIPrefs(dir)
	if got.Live2DEnabled {
		t.Fatal("关闭状态没写进去")
	}
	if !got.ShowVoiceChatButton || !got.ShowTrafficPanel {
		t.Fatalf("往返后其它开关被改动: %+v", got)
	}

	// 老版本留下的文件（没有 live2dEnabled 键）
	legacy := `{"showVoiceChatButton": false}`
	if err := os.WriteFile(filepath.Join(dir, uiPrefsFileName), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	parsed := readUIPrefs(dir)
	if parsed.ShowVoiceChatButton {
		t.Fatal("文件里显式的 false 被丢了")
	}
	if !parsed.Live2DEnabled || !parsed.ShowTrafficPanel {
		t.Fatalf("缺失键应按默认开启: %+v", parsed)
	}
}
