package nms

import (
	"context"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

func TestGenerateStreamKey(t *testing.T) {
	seen := make(map[string]struct{}, 32)
	for i := 0; i < 32; i++ {
		key := GenerateStreamKey()
		if len(key) != 8 {
			t.Fatalf("长度 = %d, want 8（key=%q）", len(key), key)
		}
		for _, c := range key {
			if !strings.ContainsRune(streamKeyAlphabet, c) {
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

func TestRtmpServerURL(t *testing.T) {
	cases := []struct {
		name       string
		cfg        Config
		hostHeader string
		want       string
	}{
		{
			name:       "Host 头去端口",
			cfg:        Config{RtmpPort: 3334},
			hostHeader: "zviewer.example.com:3333",
			want:       "rtmp://zviewer.example.com:3334/live",
		},
		{
			name: "SERVER_HOST 优先于 Host 头",
			cfg:  Config{RtmpPort: 1935, ServerHost: "push.example.com"},
			// 请求来自局域网地址也不影响：显式配置永远最高优先
			hostHeader: "192.168.1.10:3333",
			want:       "rtmp://push.example.com:1935/live",
		},
		{
			name:       "没有 Host 头回落 localhost",
			cfg:        Config{RtmpPort: 3334},
			hostHeader: "",
			want:       "rtmp://localhost:3334/live",
		},
		{
			name:       "IPv6 字面量保留方括号",
			cfg:        Config{RtmpPort: 3334},
			hostHeader: "[::1]:3333",
			want:       "rtmp://[::1]:3334/live",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Normalize(c.cfg).RtmpServerURL(c.hostHeader); got != c.want {
				t.Errorf("RtmpServerURL(%q) = %q, want %q", c.hostHeader, got, c.want)
			}
		})
	}
}

func TestLiveUpstreamKeepsOriginalURI(t *testing.T) {
	cfg := Normalize(Config{HTTPFLVBase: "http://127.0.0.1:3335/"})
	got := cfg.LiveUpstream("/live/ABCD1234.flv?token=1")
	want := "http://127.0.0.1:3335/live/ABCD1234.flv?token=1"
	if got != want {
		t.Errorf("LiveUpstream = %q, want %q", got, want)
	}
}

func TestAvailableCachesResultAndInvalidateReProbes(t *testing.T) {
	// 起一个只监听不回话的 TCP 服务：探测只需连得上。
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	base := "http://" + ln.Addr().String()

	calls := 0
	svc := New(Config{HTTPFLVBase: base, RtmpPort: 3334})
	svc.now = func() time.Time { return time.Unix(1700000000, 0) }
	svc.probe = func(context.Context) error {
		calls++
		return nil
	}

	for i := 0; i < 5; i++ {
		if !svc.Available() {
			t.Fatalf("第 %d 次探测应可用", i+1)
		}
	}
	if calls != 1 {
		t.Errorf("5 次调用应只探测 1 次（TTL 内走缓存），实际 %d 次", calls)
	}

	// 时间前进超过 TTL：重新探测
	svc.now = func() time.Time { return time.Unix(1700000000+int64(availabilityTTL/time.Second)+1, 0) }
	svc.probe = func(context.Context) error {
		calls++
		return errors.New("connection refused")
	}
	if svc.Available() {
		t.Fatal("探测失败时应报告不可用")
	}
	if calls != 2 {
		t.Errorf("超过 TTL 应重新探测，实际 %d 次", calls)
	}

	// 缓存期内即便探测实现变了也沿用旧值
	svc.probe = func(context.Context) error {
		calls++
		return nil
	}
	if svc.Available() {
		t.Fatal("TTL 内应沿用上一轮的 false")
	}
	if calls != 2 {
		t.Errorf("TTL 内不应再探测，实际 %d 次", calls)
	}

	svc.Invalidate()
	if !svc.Available() {
		t.Fatal("Invalidate 后应重新探测并可用")
	}
	if calls != 3 {
		t.Errorf("Invalidate 后应探测一次，实际 %d 次", calls)
	}
}

func TestAvailableReportsFalseWhenPortClosed(t *testing.T) {
	// 先占用再释放，保证这个端口确实没人听
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("监听失败: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	svc := New(Config{HTTPFLVBase: "http://" + addr})
	if svc.Available() {
		t.Errorf("%s 已关闭，应报告不可用", addr)
	}
}

func TestDisabledSkipsProbe(t *testing.T) {
	// STREAM_PUSH_ENABLED=0 与 Node 同名开关：显式关闭时不探测、恒不可用。
	t.Setenv("STREAM_PUSH_ENABLED", "0")
	calls := 0
	svc := New(Config{HTTPFLVBase: "http://127.0.0.1:1", Disabled: true})
	svc.probe = func(context.Context) error {
		calls++
		return nil
	}
	if svc.Available() {
		t.Error("Disabled 时应报告不可用")
	}
	if calls != 0 {
		t.Errorf("Disabled 时不应探测，实际 %d 次", calls)
	}
}

func TestConfigFromEnvPorts(t *testing.T) {
	t.Setenv("NMS_HTTP_FLV_URL", "")
	t.Setenv("HTTP_FLV_PORT", "3456")
	t.Setenv("RTMP_PORT", "1935")
	t.Setenv("SERVER_HOST", "push.local")

	cfg := ConfigFromEnv()
	if cfg.HTTPFLVBase != "http://127.0.0.1:3456" {
		t.Errorf("HTTPFLVBase = %q", cfg.HTTPFLVBase)
	}
	if cfg.RtmpPort != 1935 {
		t.Errorf("RtmpPort = %d", cfg.RtmpPort)
	}
	if cfg.ServerHost != "push.local" {
		t.Errorf("ServerHost = %q", cfg.ServerHost)
	}

	// 显式 URL 优先于端口推导
	t.Setenv("NMS_HTTP_FLV_URL", "https://nms.example.com/flv/")
	if got := ConfigFromEnv().HTTPFLVBase; got != "https://nms.example.com/flv" {
		t.Errorf("显式 NMS_HTTP_FLV_URL 未生效: %q", got)
	}

	// 非法端口回落默认值（Node 是 parseInt 出 NaN 拼进 URL，这里选择修正）
	t.Setenv("NMS_HTTP_FLV_URL", "")
	t.Setenv("HTTP_FLV_PORT", "abc")
	t.Setenv("RTMP_PORT", "70000")
	cfg = ConfigFromEnv()
	if cfg.HTTPFLVBase != "http://127.0.0.1:3335" {
		t.Errorf("非法 HTTP_FLV_PORT 应回落 3335，得到 %q", cfg.HTTPFLVBase)
	}
	if cfg.RtmpPort != 3334 {
		t.Errorf("非法 RTMP_PORT 应回落 3334，得到 %d", cfg.RtmpPort)
	}
}
