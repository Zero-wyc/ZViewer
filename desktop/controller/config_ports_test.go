package controller

import "testing"

// 媒体 TCP 端口独立于网页端口：语音的媒体面跑在后端进程里，
// UDP 跟着网页端口（同号不同协议），TCP 必须另开一个——3333/tcp 已经是网页。
func TestValidateMediaTCPPort(t *testing.T) {
	base := map[string]any{
		"port":           "3333",
		"rtmpPort":       "3334",
		"flvPort":        "3335",
		"livekitTcpPort": "3337",
		"bindHost":       "::",
		"https":          false,
		"updateProxyUrl": "",
	}
	cfg, err := Validate(base)
	if err != nil {
		t.Fatalf("Validate 失败: %v", err)
	}
	if cfg.Port != 3333 || cfg.MediaTCPPort != 3337 {
		t.Fatalf("端口被误改: port=%d mediaTcp=%d", cfg.Port, cfg.MediaTCPPort)
	}

	// 媒体 TCP 撞上网页端口必须拒绝：同号会让媒体 TCP 绑不上，
	// 静默退化成只有 UDP，用户只会在弱网时才察觉。
	base["livekitTcpPort"] = "3333"
	if _, err := Validate(base); err == nil {
		t.Fatal("媒体 TCP 与网页端口重复时应报端口冲突")
	}
}
