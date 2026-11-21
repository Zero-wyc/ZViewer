package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 桌面评论窗的准入判定与地址拼装是纯逻辑，出错时只会在真机上表现为
// 「按钮点了没反应」，这里把两个分支（能力矩阵 / 回环地址）都钉住。

func TestDesktopCommentsWindowURL(t *testing.T) {
	// 造一个真实存在的「壳程序」占位文件，只为满足 os.Stat 检查
	fakeExe := filepath.Join(t.TempDir(), "ZViewer.exe")
	if err := os.WriteFile(fakeExe, []byte("stub"), 0o644); err != nil {
		t.Fatalf("准备占位程序失败: %v", err)
	}

	cases := []struct {
		name     string
		env      map[string]string
		wantBase string
	}{
		{
			name:     "HTTPS 模式走单独的回环 HTTP 端口",
			env:      map[string]string{"LOOPBACK_HTTP_PORT": "31000", "PORT": "3443", "HTTPS": "true"},
			wantBase: "http://127.0.0.1:31000/room/",
		},
		{
			name:     "HTTP 模式复用网页端口",
			env:      map[string]string{"LOOPBACK_HTTP_PORT": "", "PORT": "3999", "HTTPS": "false"},
			wantBase: "http://127.0.0.1:3999/room/",
		},
		{
			name:     "HTTPS 模式且没有回环端口时拒绝",
			env:      map[string]string{"LOOPBACK_HTTP_PORT": "", "PORT": "3443", "HTTPS": "true"},
			wantBase: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			server := &Server{}
			got := server.desktopCommentsWindowURL("75tdPVyL", "access-1", "refresh-1")
			if tc.wantBase == "" {
				if got != "" {
					t.Fatalf("期望空地址，实际 %q", got)
				}
				return
			}
			if !strings.HasPrefix(got, tc.wantBase+"75tdPVyL/comments-window?") {
				t.Fatalf("地址前缀不对: %q", got)
			}
			for _, want := range []string{"desktopWindow=1", "desktopToken=access-1", "desktopRefresh=refresh-1"} {
				if !strings.Contains(got, want) {
					t.Fatalf("地址缺少 %s: %q", want, got)
				}
			}
		})
	}
}

func TestResolveDesktopCapabilities(t *testing.T) {
	fakeExe := filepath.Join(t.TempDir(), "ZViewer.exe")
	if err := os.WriteFile(fakeExe, []byte("stub"), 0o644); err != nil {
		t.Fatalf("准备占位程序失败: %v", err)
	}

	local := httptest.NewRequest("GET", "/api/desktop/capabilities", nil)
	local.RemoteAddr = "127.0.0.1:54321"
	remote := httptest.NewRequest("GET", "/api/desktop/capabilities", nil)
	remote.RemoteAddr = "203.0.113.9:54321"

	cases := []struct {
		name        string
		env         map[string]string
		req         *http.Request
		wantAvail   bool
		wantSame    bool
		wantReason  string
		reasonEmpty bool
	}{
		{
			name: "条件齐全时可开窗",
			env: map[string]string{
				"ZVIEWER_DESKTOP": "1", "ZVIEWER_DESKTOP_EXE": fakeExe,
				"LOOPBACK_HTTP_PORT": "31000", "HTTPS": "true",
			},
			req:       local,
			wantAvail: true,
			wantSame:  true,
		},
		{
			name: "非桌面托管",
			env: map[string]string{
				"ZVIEWER_DESKTOP": "", "ZVIEWER_DESKTOP_EXE": fakeExe,
				"LOOPBACK_HTTP_PORT": "31000",
			},
			req:        local,
			wantSame:   true,
			wantReason: "不是桌面客户端",
		},
		{
			name: "找不到壳程序",
			env: map[string]string{
				"ZVIEWER_DESKTOP": "1", "ZVIEWER_DESKTOP_EXE": filepath.Join(t.TempDir(), "missing.exe"),
				"LOOPBACK_HTTP_PORT": "31000",
			},
			req:        local,
			wantSame:   true,
			wantReason: "未找到桌面客户端程序",
		},
		{
			name: "没有回环地址",
			env: map[string]string{
				"ZVIEWER_DESKTOP": "1", "ZVIEWER_DESKTOP_EXE": fakeExe,
				"LOOPBACK_HTTP_PORT": "", "HTTPS": "true", "PORT": "3443",
			},
			req:        local,
			wantSame:   true,
			wantReason: "回环地址",
		},
		{
			name: "跨机访问",
			env: map[string]string{
				"ZVIEWER_DESKTOP": "1", "ZVIEWER_DESKTOP_EXE": fakeExe,
				"LOOPBACK_HTTP_PORT": "31000",
			},
			req:        remote,
			wantSame:   false,
			wantReason: "同一台设备",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 先清空相关项，避免宿主机环境影响判定
			for _, k := range []string{"ZVIEWER_DESKTOP", "ZVIEWER_DESKTOP_EXE", "LOOPBACK_HTTP_PORT", "HTTPS", "PORT"} {
				t.Setenv(k, "")
			}
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			caps := resolveDesktopCapabilities(tc.req)
			if caps.Available != tc.wantAvail {
				t.Fatalf("available=%v，期望 %v（reason=%q）", caps.Available, tc.wantAvail, caps.Reason)
			}
			if caps.SameMachine != tc.wantSame {
				t.Fatalf("sameMachine=%v，期望 %v", caps.SameMachine, tc.wantSame)
			}
			if tc.wantReason != "" && !strings.Contains(caps.Reason, tc.wantReason) {
				t.Fatalf("reason=%q，期望包含 %q", caps.Reason, tc.wantReason)
			}
			if tc.wantAvail && caps.Reason != "" {
				t.Fatalf("可用时不该带 reason: %q", caps.Reason)
			}
		})
	}
}

func TestRequestFromLocalMachine(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:1234":   true,
		"[::1]:1234":       true,
		"203.0.113.9:1234": false,
	}
	for addr, want := range cases {
		req := httptest.NewRequest("GET", "/", nil)
		req.RemoteAddr = addr
		if got := requestFromLocalMachine(req); got != want {
			t.Fatalf("%s: got %v, want %v", addr, got, want)
		}
	}
}
